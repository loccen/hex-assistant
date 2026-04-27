//! PP-OCRv4 识别引擎（仅 rec 模型，跳过 det/cls）。
//!
//! 输入：已校准裁剪图（tight-line 或 focused 裁剪）
//! 输出：识别文本 + 平均置信度
//!
//! 调用方法：
//!   let engine = OcrEngine::new(model_path)?;
//!   let result = engine.recognize_path(image_path)?;
//!
//! 环境要求：
//!   ORT_DYLIB_PATH 指向 libonnxruntime.so（开发环境）
//!   或使用 Tauri bundled 的 ORT dll（生产环境）

use anyhow::{Context, Result};
use image::{imageops, DynamicImage};
use ndarray::{Array4, Axis};
use ort::{
    session::{builder::GraphOptimizationLevel, Session},
    value::Tensor,
};
use std::path::Path;
use std::time::Instant;

const REC_IMG_HEIGHT: u32 = 48;

pub struct OcrResult {
    pub text: String,
    pub confidence: f32,
    pub duration_ms: f64,
}

pub struct OcrEngine {
    session: Session,
    char_list: Vec<String>,
    out_name: String,
}

impl OcrEngine {
    pub fn new(model_path: &Path) -> Result<Self> {
        let session = Session::builder()
            .context("创建 ORT session builder 失败")?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .context("设置优化级别失败")?
            .commit_from_file(model_path)
            .with_context(|| format!("加载 ONNX 模型失败: {}", model_path.display()))?;

        let char_list = load_char_list_from_model(&session)
            .context("从模型 metadata 加载字符表失败")?;
        let out_name = session
            .outputs
            .first()
            .map(|o| o.name.clone())
            .context("模型无输出节点")?;

        Ok(OcrEngine { session, char_list, out_name })
    }

    pub fn recognize_path(&mut self, image_path: &Path) -> Result<OcrResult> {
        let img = image::open(image_path)
            .with_context(|| format!("读取图片失败: {}", image_path.display()))?;
        self.recognize(&img)
    }

    pub fn recognize(&mut self, img: &DynamicImage) -> Result<OcrResult> {
        let t0 = Instant::now();
        let input_array = preprocess(img).context("图片预处理失败")?;
        let shape: Vec<usize> = input_array.shape().to_vec();
        let data = input_array.into_raw_vec_and_offset().0;
        let ort_tensor = Tensor::<f32>::from_array((shape, data))
            .context("创建 ORT 输入张量失败")?;
        let outputs = self
            .session
            .run(ort::inputs! { "x" => ort_tensor })
            .context("ONNX 推理失败")?;
        let out_val = outputs
            .get(self.out_name.as_str())
            .with_context(|| format!("找不到输出节点: {}", self.out_name))?;
        let array = out_val
            .try_extract_array::<f32>()
            .context("提取输出张量失败")?;
        let result = ctc_decode(array.view(), &self.char_list).context("CTC 解码失败")?;
        let duration_ms = t0.elapsed().as_secs_f64() * 1000.0;
        Ok(OcrResult {
            text: result.0,
            confidence: result.1,
            duration_ms,
        })
    }
}

/// 从模型 metadata 的 'character' 字段读取字符表。
/// 格式：\n 分隔，不含 blank 和 space。
/// 返回：['blank', char1, ..., charN, ' ']，共 N+2 项。
/// 与 Python CTCLabelDecode 保持一致：index 0 = blank，index N+1 = ' '。
fn load_char_list_from_model(session: &Session) -> Result<Vec<String>> {
    let metadata = session.metadata().context("读取模型 metadata 失败")?;
    let raw = metadata
        .custom("character")
        .context("读取 character metadata 失败")?
        .context("模型中未找到 'character' metadata")?;

    let mut list = vec!["blank".to_string()];
    for line in raw.lines() {
        if !line.is_empty() {
            list.push(line.to_string());
        }
    }
    list.push(" ".to_string());
    Ok(list)
}

/// 将图片缩放至 h=48，宽度等比，归一化至 [-1, 1]，返回 [1, 3, 48, W] 张量。
fn preprocess(img: &DynamicImage) -> Result<Array4<f32>> {
    let h = REC_IMG_HEIGHT;
    let orig_h = img.height().max(1);
    let new_w = ((img.width() as f64 * h as f64 / orig_h as f64) as u32).max(h);
    let resized = img.resize_exact(new_w, h, imageops::FilterType::Triangle);
    let rgb = resized.to_rgb8();
    let (w, h_usize) = (new_w as usize, h as usize);
    let mut tensor = Array4::<f32>::zeros((1, 3, h_usize, w));
    for y in 0..h_usize {
        for x in 0..w {
            let px = rgb.get_pixel(x as u32, y as u32);
            tensor[[0, 0, y, x]] = (px[0] as f32 / 255.0 - 0.5) / 0.5;
            tensor[[0, 1, y, x]] = (px[1] as f32 / 255.0 - 0.5) / 0.5;
            tensor[[0, 2, y, x]] = (px[2] as f32 / 255.0 - 0.5) / 0.5;
        }
    }
    Ok(tensor)
}

/// CTC 贪心解码。blank = index 0，跳过连续重复。
/// 返回 (text, avg_confidence)。
fn ctc_decode(
    output: ndarray::ArrayViewD<f32>,
    char_list: &[String],
) -> Result<(String, f32)> {
    // output shape: [1, T, num_classes]
    anyhow::ensure!(output.ndim() == 3, "期望输出 3 维，实际 {}", output.ndim());
    let t = output.shape()[1];
    let mut text = String::new();
    let mut confs: Vec<f32> = Vec::new();
    let mut prev = usize::MAX;

    for i in 0..t {
        let step = output.index_axis(Axis(1), i); // [1, num_classes]
        let row = step.index_axis(Axis(0), 0);    // [num_classes]
        let (idx, &score) = row
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
            .unwrap_or((0, &0.0_f32));

        if idx != 0 && idx != prev {
            if let Some(ch) = char_list.get(idx) {
                if ch != "blank" {
                    text.push_str(ch);
                    confs.push(score);
                }
            }
        }
        prev = idx;
    }

    let confidence = if confs.is_empty() {
        0.0
    } else {
        confs.iter().sum::<f32>() / confs.len() as f32
    };
    Ok((text, confidence))
}
