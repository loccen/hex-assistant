//! PP-OCRv4 rec 离线回归评估二进制。
//!
//! 用法:
//!   cargo run --bin ocr_eval -- [model_path] [input_dir] [labels_json] [output_dir]
//!
//! 环境变量:
//!   ORT_DYLIB_PATH  指向 libonnxruntime.so / onnxruntime.dll
//!
//! 注意：此二进制对校准裁剪图（tight-line）执行 OCR，
//!       不使用 det 模型，不使用特化错字表。

use anyhow::{Context, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

// 把 ocr_engine 引入：eval binary 需要用 lib 里的模块
use screen_capture_diagnostic_lib::ocr_engine::OcrEngine;

// 2560×1440 基准三槽 rect [x0,y0,x1,y1]，仅标题文字行（tight-line），等比缩放
// y=[559,594] 对应标题增强名称的实际文字行，跳过 det 模型
const SLOT_RECTS: [(u32, u32, u32, u32); 3] = [
    (560, 559, 1015, 594),
    (1035, 559, 1495, 594),
    (1510, 559, 1970, 594),
];

// --- 数据结构 ---

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SlotResult {
    slot: usize,
    expected: String,
    predicted: String,
    correct: bool,
    confidence: f32,
    duration_ms: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageResult {
    image: String,
    expected: Vec<String>,
    predicted: Vec<String>,
    slot_correct: usize,
    total_slots: usize,
    accuracy: f64,
    duration_ms: f64,
    slots: Vec<SlotResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    engine: String,
    created_at: String,
    sample_count: usize,
    slot_count: usize,
    exact_slot_correct: usize,
    overall_accuracy: f64,
    duration_ms: f64,
    passed: bool,
    per_image: Vec<ImageResult>,
}

// --- 主逻辑 ---

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let model_path = args.get(1).map(PathBuf::from).unwrap_or_else(default_model_path);
    let input_dir = args.get(2).map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("artifacts/ocr-race/input"));
    let labels_path = args.get(3).map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("artifacts/ocr-race/labels/labels.json"));
    let output_dir = args.get(4).map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("artifacts/ocr-race/results/rapidocr-rust-regression"));

    eprintln!("模型: {}", model_path.display());
    eprintln!("输入: {}", input_dir.display());
    eprintln!("标注: {}", labels_path.display());
    eprintln!("输出: {}", output_dir.display());

    let labels_text = std::fs::read_to_string(&labels_path)
        .with_context(|| format!("读取 labels 失败: {}", labels_path.display()))?;
    let labels: HashMap<String, Vec<String>> = serde_json::from_str(&labels_text)
        .context("解析 labels.json 失败")?;

    let mut engine = OcrEngine::new(&model_path)
        .with_context(|| format!("初始化 OCR 引擎失败，模型: {}", model_path.display()))?;
    eprintln!("引擎初始化完成");

    std::fs::create_dir_all(&output_dir).context("创建输出目录失败")?;

    let t_total = Instant::now();
    let mut per_image: Vec<ImageResult> = Vec::new();
    let mut total_correct = 0usize;
    let mut total_slots = 0usize;

    // 排序保证输出顺序确定
    let mut image_names: Vec<&String> = labels.keys().collect();
    image_names.sort();

    for image_name in image_names {
        let expected = &labels[image_name];
        let image_path = input_dir.join(image_name);
        if !image_path.exists() {
            eprintln!("  跳过: {} 不存在", image_path.display());
            continue;
        }

        eprint!("  {} ... ", image_name);
        let img = image::open(&image_path)
            .with_context(|| format!("读取图片失败: {}", image_path.display()))?;

        let img_w = img.width();
        let img_h = img.height();
        let scale_x = img_w as f64 / 2560.0;
        let scale_y = img_h as f64 / 1440.0;

        let mut slot_results: Vec<SlotResult> = Vec::new();
        let t_img = Instant::now();

        for (i, &(x0, y0, x1, y1)) in SLOT_RECTS.iter().enumerate() {
            let cx0 = ((x0 as f64 * scale_x) as u32).min(img_w);
            let cy0 = ((y0 as f64 * scale_y) as u32).min(img_h);
            let cx1 = ((x1 as f64 * scale_x) as u32).min(img_w);
            let cy1 = ((y1 as f64 * scale_y) as u32).min(img_h);
            let crop = img.crop_imm(cx0, cy0, cx1 - cx0, cy1 - cy0);
            let rec = engine.recognize(&crop)?;
            let exp = expected.get(i).map(String::as_str).unwrap_or("");
            let correct = rec.text == exp;
            slot_results.push(SlotResult {
                slot: i + 1,
                expected: exp.to_string(),
                predicted: rec.text,
                correct,
                confidence: rec.confidence,
                duration_ms: rec.duration_ms,
            });
        }

        let img_ms = t_img.elapsed().as_secs_f64() * 1000.0;
        let slot_correct = slot_results.iter().filter(|s| s.correct).count();
        let n = expected.len();
        total_correct += slot_correct;
        total_slots += n;

        let ok_label = if slot_correct == n {
            format!("✓ {}/{}", slot_correct, n)
        } else {
            format!("✗ {}/{} predicted: {}",
                slot_correct, n,
                slot_results.iter().map(|s| s.predicted.as_str()).collect::<Vec<_>>().join(" / "))
        };
        eprintln!("{}", ok_label);

        per_image.push(ImageResult {
            image: image_name.clone(),
            expected: expected.clone(),
            predicted: slot_results.iter().map(|s| s.predicted.clone()).collect(),
            slot_correct,
            total_slots: n,
            accuracy: slot_correct as f64 / n as f64,
            duration_ms: img_ms,
            slots: slot_results,
        });
    }

    let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
    let overall_accuracy = if total_slots > 0 {
        total_correct as f64 / total_slots as f64
    } else {
        0.0
    };

    let summary = Summary {
        engine: "PP-OCRv4-rec / Rust ort".to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        sample_count: per_image.len(),
        slot_count: total_slots,
        exact_slot_correct: total_correct,
        overall_accuracy,
        duration_ms: total_ms,
        passed: total_correct == total_slots,
        per_image,
    };

    let summary_path = output_dir.join("summary.json");
    std::fs::write(&summary_path, serde_json::to_string_pretty(&summary)?)
        .context("写入 summary.json 失败")?;

    let report = build_report(&summary, &input_dir, &labels_path, &output_dir);
    let report_path = output_dir.join("report.md");
    std::fs::write(&report_path, report).context("写入 report.md 失败")?;

    eprintln!("\n结果: {}/{} ({:.2}%)", total_correct, total_slots, overall_accuracy * 100.0);
    eprintln!("summary: {}", summary_path.display());
    eprintln!("report:  {}", report_path.display());

    if total_correct != total_slots {
        std::process::exit(1);
    }
    Ok(())
}

fn default_model_path() -> PathBuf {
    // 优先使用 pip 安装的 rapidocr 里的模型（开发环境）
    let pip_path: PathBuf = dirs_next::home_dir()
        .unwrap_or_else(|| PathBuf::from("/root"))
        .join(".local/share/mise/installs/python/3.11.15/lib/python3.11/site-packages/rapidocr_onnxruntime/models/ch_PP-OCRv4_rec_infer.onnx");
    if pip_path.exists() {
        return pip_path;
    }
    PathBuf::from("src-tauri/models/ch_PP-OCRv4_rec_infer.onnx")
}

fn build_report(summary: &Summary, input_dir: &Path, labels_path: &Path, output_dir: &Path) -> String {
    let rows: Vec<String> = summary.per_image.iter().map(|img| {
        let exp = img.expected.join(" / ");
        let pred = img.predicted.join(" / ");
        let ok = if img.slot_correct == img.total_slots {
            format!("{}/{}", img.slot_correct, img.total_slots)
        } else {
            format!("**{}/{}**", img.slot_correct, img.total_slots)
        };
        format!("| {} | {} | {} | {} |", img.image, exp, pred, ok)
    }).collect();

    format!(
        "# PP-OCRv4 rec / Rust ort 回归评估报告\n\n\
         - 引擎：PP-OCRv4-rec via Rust ort crate（跳过 det/cls）\n\
         - 输入：{}\n\
         - 基准：{}\n\
         - 输出：{}\n\
         - 总耗时：{:.0} ms\n\
         - Slot exact match：{}/{} = {:.2}%\n\
         - 结论：{}\n\n\
         ## 逐图结果\n\n\
         | 图片 | 期望 | 识别 | 正确 |\n\
         | --- | --- | --- | --- |\n\
         {}\n\n\
         ## 备注\n\n\
         - 使用固定布局的三槽标题区域裁剪，坐标按实际图片尺寸等比缩放。\n\
         - 未使用符文名错字表或样本特化纠错。\n\
         - 未使用 det 模型（校准裁剪已知文字位置）；未使用 cls 模型（文字方向固定水平）。\n\
         - 字符表从模型 metadata 读取，无需额外字典文件。\n",
        input_dir.display(),
        labels_path.display(),
        output_dir.display(),
        summary.duration_ms,
        summary.exact_slot_correct,
        summary.slot_count,
        summary.overall_accuracy * 100.0,
        &if summary.passed { "**通过**（15/15）".to_string() } else { format!("**未通过**（{}/{}）", summary.exact_slot_correct, summary.slot_count) },
        rows.join("\n"),
    )
}
