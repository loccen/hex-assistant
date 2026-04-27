#!/usr/bin/env node
/**
 * RapidOCR / ONNXRuntime 离线回归评估
 *
 * 用法:
 *   mise exec -- node scripts/eval-rapidocr.mjs [input-dir] [labels-json] [output-dir]
 *
 * 默认:
 *   input-dir   = artifacts/ocr-race/input
 *   labels-json = artifacts/ocr-race/labels/labels.json
 *   output-dir  = artifacts/ocr-race/results/rapidocr-regression
 *
 * 验收目标: RapidOCR 路径 15/15 exact match，不使用特化纠错。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_INPUT_DIR = "artifacts/ocr-race/input";
const DEFAULT_LABELS = "artifacts/ocr-race/labels/labels.json";
const DEFAULT_OUTPUT = "artifacts/ocr-race/results/rapidocr-regression";

// 2560×1440 基准三槽 rect（等比缩放到实际图片尺寸由 sidecar 内部处理）
const SLOT_RECTS = [
  [560, 520, 1015, 640],
  [1035, 520, 1495, 640],
  [1510, 520, 1970, 640],
];

const [inputDir, labelsPath, outputDir] = [
  process.argv[2] ?? DEFAULT_INPUT_DIR,
  process.argv[3] ?? DEFAULT_LABELS,
  process.argv[4] ?? DEFAULT_OUTPUT,
];

if (!existsSync(inputDir)) {
  console.error(`输入目录不存在: ${inputDir}`);
  process.exit(1);
}
if (!existsSync(labelsPath)) {
  console.error(`labels.json 不存在: ${labelsPath}`);
  process.exit(1);
}

const labels = JSON.parse(readFileSync(labelsPath, "utf8"));
mkdirSync(outputDir, { recursive: true });

const sidecarPath = path.resolve(process.cwd(), "scripts/ocr_sidecar.py");
if (!existsSync(sidecarPath)) {
  console.error(`sidecar 不存在: ${sidecarPath}`);
  process.exit(1);
}

function runSidecar(imagePath) {
  return new Promise((resolve, reject) => {
    const rectsArg = JSON.stringify(SLOT_RECTS);
    const child = spawn(
      "mise",
      ["exec", "python", "--", "python", sidecarPath, "--image", imagePath, "--rects", rectsArg],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`sidecar 退出 ${code}: ${stderr.trim().slice(0, 200)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`解析 sidecar 输出失败: ${e.message}\n${stdout.slice(0, 200)}`));
      }
    });
  });
}

const perImage = [];
let totalCorrect = 0;
let totalSlots = 0;
const t0 = Date.now();

for (const [filename, expected] of Object.entries(labels)) {
  const imagePath = path.resolve(inputDir, filename);
  if (!existsSync(imagePath)) {
    console.warn(`  跳过: ${filename} 不存在`);
    continue;
  }
  process.stdout.write(`  ${filename} ... `);
  const result = await runSidecar(imagePath);
  const predicted = result.slots.map((s) => s.rawText ?? "");
  const slotDetails = expected.map((exp, i) => {
    const pred = predicted[i] ?? "";
    const correct = pred === exp;
    return {
      slot: i + 1,
      expected: exp,
      predicted: pred,
      correct,
      confidence: result.slots[i]?.confidence ?? 0,
      durationMs: result.slots[i]?.durationMs ?? 0,
    };
  });
  const slotCorrect = slotDetails.filter((s) => s.correct).length;
  totalCorrect += slotCorrect;
  totalSlots += expected.length;

  const status = slotCorrect === expected.length ? "✓" : `✗ ${slotCorrect}/${expected.length}`;
  console.log(status);

  perImage.push({
    image: filename,
    expected,
    predicted,
    slotCorrect,
    totalSlots: expected.length,
    accuracy: slotCorrect / expected.length,
    durationMs: result.durationMs,
    slots: slotDetails,
    engineVersion: result.version,
  });
}

const totalMs = Date.now() - t0;
const overallAccuracy = totalSlots > 0 ? totalCorrect / totalSlots : 0;

// summary.json
const summary = {
  engine: "RapidOCR+ONNXRuntime",
  createdAt: new Date().toISOString(),
  sampleCount: perImage.length,
  slotCount: totalSlots,
  exactSlotCorrect: totalCorrect,
  overallAccuracy,
  durationMs: totalMs,
  passed: totalCorrect === totalSlots,
  perImage,
};
const summaryPath = path.join(outputDir, "summary.json");
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

// report.md
const rows = perImage
  .map((img) => {
    const exp = img.expected.join(" / ");
    const pred = img.predicted.join(" / ");
    const ok = img.slotCorrect === img.totalSlots ? `${img.slotCorrect}/${img.totalSlots}` : `**${img.slotCorrect}/${img.totalSlots}**`;
    return `| ${img.image} | ${exp} | ${pred} | ${ok} |`;
  })
  .join("\n");

const report = `# RapidOCR 回归评估报告

- 引擎：RapidOCR + ONNXRuntime
- 输入：${inputDir}
- 基准：${labelsPath}
- 输出：${outputDir}
- 总耗时：${totalMs} ms
- Slot exact match：${totalCorrect}/${totalSlots} = ${(overallAccuracy * 100).toFixed(2)}%
- 结论：${totalCorrect === totalSlots ? "**通过**（15/15）" : `**未通过**（${totalCorrect}/${totalSlots}）`}

## 逐图结果

| 图片 | 期望 | 识别 | 正确 |
| --- | --- | --- | --- |
${rows}

## 备注

- 使用固定布局的三槽标题区域裁剪，坐标按实际图片尺寸等比缩放。
- 未使用符文名错字表或样本特化纠错。
- 未使用 Tesseract；Tesseract 只保留为 replay-ocr-debug.mjs 的调试基线。
`;
const reportPath = path.join(outputDir, "report.md");
writeFileSync(reportPath, report, "utf8");

console.log(`\n结果: ${totalCorrect}/${totalSlots} (${(overallAccuracy * 100).toFixed(2)}%)`);
console.log(`summary: ${summaryPath}`);
console.log(`report:  ${reportPath}`);

if (totalCorrect !== totalSlots) {
  process.exit(1);
}
