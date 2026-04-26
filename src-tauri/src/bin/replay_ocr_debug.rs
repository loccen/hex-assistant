use chrono::Utc;
use image::{imageops, DynamicImage, GenericImageView, ImageBuffer, Rgba};
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalibrationProfile {
    name_regions: Vec<SlottedRatioRegion>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SlottedRatioRegion {
    slot: u8,
    x_ratio: f64,
    y_ratio: f64,
    width_ratio: f64,
    height_ratio: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplayOutput {
    output_dir: String,
    profile_path: String,
    screenshot_path: String,
    slots: Vec<SlotOutput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SlotOutput {
    slot: u8,
    crops: Vec<CropOutput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CropOutput {
    kind: String,
    source_rect: PixelRect,
    output_size: PixelSize,
    path: String,
}

#[derive(Debug, Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct PixelRect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Debug, Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct PixelSize {
    width: u32,
    height: u32,
}

fn main() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        return Err(
            "用法: replay_ocr_debug <profile.json> <screenshot.png> [output-dir]".to_string(),
        );
    }

    let profile_path = PathBuf::from(&args[1]);
    let screenshot_path = PathBuf::from(&args[2]);
    let output_dir = args.get(3).map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from("ocr-debug-replay").join(Utc::now().format("%Y%m%d-%H%M%S").to_string())
    });

    let profile: CalibrationProfile = serde_json::from_str(
        &fs::read_to_string(&profile_path)
            .map_err(|err| format!("读取 profile.json 失败: {}", err))?,
    )
    .map_err(|err| format!("解析 profile.json 失败: {}", err))?;
    let image =
        image::open(&screenshot_path).map_err(|err| format!("读取截图 PNG 失败: {}", err))?;
    fs::create_dir_all(&output_dir).map_err(|err| format!("创建输出目录失败: {}", err))?;

    let mut slots = Vec::new();
    let mut regions = profile.name_regions;
    regions.sort_by_key(|region| region.slot);

    for region in regions {
        if !(1..=3).contains(&region.slot) {
            continue;
        }
        let raw = crop_to_image(&image, &region, 0.0, 1.0, 1);
        let focused = crop_to_image(&image, &region, 0.04, 0.62, 1);
        let enhanced = enhance_ocr_image(&focused.image, 4);

        let crops = vec![
            save_crop(&output_dir, region.slot, "raw", raw)?,
            save_crop(&output_dir, region.slot, "focused", focused)?,
            save_crop(
                &output_dir,
                region.slot,
                "enhanced",
                CropImage {
                    rect: crop_rect(&image, &region, 0.04, 0.62),
                    image: enhanced,
                },
            )?,
        ];
        slots.push(SlotOutput {
            slot: region.slot,
            crops,
        });
    }

    let output = ReplayOutput {
        output_dir: output_dir.display().to_string(),
        profile_path: profile_path.display().to_string(),
        screenshot_path: screenshot_path.display().to_string(),
        slots,
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&output).map_err(|err| err.to_string())?
    );
    Ok(())
}

struct CropImage {
    rect: PixelRect,
    image: DynamicImage,
}

fn crop_to_image(
    image: &DynamicImage,
    region: &SlottedRatioRegion,
    y_offset_ratio: f64,
    height_ratio: f64,
    scale: u32,
) -> CropImage {
    let rect = crop_rect(image, region, y_offset_ratio, height_ratio);
    let cropped = image.crop_imm(rect.x, rect.y, rect.width, rect.height);
    let image = if scale > 1 {
        cropped.resize_exact(
            rect.width * scale,
            rect.height * scale,
            imageops::FilterType::Nearest,
        )
    } else {
        cropped
    };
    CropImage { rect, image }
}

fn crop_rect(
    image: &DynamicImage,
    region: &SlottedRatioRegion,
    y_offset_ratio: f64,
    height_ratio: f64,
) -> PixelRect {
    let (image_width, image_height) = image.dimensions();
    let full_height = ((region.height_ratio * f64::from(image_height)).round() as u32).max(1);
    let x = ((region.x_ratio * f64::from(image_width)).round() as u32)
        .min(image_width.saturating_sub(1));
    let y = ((region.y_ratio * f64::from(image_height) + f64::from(full_height) * y_offset_ratio)
        .round() as u32)
        .min(image_height.saturating_sub(1));
    let width = ((region.width_ratio * f64::from(image_width)).round() as u32)
        .max(1)
        .min(image_width - x);
    let height = ((f64::from(full_height) * height_ratio).round() as u32)
        .max(1)
        .min(image_height - y);
    PixelRect {
        x,
        y,
        width,
        height,
    }
}

fn enhance_ocr_image(source: &DynamicImage, scale: u32) -> DynamicImage {
    let resized = source.resize_exact(
        source.width() * scale,
        source.height() * scale,
        imageops::FilterType::Nearest,
    );
    let mut output: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::new(resized.width(), resized.height());
    for (x, y, pixel) in resized.to_rgba8().enumerate_pixels() {
        let channels = pixel.0;
        let luma =
            channels[0] as f64 * 0.299 + channels[1] as f64 * 0.587 + channels[2] as f64 * 0.114;
        let contrasted = ((luma - 96.0) * 1.85 + 128.0).clamp(0.0, 255.0);
        let value = if contrasted >= 150.0 { 255 } else { 0 };
        output.put_pixel(x, y, Rgba([value, value, value, channels[3]]));
    }
    DynamicImage::ImageRgba8(output)
}

fn save_crop(
    output_dir: &Path,
    slot: u8,
    kind: &str,
    crop: CropImage,
) -> Result<CropOutput, String> {
    let path = output_dir.join(format!("slot-{}-{}.png", slot, kind));
    crop.image
        .save(&path)
        .map_err(|err| format!("保存 {} 失败: {}", path.display(), err))?;
    Ok(CropOutput {
        kind: kind.to_string(),
        source_rect: crop.rect,
        output_size: PixelSize {
            width: crop.image.width(),
            height: crop.image.height(),
        },
        path: path.display().to_string(),
    })
}
