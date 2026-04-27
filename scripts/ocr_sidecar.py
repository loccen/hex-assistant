#!/usr/bin/env python3
"""
RapidOCR / ONNXRuntime sidecar for LOL 海克斯助手.

用法:
  echo '{"crops": [{"slot": 1, "path": "/path/to/crop.png"}]}' | python3 ocr_sidecar.py
  python3 ocr_sidecar.py --image /path/to/full.png --rects '[[560,520,1015,640],[1035,520,1495,640],[1510,520,1970,640]]'

输入 JSON (stdin 模式):
  {
    "crops": [{"slot": 1, "path": "..."}, ...],
    "selectLargestText": true
  }

输出 JSON:
  {
    "engine": "RapidOCR+ONNXRuntime",
    "version": {...},
    "durationMs": 1234,
    "slots": [
      {
        "slot": 1,
        "status": "recognized" | "empty" | "error",
        "rawText": "...",
        "confidence": 0.99,
        "durationMs": 400,
        "candidates": [...]
      }
    ],
    "error": null
  }
"""

import json
import sys
import time
import argparse
import os

try:
    from rapidocr_onnxruntime import RapidOCR
    import numpy as np
    import cv2

    _IMPORT_ERROR = None
except Exception as exc:
    _IMPORT_ERROR = str(exc)


def _engine_version():
    versions = {"engine": "RapidOCR+ONNXRuntime"}
    try:
        import rapidocr_onnxruntime
        versions["rapidocr_onnxruntime"] = getattr(rapidocr_onnxruntime, "__version__", "unknown")
    except Exception:
        pass
    try:
        import onnxruntime
        versions["onnxruntime"] = onnxruntime.__version__
    except Exception:
        pass
    return versions


def _load_image(path: str):
    img = cv2.imread(path)
    if img is None:
        raise ValueError(f"无法读取图片: {path}")
    return img


def _select_title_text(results, img_h: int):
    """从 RapidOCR 输出的候选中选择标题文字（最大字号，位于上半部分）。

    RapidOCR 输出格式: list of [box_points, text, confidence]
    box_points: [[x0,y0],[x1,y1],[x2,y2],[x3,y3]]
    """
    if not results:
        return None

    best = None
    best_height = 0

    for item in results:
        if len(item) < 3:
            continue
        box, text, conf = item[0], item[1], item[2]
        text = (text or "").strip()
        if not text:
            continue

        ys = [pt[1] for pt in box]
        center_y = sum(ys) / len(ys)
        heights = [abs(box[2][1] - box[0][1]), abs(box[3][1] - box[1][1])]
        char_h = max(heights) if heights else 0

        # 标题行在裁剪图上半部分
        if center_y > img_h * 0.65:
            continue

        if char_h > best_height:
            best_height = char_h
            best = (text, conf, box)

    return best


def _ocr_crop(engine, img_path: str):
    """对单张裁剪图执行 OCR，返回 (rawText, confidence, candidates, durationMs)。"""
    t0 = time.perf_counter()
    img = _load_image(img_path)
    img_h = img.shape[0]

    results, elapse = engine(img)
    elapsed_ms = (time.perf_counter() - t0) * 1000

    candidates = []
    if results:
        for item in results:
            if len(item) < 3:
                continue
            box, text, conf = item[0], item[1], float(item[2])
            candidates.append({
                "text": (text or "").strip(),
                "confidence": round(conf, 6),
                "box": [[round(float(p[0]), 1), round(float(p[1]), 1)] for p in box],
            })

    selected = _select_title_text(results, img_h)
    if selected:
        raw_text, conf, _ = selected
        return raw_text.strip(), round(float(conf), 6), candidates, round(elapsed_ms, 2)
    return "", 0.0, candidates, round(elapsed_ms, 2)


def _ocr_from_rect(engine, img, rect, slot_idx):
    """从整张截图按 rect=[x0,y0,x1,y1] 裁剪后执行 OCR。"""
    x0, y0, x1, y1 = rect
    h, w = img.shape[:2]
    # 等比缩放到当前图片尺寸（基准是 2560x1440）
    scale_x = w / 2560.0
    scale_y = h / 1440.0
    cx0 = max(0, int(x0 * scale_x))
    cy0 = max(0, int(y0 * scale_y))
    cx1 = min(w, int(x1 * scale_x))
    cy1 = min(h, int(y1 * scale_y))
    crop = img[cy0:cy1, cx0:cx1]

    t0 = time.perf_counter()
    crop_h = crop.shape[0]
    results, _ = engine(crop)
    elapsed_ms = (time.perf_counter() - t0) * 1000

    candidates = []
    if results:
        for item in results:
            if len(item) < 3:
                continue
            box, text, conf = item[0], item[1], float(item[2])
            candidates.append({
                "text": (text or "").strip(),
                "confidence": round(conf, 6),
                "box": [[round(float(p[0]), 1), round(float(p[1]), 1)] for p in box],
            })

    selected = _select_title_text(results, crop_h)
    if selected:
        raw_text, conf, _ = selected
        return {
            "slot": slot_idx + 1,
            "status": "recognized",
            "rawText": raw_text.strip(),
            "confidence": round(float(conf), 6),
            "durationMs": round(elapsed_ms, 2),
            "rect": [cx0, cy0, cx1, cy1],
            "candidates": candidates,
        }
    return {
        "slot": slot_idx + 1,
        "status": "empty",
        "rawText": "",
        "confidence": 0.0,
        "durationMs": round(elapsed_ms, 2),
        "rect": [cx0, cy0, cx1, cy1],
        "candidates": candidates,
    }


def run_stdin_mode():
    """从 stdin 读取 JSON，处理 crops 列表。"""
    try:
        payload = json.loads(sys.stdin.read())
    except Exception as exc:
        print(json.dumps({"error": f"解析 stdin JSON 失败: {exc}"}))
        sys.exit(1)

    crops = payload.get("crops", [])
    t_total = time.perf_counter()
    engine = RapidOCR()
    slot_results = []

    for crop_info in crops:
        slot = crop_info.get("slot", 0)
        path = crop_info.get("path", "")
        if not path or not os.path.exists(path):
            slot_results.append({
                "slot": slot,
                "status": "error",
                "rawText": "",
                "confidence": 0.0,
                "durationMs": 0.0,
                "candidates": [],
                "error": f"文件不存在: {path}",
            })
            continue
        try:
            raw, conf, cands, dur = _ocr_crop(engine, path)
            slot_results.append({
                "slot": slot,
                "status": "recognized" if raw else "empty",
                "rawText": raw,
                "confidence": conf,
                "durationMs": dur,
                "candidates": cands,
            })
        except Exception as exc:
            slot_results.append({
                "slot": slot,
                "status": "error",
                "rawText": "",
                "confidence": 0.0,
                "durationMs": 0.0,
                "candidates": [],
                "error": str(exc),
            })

    total_ms = round((time.perf_counter() - t_total) * 1000, 2)
    print(json.dumps({
        "engine": "RapidOCR+ONNXRuntime",
        "version": _engine_version(),
        "durationMs": total_ms,
        "slots": slot_results,
        "error": None,
    }, ensure_ascii=False))


def run_image_mode(image_path: str, rects_json: str):
    """整张截图 + rect 列表模式（用于回归评估）。"""
    try:
        rects = json.loads(rects_json)
    except Exception as exc:
        print(json.dumps({"error": f"解析 --rects JSON 失败: {exc}"}))
        sys.exit(1)

    try:
        img = _load_image(image_path)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)

    t_total = time.perf_counter()
    engine = RapidOCR()
    slot_results = []

    for idx, rect in enumerate(rects):
        try:
            result = _ocr_from_rect(engine, img, rect, idx)
            slot_results.append(result)
        except Exception as exc:
            slot_results.append({
                "slot": idx + 1,
                "status": "error",
                "rawText": "",
                "confidence": 0.0,
                "durationMs": 0.0,
                "rect": rect,
                "candidates": [],
                "error": str(exc),
            })

    total_ms = round((time.perf_counter() - t_total) * 1000, 2)
    print(json.dumps({
        "engine": "RapidOCR+ONNXRuntime",
        "version": _engine_version(),
        "durationMs": total_ms,
        "slots": slot_results,
        "error": None,
    }, ensure_ascii=False))


def main():
    if _IMPORT_ERROR:
        print(json.dumps({
            "engine": "RapidOCR+ONNXRuntime",
            "error": f"导入失败: {_IMPORT_ERROR}",
            "hint": "请运行: pip install rapidocr-onnxruntime",
        }), file=sys.stdout)
        sys.exit(1)

    parser = argparse.ArgumentParser(description="RapidOCR sidecar")
    parser.add_argument("--image", help="整张截图路径（配合 --rects 使用）")
    parser.add_argument("--rects", help='三槽坐标 JSON，格式 "[[x0,y0,x1,y1],...]"')
    args = parser.parse_args()

    if args.image and args.rects:
        run_image_mode(args.image, args.rects)
    else:
        run_stdin_mode()


if __name__ == "__main__":
    main()
