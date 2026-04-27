#!/usr/bin/env node
/**
 * OCR 回归评估（委托至 Rust ocr_eval 二进制）
 *
 * 用法:
 *   mise exec -- node scripts/eval-rapidocr.mjs
 *
 * 自定义路径请直接调用:
 *   ORT_DYLIB_PATH=... cargo run --manifest-path src-tauri/Cargo.toml --bin ocr_eval \
 *     -- [model_path] [input_dir] [labels_json] [output_dir]
 *
 * 默认输出: artifacts/ocr-race/results/rapidocr-rust-regression/
 * 验收目标: 15/15 exact match，不使用特化纠错。
 */

import { spawn } from "node:child_process";
import process from "node:process";

await new Promise((resolve, reject) => {
  const child = spawn(
    "cargo",
    ["run", "--quiet", "--manifest-path", "src-tauri/Cargo.toml", "--bin", "ocr_eval"],
    { cwd: process.cwd(), stdio: "inherit", env: process.env },
  );
  child.on("error", reject);
  child.on("close", (code) => {
    code === 0 ? resolve() : reject(new Error(`ocr_eval 退出码 ${code}`));
  });
}).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
