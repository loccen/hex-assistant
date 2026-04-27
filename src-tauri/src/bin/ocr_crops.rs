//! OCR 裁剪图识别二进制（stdin JSON 模式）。
//!
//! 用法（stdin 输入）:
//!   echo '{"crops":[{"slot":1,"path":"crop1.png"},{"slot":2,"path":"crop2.png"}]}' | \
//!     cargo run --bin ocr_crops
//!
//! 环境变量:
//!   ORT_DYLIB_PATH  指向 libonnxruntime.so / onnxruntime.dll
//!   OCR_MODEL_PATH  覆盖默认模型路径（可选）

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::PathBuf;
use std::time::Instant;

use screen_capture_diagnostic_lib::ocr_engine::OcrEngine;

#[derive(Debug, Deserialize)]
struct InputCrop {
    slot: usize,
    path: String,
}

#[derive(Debug, Deserialize)]
struct InputPayload {
    crops: Vec<InputCrop>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SlotResult {
    slot: usize,
    raw_text: String,
    confidence: f32,
    duration_ms: f64,
    status: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    engine: &'static str,
    duration_ms: f64,
    slots: Vec<SlotResult>,
    error: Option<String>,
}

fn main() {
    let result = run();
    match result {
        Ok(out) => {
            println!("{}", serde_json::to_string(&out).unwrap());
        }
        Err(e) => {
            let out = Output {
                engine: "PP-OCRv4/Rust ort",
                duration_ms: 0.0,
                slots: vec![],
                error: Some(format!("{:#}", e)),
            };
            println!("{}", serde_json::to_string(&out).unwrap());
            std::process::exit(1);
        }
    }
}

fn run() -> Result<Output> {
    let mut stdin_buf = String::new();
    std::io::stdin()
        .read_to_string(&mut stdin_buf)
        .context("读取 stdin 失败")?;
    let payload: InputPayload = serde_json::from_str(&stdin_buf).context("解析 stdin JSON 失败")?;

    let model_path = model_path();
    let mut engine = OcrEngine::new(&model_path)
        .with_context(|| format!("初始化 OCR 引擎失败，模型: {}", model_path.display()))?;

    let t0 = Instant::now();
    let mut slots: Vec<SlotResult> = Vec::new();

    for crop in &payload.crops {
        let path = PathBuf::from(&crop.path);
        let rec = engine.recognize_path(&path)
            .with_context(|| format!("识别失败: {}", path.display()))?;
        slots.push(SlotResult {
            slot: crop.slot,
            raw_text: rec.text,
            confidence: rec.confidence,
            duration_ms: rec.duration_ms,
            status: "ok",
        });
    }

    Ok(Output {
        engine: "PP-OCRv4/Rust ort",
        duration_ms: t0.elapsed().as_secs_f64() * 1000.0,
        slots,
        error: None,
    })
}

fn model_path() -> PathBuf {
    if let Ok(p) = std::env::var("OCR_MODEL_PATH") {
        return PathBuf::from(p);
    }
    let pip_path: PathBuf = dirs_next::home_dir()
        .unwrap_or_else(|| PathBuf::from("/root"))
        .join(".local/share/mise/installs/python/3.11.15/lib/python3.11/site-packages/rapidocr_onnxruntime/models/ch_PP-OCRv4_rec_infer.onnx");
    if pip_path.exists() {
        return pip_path;
    }
    PathBuf::from("src-tauri/models/ch_PP-OCRv4_rec_infer.onnx")
}
