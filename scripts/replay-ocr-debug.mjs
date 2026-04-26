#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const OCR_CONFIDENCE_THRESHOLD = 65;
const OCR_MATCH_THRESHOLD = 0.72;
const HEX_NAME_LIBRARY = [
  "吞噬灵魂",
  "巨像勇气",
  "双刀流",
  "量子计算",
  "潘朵拉的装备",
  "珠光莲花",
  "升级咯",
  "纷乱头脑",
  "清晰头脑",
  "开摆",
  "利滚利",
  "明智消费",
  "源计划植入",
  "源计划上行链路",
  "药剂师",
  "治疗法球",
  "了解你的敌人",
  "小巨人",
  "大百宝袋",
  "后期专家",
  "便携锻炉",
  "诅咒冠冕",
  "黄金门票",
  "快速思考",
  "最万用的瞄准镜",
  "小猫咪找妈妈",
  "回归基本功",
];

const [profilePath, screenshotPath, outputDirArg] = process.argv.slice(2);

if (!profilePath || !screenshotPath) {
  console.error("用法: node scripts/replay-ocr-debug.mjs <profile.json> <screenshot.png> [output-dir]");
  process.exit(1);
}

if (!existsSync(profilePath)) {
  console.error(`profile.json 不存在: ${profilePath}`);
  process.exit(1);
}

if (!existsSync(screenshotPath)) {
  console.error(`截图 PNG 不存在: ${screenshotPath}`);
  process.exit(1);
}

const outputDir =
  outputDirArg ??
  path.join(process.cwd(), "ocr-debug-replay", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(outputDir, { recursive: true });

const replay = await runCropper(profilePath, screenshotPath, outputDir);
const ocrResults = await tryRecognizeReplay(replay);
const report = {
  ...replay,
  ocrResults,
};
const reportPath = path.join(outputDir, "replay-report.json");
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(JSON.stringify(report, null, 2));
console.log(`复盘报告: ${reportPath}`);

function runCropper(profile, screenshot, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "cargo",
      [
        "run",
        "--quiet",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--bin",
        "replay_ocr_debug",
        "--",
        profile,
        screenshot,
        output,
      ],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `replay_ocr_debug 退出码 ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`解析裁剪输出失败: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

async function tryRecognizeReplay(replay) {
  let worker;
  try {
    const { default: Tesseract } = await import("tesseract.js");
    worker = await Tesseract.createWorker("chi_sim", Tesseract.OEM.LSTM_ONLY, {
      cacheMethod: "none",
    });
    await worker.setParameters({
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
      preserve_interword_spaces: "1",
    });

    const results = [];
    for (const slot of replay.slots) {
      const candidates = [];
      for (const kind of ["tight-enhanced", "inverted", "enhanced", "tight-line", "focused", "raw"]) {
        const crop = slot.crops.find((item) => item.kind === kind);
        if (!crop) {
          continue;
        }
        const recognized = await worker.recognize(crop.path);
        candidates.push(buildCandidate(kind, recognized.data.text, recognized.data.confidence));
      }
      results.push({
        slot: slot.slot,
        candidates,
        best: selectBest(candidates),
      });
    }
    return {
      available: true,
      results,
    };
  } catch (error) {
    return {
      available: false,
      error: summarizeError(error),
      note: "已生成 raw/focused/tight-line/enhanced/tight-enhanced/inverted 调试图；当前环境未完成离线 OCR。",
    };
  } finally {
    if (worker) {
      await worker.terminate();
    }
  }
}

function buildCandidate(sourceKind, rawText, confidence) {
  const cleanRawText = rawText.replace(/\s+/g, " ").trim();
  const match = matchHexName(cleanRawText);
  const normalizedConfidence = Math.max(0, confidence || 0);
  const status =
    normalizedConfidence < OCR_CONFIDENCE_THRESHOLD || match.score < OCR_MATCH_THRESHOLD ? "suspect" : "recognized";
  return {
    sourceKind,
    rawText: cleanRawText,
    confidence: normalizedConfidence,
    matchedName: status === "recognized" ? match.name : "",
    matchScore: match.score,
    status,
    matchDebug: match.debug,
  };
}

function selectBest(candidates) {
  return candidates.slice().sort((left, right) => {
    const recognizedDelta = Number(right.status === "recognized") - Number(left.status === "recognized");
    if (recognizedDelta !== 0) {
      return recognizedDelta;
    }
    const leftScore = left.matchScore * 0.6 + (left.confidence / 100) * 0.4;
    const rightScore = right.matchScore * 0.6 + (right.confidence / 100) * 0.4;
    return rightScore - leftScore;
  })[0] ?? null;
}

function matchHexName(rawText) {
  const normalizedRawText = normalizeOcrText(rawText);
  if (!normalizedRawText) {
    return { name: "", score: 0, debug: emptyOcrMatchDebug("") };
  }

  return HEX_NAME_LIBRARY.map((name) => {
    const normalizedName = normalizeOcrText(name);
    const distanceScore = similarityScore(normalizedRawText, normalizedName);
    const containsScore =
      normalizedRawText.includes(normalizedName) || normalizedName.includes(normalizedRawText) ? 0.94 : 0;
    return {
      name,
      score: Math.max(distanceScore, containsScore),
      debug: {
        normalizedRawText,
        normalizedName,
        distanceScore,
        containsScore,
      },
    };
  }).reduce((best, current) => (current.score > best.score ? current : best), {
    name: "",
    score: 0,
    debug: emptyOcrMatchDebug(normalizedRawText),
  });
}

function emptyOcrMatchDebug(normalizedRawText) {
  return {
    normalizedRawText,
    normalizedName: "",
    distanceScore: 0,
    containsScore: 0,
  };
}

function normalizeOcrText(value) {
  return value
    .replace(/[^\p{Script=Han}a-zA-Z0-9]/gu, "")
    .replace(/[〇○]/g, "零")
    .trim()
    .toLowerCase();
}

function similarityScore(left, right) {
  if (!left || !right) {
    return 0;
  }
  if (left === right) {
    return 1;
  }

  const leftChars = Array.from(left);
  const rightChars = Array.from(right);
  const distance = levenshteinDistance(leftChars, rightChars);
  return Math.max(0, 1 - distance / Math.max(leftChars.length, rightChars.length));
}

function levenshteinDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array(right.length + 1);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function summarizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 500);
}
