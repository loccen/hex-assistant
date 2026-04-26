import React, { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { createRoot } from "react-dom/client";
import Tesseract from "tesseract.js";
import "./styles.css";

type RectInfo = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CaptureTarget = {
  kind: string;
  id: string;
  label: string;
  bounds?: RectInfo | null;
};

type EnvironmentSnapshot = {
  os: string;
  arch: string;
  family: string;
  appDataDir: string;
  rustTargetOs: string;
  rustTargetArch: string;
};

type PixelMetrics = {
  averageLuma: number;
  lumaVariance: number;
  nearBlackRatio: number;
  sampledPixels: number;
};

type CaptureAttempt = {
  strategy: string;
  targetLabel: string;
  startedAt: string;
  durationMs: number;
  status: "success" | "failed" | string;
  width?: number | null;
  height?: number | null;
  savedPath?: string | null;
  imageHash?: string | null;
  blackScreenSuspected?: boolean | null;
  metrics?: PixelMetrics | null;
  error?: string | null;
};

type DiagnosticReport = {
  id: string;
  createdAt: string;
  request: {
    saveSamples: boolean;
    delaySeconds: number;
  };
  environment: EnvironmentSnapshot;
  targets: CaptureTarget[];
  attempts: CaptureAttempt[];
  summary: string;
  reportDir: string;
  logPath: string;
  jsonPath: string;
};

type CalibrationMonitorInfo = {
  id: string;
  name: string;
  isPrimary: boolean;
  bounds: RectInfo;
};

type CalibrationSnapshotResult = {
  createdAt: string;
  samplePath?: string | null;
  width: number;
  height: number;
  monitor: CalibrationMonitorInfo;
  metrics: PixelMetrics;
  blackScreenSuspected: boolean;
};

type RatioRegion = {
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
};

type SlottedRatioRegion = RatioRegion & {
  slot: number;
};

type CalibrationProfile = {
  version: number;
  profileName: string;
  monitorId: string;
  monitorName: string;
  screenshotWidth: number;
  screenshotHeight: number;
  dpiScale?: number | null;
  displayModeNote?: string | null;
  language: string;
  nameRegions: SlottedRatioRegion[];
  bottomAnchors: SlottedRatioRegion[];
  toggleButtonRegion: RatioRegion;
  overlay: {
    gap: number;
    maxHeight: number;
    autoHideAfterMissingMs: number;
  };
};

type OverlayPocTargetInfo = {
  monitorId?: string | null;
  monitorName?: string | null;
  source: string;
  bounds: RectInfo;
  logicalBounds: RectInfo;
  scaleFactor: number;
};

type OverlayPocCardInfo = {
  slot: number;
  title: string;
  body: string;
  bounds: RectInfo;
  source: string;
};

type OverlayPocResult = {
  created: boolean;
  label: string;
  url: string;
  target: OverlayPocTargetInfo;
  clickThroughRequested: boolean;
  clickThroughEnabled: boolean;
  transparentRequested: boolean;
  transparentEnabled: boolean;
  cards: OverlayPocCardInfo[];
  messages: string[];
};

type OverlayPocCloseResult = {
  label: string;
  closed: boolean;
  message: string;
};

type OverlayPocClickThroughResult = {
  label: string;
  requested: boolean;
  applied: boolean;
  supported: boolean;
  message: string;
};

type OverlayStoredState = {
  updatedAt: string;
  label: string;
  target: OverlayPocTargetInfo;
  cards: OverlayPocCardInfo[];
};

type Mode = "diagnostic" | "calibration" | "overlay" | "ocr" | "stateMachine";
type RegionKey =
  | "name-1"
  | "name-2"
  | "name-3"
  | "anchor-1"
  | "anchor-2"
  | "anchor-3"
  | "toggle";

type RegionDefinition = {
  key: RegionKey;
  label: string;
  summary: string;
  group: "name" | "anchor" | "toggle";
  slot?: number;
};

type RegionMap = Record<RegionKey, RatioRegion | null>;

type DragSelection = {
  key: RegionKey;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

type OcrSlotStatus = "pending" | "recognized" | "suspect" | "manual" | "failed";

type OcrSlotResult = {
  slot: number;
  rawText: string;
  confidence: number;
  matchedName: string;
  matchScore: number;
  status: OcrSlotStatus;
  message?: string;
};

type LiveClientActivePlayerResult = {
  available: boolean;
  championName?: string | null;
  level?: number | null;
  rawJson?: unknown;
  checkedAt: string;
  durationMs: number;
  error?: string | null;
};

type StateMachineStatus =
  | "IN_GAME_MONITORING"
  | "AUGMENT_ELIGIBLE"
  | "AUGMENT_STAGE_ACTIVE"
  | "AUGMENT_COLLAPSED"
  | "AUGMENT_EXPANDED"
  | "AUGMENT_ROUND_COMPLETED"
  | "AUGMENT_STAGE_COMPLETED";

type VisualDetectionInput = {
  buttonVisible: boolean;
  cardsExpanded: boolean;
};

type StateMachineEvent = {
  id: number;
  time: string;
  message: string;
};

const REGION_DEFINITIONS: RegionDefinition[] = [
  { key: "name-1", label: "名称 slot1", summary: "第一张名称 OCR 区域", group: "name", slot: 1 },
  { key: "name-2", label: "名称 slot2", summary: "第二张名称 OCR 区域", group: "name", slot: 2 },
  { key: "name-3", label: "名称 slot3", summary: "第三张名称 OCR 区域", group: "name", slot: 3 },
  { key: "anchor-1", label: "锚点 slot1", summary: "第一张底部锚点区域", group: "anchor", slot: 1 },
  { key: "anchor-2", label: "锚点 slot2", summary: "第二张底部锚点区域", group: "anchor", slot: 2 },
  { key: "anchor-3", label: "锚点 slot3", summary: "第三张底部锚点区域", group: "anchor", slot: 3 },
  { key: "toggle", label: "展开按钮", summary: "底部展开/收起按钮区域", group: "toggle" },
];

const EMPTY_REGIONS: RegionMap = {
  "name-1": null,
  "name-2": null,
  "name-3": null,
  "anchor-1": null,
  "anchor-2": null,
  "anchor-3": null,
  toggle: null,
};

const DEFAULT_OVERLAY = {
  gap: 8,
  maxHeight: 120,
  autoHideAfterMissingMs: 1000,
};

const OVERLAY_STORAGE_KEY = "hex-assistant.overlayPoc";
const OCR_CONFIDENCE_THRESHOLD = 65;
const OCR_MATCH_THRESHOLD = 0.72;
const OCR_WORKER_PATH = "/ocr-assets/tesseract/worker.min.js";
const OCR_CORE_PATH = "/ocr-assets/tesseract-core";
const OCR_LANG_PATH = "/ocr-assets/lang";
const AUGMENT_MILESTONES = [3, 7, 11, 15];
const STATE_MACHINE_STATUSES: StateMachineStatus[] = [
  "IN_GAME_MONITORING",
  "AUGMENT_ELIGIBLE",
  "AUGMENT_STAGE_ACTIVE",
  "AUGMENT_COLLAPSED",
  "AUGMENT_EXPANDED",
  "AUGMENT_ROUND_COMPLETED",
  "AUGMENT_STAGE_COMPLETED",
];
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
];

function App() {
  const [mode, setMode] = useState<Mode>("diagnostic");
  const [saveSamples, setSaveSamples] = useState(true);
  const [delaySeconds, setDelaySeconds] = useState(8);
  const [environment, setEnvironment] = useState<EnvironmentSnapshot | null>(null);
  const [targets, setTargets] = useState<CaptureTarget[]>([]);
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedMonitorId, setSelectedMonitorId] = useState("");
  const [calibrationSnapshot, setCalibrationSnapshot] = useState<CalibrationSnapshotResult | null>(
    null,
  );
  const [calibrationProfile, setCalibrationProfile] = useState<CalibrationProfile | null>(null);
  const [regions, setRegions] = useState<RegionMap>(EMPTY_REGIONS);
  const [activeRegionKey, setActiveRegionKey] = useState<RegionKey>("name-1");
  const [displayModeNote, setDisplayModeNote] = useState("显示器级截图校准");
  const [language, setLanguage] = useState("zh_CN");
  const [calibrationLoading, setCalibrationLoading] = useState(false);
  const [calibrationSaving, setCalibrationSaving] = useState(false);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  const [calibrationMessage, setCalibrationMessage] = useState<string | null>(null);
  const [overlayResult, setOverlayResult] = useState<OverlayPocResult | null>(null);
  const [overlayCloseResult, setOverlayCloseResult] = useState<OverlayPocCloseResult | null>(null);
  const [overlayClickThroughResult, setOverlayClickThroughResult] =
    useState<OverlayPocClickThroughResult | null>(null);
  const [overlayLoading, setOverlayLoading] = useState(false);
  const [overlayError, setOverlayError] = useState<string | null>(null);
  const [ocrResults, setOcrResults] = useState<OcrSlotResult[]>([]);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrMessage, setOcrMessage] = useState<string | null>(null);
  const [ocrProgress, setOcrProgress] = useState<string | null>(null);
  const [ocrChangedSlots, setOcrChangedSlots] = useState<number[]>([]);
  const [liveClientPlayer, setLiveClientPlayer] = useState<LiveClientActivePlayerResult | null>(null);
  const [liveClientLoading, setLiveClientLoading] = useState(false);
  const [completedMilestones, setCompletedMilestones] = useState<number[]>([]);
  const [visualInput, setVisualInput] = useState<VisualDetectionInput>({
    buttonVisible: false,
    cardsExpanded: false,
  });
  const [stateMachineSlots, setStateMachineSlots] = useState<string[]>(["", "", ""]);
  const [stateMachineChangedSlots, setStateMachineChangedSlots] = useState<number[]>([]);
  const [stateMachineEvents, setStateMachineEvents] = useState<StateMachineEvent[]>([]);
  const stateMachineEventIdRef = useRef(1);
  const previousStateRef = useRef<StateMachineStatus | null>(null);
  const previousQueueSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    void refresh();
    void loadCalibrationProfile();
  }, []);

  const monitorTargets = useMemo(
    () => targets.filter((target) => target.kind === "monitor"),
    [targets],
  );
  const selectedMonitor = useMemo(
    () => monitorTargets.find((target) => target.id === selectedMonitorId) ?? monitorTargets[0],
    [monitorTargets, selectedMonitorId],
  );
  const canRunOcr = Boolean(calibrationProfile && calibrationSnapshot?.samplePath);
  const pendingMilestoneQueue = useMemo(
    () => buildPendingMilestoneQueue(liveClientPlayer, completedMilestones),
    [completedMilestones, liveClientPlayer],
  );
  const stateMachineStatus = useMemo(
    () => deriveStateMachineStatus(liveClientPlayer, pendingMilestoneQueue, completedMilestones, visualInput),
    [completedMilestones, liveClientPlayer, pendingMilestoneQueue, visualInput],
  );

  const queueSignature = pendingMilestoneQueue.join(",");

  useEffect(() => {
    if (previousStateRef.current && previousStateRef.current !== stateMachineStatus) {
      addStateMachineEvent(`状态变化：${formatStateMachineStatus(previousStateRef.current)} -> ${formatStateMachineStatus(stateMachineStatus)}`);
    }
    previousStateRef.current = stateMachineStatus;
  }, [stateMachineStatus]);

  useEffect(() => {
    if (previousQueueSignatureRef.current !== null && previousQueueSignatureRef.current !== queueSignature) {
      addStateMachineEvent(`队列变化：${formatMilestoneQueue(pendingMilestoneQueue)}`);
    }
    previousQueueSignatureRef.current = queueSignature;
  }, [pendingMilestoneQueue, queueSignature]);

  async function refresh() {
    setError(null);
    try {
      const [env, captureTargets] = await Promise.all([
        invoke<EnvironmentSnapshot>("get_environment_snapshot"),
        invoke<CaptureTarget[]>("list_capture_targets"),
      ]);
      setEnvironment(env);
      setTargets(captureTargets);
      const firstMonitor = captureTargets.find((target) => target.kind === "monitor");
      if (firstMonitor) {
        setSelectedMonitorId((current) => current || firstMonitor.id);
      }
    } catch (err) {
      setError(String(err));
    }
  }

  async function loadCalibrationProfile() {
    setCalibrationError(null);
    try {
      const profile = await invoke<CalibrationProfile | null>("load_calibration_profile");
      setCalibrationProfile(profile);
      if (profile) {
        setRegions(profileToRegions(profile));
        setSelectedMonitorId((current) => current || profile.monitorId);
        setDisplayModeNote(profile.displayModeNote ?? "显示器级截图校准");
        setLanguage(profile.language || "zh_CN");
      }
    } catch (err) {
      setCalibrationError(String(err));
    }
  }

  async function runDiagnostic() {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<DiagnosticReport>("run_capture_diagnostic", {
        request: {
          saveSamples,
          delaySeconds,
        },
      });
      setReport(result);
      setEnvironment(result.environment);
      setTargets(result.targets);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  function addStateMachineEvent(message: string) {
    const event: StateMachineEvent = {
      id: stateMachineEventIdRef.current,
      time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      message,
    };
    stateMachineEventIdRef.current += 1;
    setStateMachineEvents((current) => [event, ...current].slice(0, 80));
  }

  async function refreshLiveClientActivePlayer() {
    setLiveClientLoading(true);
    try {
      const result = await invoke<LiveClientActivePlayerResult>("get_live_client_active_player");
      setLiveClientPlayer(result);
      addStateMachineEvent(
        result.available
          ? `刷新本地接口：${result.championName ?? "未知英雄"}，等级 ${result.level ?? "-"}，耗时 ${result.durationMs}ms`
          : `刷新本地接口：不可用，耗时 ${result.durationMs}ms，错误：${result.error ?? "无"}`,
      );
    } catch (err) {
      const message = String(err);
      setLiveClientPlayer({
        available: false,
        championName: null,
        level: null,
        checkedAt: new Date().toISOString(),
        durationMs: 0,
        error: message,
      });
      addStateMachineEvent(`刷新本地接口失败：${message}`);
    } finally {
      setLiveClientLoading(false);
    }
  }

  function updateVisualInput(patch: Partial<VisualDetectionInput>) {
    const next = { ...visualInput, ...patch };
    const changes: string[] = [];
    if (next.buttonVisible !== visualInput.buttonVisible) {
      changes.push(`按钮${next.buttonVisible ? "存在" : "不存在"}`);
    }
    if (next.cardsExpanded !== visualInput.cardsExpanded) {
      changes.push(`卡片${next.cardsExpanded ? "展开" : "收起"}`);
    }
    setVisualInput(next);
    if (changes.length > 0) {
      addStateMachineEvent(`人工视觉输入：${changes.join("，")}`);
    }
  }

  function updateStateMachineSlot(slot: number, value: string) {
    const next = [...stateMachineSlots];
    const previous = next[slot - 1] ?? "";
    const normalizedValue = value.trim();
    next[slot - 1] = normalizedValue;
    setStateMachineSlots(next);
    if (previous !== normalizedValue) {
      setStateMachineChangedSlots((current) =>
        current.includes(slot) ? current : [...current, slot].sort((left, right) => left - right),
      );
      addStateMachineEvent(`slot ${slot} 名称变化：${previous || "空"} -> ${normalizedValue || "空"}`);
    }
  }

  function applyOcrResultsToStateMachine() {
    const sortedResults = ocrResults.slice().sort((left, right) => left.slot - right.slot);
    if (sortedResults.length === 0) {
      addStateMachineEvent("读取 OCR 结果：当前没有 Stage 2C 结果，请手动输入三 slot 名称。");
      return;
    }

    const nextSlots = [1, 2, 3].map((slot) => sortedResults.find((result) => result.slot === slot)?.matchedName.trim() ?? "");
    const changedSlots = nextSlots
      .map((value, index) => ({ slot: index + 1, value, previous: stateMachineSlots[index] ?? "" }))
      .filter((item) => item.value !== item.previous)
      .map((item) => item.slot);

    setStateMachineSlots(nextSlots);
    if (changedSlots.length > 0) {
      setStateMachineChangedSlots((current) =>
        Array.from(new Set([...current, ...changedSlots])).sort((left, right) => left - right),
      );
      addStateMachineEvent(`读取 OCR 结果：slot ${changedSlots.join("、")} 名称变化，只标记变化 slot。`);
    } else {
      addStateMachineEvent("读取 OCR 结果：三 slot 名称未变化。");
    }
  }

  function clearStateMachineChangedSlots() {
    setStateMachineChangedSlots([]);
    addStateMachineEvent("已清除 slot 变化标记，未重置当前阶段。");
  }

  function completeCurrentMilestone() {
    const milestone = pendingMilestoneQueue[0];
    if (!milestone) {
      addStateMachineEvent("标记当前轮完成：当前没有待处理档位。");
      return;
    }
    if (visualInput.buttonVisible) {
      addStateMachineEvent("标记当前轮完成被拦截：按钮仍存在，卡片消失不等于完成。");
      return;
    }
    setCompletedMilestones((current) =>
      current.includes(milestone) ? current : [...current, milestone].sort((left, right) => left - right),
    );
    addStateMachineEvent(`已标记 ${milestone} 级海克斯轮完成。`);
  }

  async function captureCalibrationSnapshot() {
    setCalibrationLoading(true);
    setCalibrationError(null);
    setCalibrationMessage(null);
    try {
      const request =
        selectedMonitor?.id !== undefined
          ? { monitorId: selectedMonitor.id, delaySeconds, saveSample: saveSamples }
          : { delaySeconds, saveSample: saveSamples };
      const result = await invoke<CalibrationSnapshotResult>("capture_calibration_snapshot", {
        request,
      });
      setCalibrationSnapshot(result);
      setSelectedMonitorId(result.monitor.id);
      setCalibrationMessage("已获取校准截图，可以开始框选区域。");
    } catch (err) {
      setCalibrationError(String(err));
    } finally {
      setCalibrationLoading(false);
    }
  }

  function updateRegion(key: RegionKey, region: RatioRegion | null) {
    setRegions((current) => ({
      ...current,
      [key]: region,
    }));
  }

  function clearAllRegions() {
    setRegions(EMPTY_REGIONS);
    setCalibrationMessage("已清空全部区域。");
  }

  async function saveCalibrationProfile() {
    if (!calibrationSnapshot) {
      setCalibrationError("请先获取一次校准截图。");
      return;
    }

    const missingRegion = REGION_DEFINITIONS.find((definition) => !regions[definition.key]);
    if (missingRegion) {
      setCalibrationError(`请先框选 ${missingRegion.label}。`);
      return;
    }

    setCalibrationSaving(true);
    setCalibrationError(null);
    setCalibrationMessage(null);
    try {
      const profile: CalibrationProfile = {
        version: 1,
        profileName: `${calibrationSnapshot.width}x${calibrationSnapshot.height}-${language}`,
        monitorId: calibrationSnapshot.monitor.id,
        monitorName: calibrationSnapshot.monitor.name,
        screenshotWidth: calibrationSnapshot.width,
        screenshotHeight: calibrationSnapshot.height,
        dpiScale: null,
        displayModeNote: displayModeNote.trim() || "显示器级截图校准",
        language,
        nameRegions: buildSlottedRegions(regions, "name"),
        bottomAnchors: buildSlottedRegions(regions, "anchor"),
        toggleButtonRegion: regions.toggle as RatioRegion,
        overlay: DEFAULT_OVERLAY,
      };

      await invoke<void>("save_calibration_profile", { profile });
      setCalibrationProfile(profile);
      setCalibrationMessage("校准配置已保存。");
    } catch (err) {
      setCalibrationError(String(err));
    } finally {
      setCalibrationSaving(false);
    }
  }

  async function openOverlayPoc() {
    setOverlayLoading(true);
    setOverlayError(null);
    setOverlayCloseResult(null);
    setOverlayClickThroughResult(null);
    try {
      const result = await invoke<OverlayPocResult>("open_overlay_poc", {
        request: {
          clickThrough: true,
        },
      });
      setOverlayResult(result);
      writeOverlayState(result);
    } catch (err) {
      setOverlayError(String(err));
    } finally {
      setOverlayLoading(false);
    }
  }

  async function closeOverlayPoc() {
    setOverlayLoading(true);
    setOverlayError(null);
    try {
      const result = await invoke<OverlayPocCloseResult>("close_overlay_poc");
      setOverlayCloseResult(result);
    } catch (err) {
      setOverlayError(String(err));
    } finally {
      setOverlayLoading(false);
    }
  }

  async function setOverlayClickThrough(enabled: boolean) {
    setOverlayLoading(true);
    setOverlayError(null);
    try {
      const result = await invoke<OverlayPocClickThroughResult>("set_overlay_poc_click_through", {
        enabled,
      });
      setOverlayClickThroughResult(result);
    } catch (err) {
      setOverlayError(String(err));
    } finally {
      setOverlayLoading(false);
    }
  }

  async function runOcrPoc() {
    if (!calibrationProfile) {
      setOcrError("请先到校准页保存校准配置。");
      return;
    }
    if (!calibrationSnapshot?.samplePath) {
      setOcrError("请先到校准页获取一张校准截图，再运行 OCR POC。");
      return;
    }
    if (calibrationProfile.nameRegions.length < 3) {
      setOcrError("校准配置缺少三块名称区域，请回到校准页补齐 nameRegions。");
      return;
    }

    setOcrLoading(true);
    setOcrError(null);
    setOcrMessage(null);
    setOcrProgress("准备 OCR worker...");
    setOcrChangedSlots([]);

    const previousNames = new Map(ocrResults.map((result) => [result.slot, result.matchedName]));
    let worker: Tesseract.Worker | null = null;

    try {
      const image = await loadImageElement(convertFileSrc(calibrationSnapshot.samplePath));
      worker = await Tesseract.createWorker("chi_sim", Tesseract.OEM.LSTM_ONLY, {
        workerPath: OCR_WORKER_PATH,
        corePath: OCR_CORE_PATH,
        langPath: OCR_LANG_PATH,
        cacheMethod: "none",
        logger: (message) => {
          const percent = Math.round((message.progress ?? 0) * 100);
          setOcrProgress(`${message.status} ${Number.isFinite(percent) ? `${percent}%` : ""}`.trim());
        },
      });
      await worker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
        preserve_interword_spaces: "1",
      });

      const nextResults: OcrSlotResult[] = [];
      const nameRegions = calibrationProfile.nameRegions.slice().sort((left, right) => left.slot - right.slot);
      for (const region of nameRegions) {
        setOcrProgress(`识别 slot ${region.slot}...`);
        const cropCanvas = cropRegionToCanvas(image, region);
        const result = await worker.recognize(cropCanvas);
        nextResults.push(buildOcrResult(region.slot, result.data.text, result.data.confidence));
      }

      const changedSlots = nextResults
        .filter((result) => {
          const previous = previousNames.get(result.slot);
          return previous !== undefined && previous !== result.matchedName;
        })
        .map((result) => result.slot);

      setOcrResults(nextResults);
      setOcrChangedSlots(changedSlots);
      if (changedSlots.length === 1) {
        setOcrMessage(`slot ${changedSlots[0]} 标准名称变化，只刷新对应 slot。`);
      } else if (changedSlots.length > 1) {
        setOcrMessage(`检测到 ${changedSlots.length} 个 slot 标准名称变化。`);
      } else {
        setOcrMessage("OCR 完成，标准名称未发生变化。");
      }
    } catch (err) {
      setOcrError(String(err));
    } finally {
      if (worker) {
        await worker.terminate();
      }
      setOcrLoading(false);
      setOcrProgress(null);
    }
  }

  function applyManualOcrCorrection(slot: number, value: string) {
    const nextName = value.trim();
    if (!nextName) {
      return;
    }
    setOcrResults((current) =>
      current.map((result) =>
        result.slot === slot
          ? {
              ...result,
              matchedName: nextName,
              matchScore: HEX_NAME_LIBRARY.includes(nextName) ? 1 : result.matchScore,
              status: "manual",
              message: "人工修正",
            }
          : result,
      ),
    );
    setOcrChangedSlots((current) => current.filter((changedSlot) => changedSlot !== slot));
    setOcrMessage(`slot ${slot} 已人工修正为 ${nextName}。`);
  }

  return (
    <main className="app-shell">
      <section className="top-bar">
        <div>
          <h1>屏幕截图诊断工具</h1>
          <p>验证显示器级截图能力，并为后续识别流程保存基础校准区域。</p>
        </div>
        <div className="top-actions">
          <div className="mode-switch" aria-label="工作区">
            <button
              className={mode === "diagnostic" ? "selected" : ""}
              onClick={() => setMode("diagnostic")}
              type="button"
            >
              诊断
            </button>
            <button
              className={mode === "calibration" ? "selected" : ""}
              onClick={() => setMode("calibration")}
              type="button"
            >
              校准
            </button>
            <button
              className={mode === "overlay" ? "selected" : ""}
              onClick={() => setMode("overlay")}
              type="button"
            >
              Overlay POC
            </button>
            <button
              className={mode === "ocr" ? "selected" : ""}
              onClick={() => setMode("ocr")}
              type="button"
            >
              OCR POC
            </button>
            <button
              className={mode === "stateMachine" ? "selected" : ""}
              onClick={() => setMode("stateMachine")}
              type="button"
            >
              状态机 POC
            </button>
          </div>
          <button
            className="ghost-button"
            onClick={refresh}
            disabled={loading || calibrationLoading || calibrationSaving || overlayLoading || ocrLoading || liveClientLoading}
            type="button"
          >
            刷新环境
          </button>
        </div>
      </section>

      {error ? <div className="error-strip">{error}</div> : null}

      <section className="workspace">
        <aside className="control-panel">
          {mode === "diagnostic" ? (
            <DiagnosticControls
              saveSamples={saveSamples}
              delaySeconds={delaySeconds}
              loading={loading}
              report={report}
              onSaveSamplesChange={setSaveSamples}
              onDelaySecondsChange={setDelaySeconds}
              onRunDiagnostic={runDiagnostic}
            />
          ) : mode === "overlay" ? (
            <OverlayControls
              loading={overlayLoading}
              hasCalibrationProfile={Boolean(calibrationProfile)}
              onOpen={openOverlayPoc}
              onClose={closeOverlayPoc}
              onSetClickThrough={setOverlayClickThrough}
            />
          ) : mode === "ocr" ? (
            <OcrControls
              loading={ocrLoading}
              canRun={canRunOcr}
              hasCalibrationProfile={Boolean(calibrationProfile)}
              hasCalibrationSnapshot={Boolean(calibrationSnapshot?.samplePath)}
              onRun={runOcrPoc}
            />
          ) : mode === "stateMachine" ? (
            <StateMachineControls
              loading={liveClientLoading}
              canComplete={Boolean(pendingMilestoneQueue[0]) && !visualInput.buttonVisible}
              onRefresh={refreshLiveClientActivePlayer}
              onComplete={completeCurrentMilestone}
            />
          ) : (
            <CalibrationControls
              saveSamples={saveSamples}
              delaySeconds={delaySeconds}
              monitorTargets={monitorTargets}
              selectedMonitorId={selectedMonitorId}
              displayModeNote={displayModeNote}
              language={language}
              loading={calibrationLoading}
              saving={calibrationSaving}
              canSave={Boolean(calibrationSnapshot) && allRegionsSelected(regions)}
              onSaveSamplesChange={setSaveSamples}
              onDelaySecondsChange={setDelaySeconds}
              onSelectedMonitorIdChange={setSelectedMonitorId}
              onDisplayModeNoteChange={setDisplayModeNote}
              onLanguageChange={setLanguage}
              onCapture={captureCalibrationSnapshot}
              onSave={saveCalibrationProfile}
            />
          )}
        </aside>

        <section className="content-panel">
          <EnvironmentView environment={environment} targets={targets} />
          {mode === "diagnostic" ? (
            report ? (
              <ReportView report={report} />
            ) : (
              <EmptyState />
            )
          ) : mode === "overlay" ? (
            <OverlayWorkspace
              result={overlayResult}
              closeResult={overlayCloseResult}
              clickThroughResult={overlayClickThroughResult}
              error={overlayError}
              hasCalibrationProfile={Boolean(calibrationProfile)}
            />
          ) : mode === "ocr" ? (
            <OcrWorkspace
              profile={calibrationProfile}
              snapshot={calibrationSnapshot}
              results={ocrResults}
              loading={ocrLoading}
              error={ocrError}
              message={ocrMessage}
              progress={ocrProgress}
              changedSlots={ocrChangedSlots}
              onManualCorrect={applyManualOcrCorrection}
            />
          ) : mode === "stateMachine" ? (
            <StateMachineWorkspace
              player={liveClientPlayer}
              loading={liveClientLoading}
              visualInput={visualInput}
              slots={stateMachineSlots}
              changedSlots={stateMachineChangedSlots}
              completedMilestones={completedMilestones}
              pendingMilestoneQueue={pendingMilestoneQueue}
              status={stateMachineStatus}
              ocrResults={ocrResults}
              events={stateMachineEvents}
              onRefresh={refreshLiveClientActivePlayer}
              onVisualInputChange={updateVisualInput}
              onSlotChange={updateStateMachineSlot}
              onApplyOcrResults={applyOcrResultsToStateMachine}
              onClearChangedSlots={clearStateMachineChangedSlots}
              onCompleteCurrentMilestone={completeCurrentMilestone}
            />
          ) : (
            <CalibrationWorkspace
              snapshot={calibrationSnapshot}
              profile={calibrationProfile}
              regions={regions}
              activeRegionKey={activeRegionKey}
              error={calibrationError}
              message={calibrationMessage}
              onActiveRegionChange={setActiveRegionKey}
              onRegionChange={updateRegion}
              onClearAll={clearAllRegions}
              onReloadProfile={loadCalibrationProfile}
            />
          )}
        </section>
      </section>
    </main>
  );
}

function DiagnosticControls({
  saveSamples,
  delaySeconds,
  loading,
  report,
  onSaveSamplesChange,
  onDelaySecondsChange,
  onRunDiagnostic,
}: {
  saveSamples: boolean;
  delaySeconds: number;
  loading: boolean;
  report: DiagnosticReport | null;
  onSaveSamplesChange: (value: boolean) => void;
  onDelaySecondsChange: (value: number) => void;
  onRunDiagnostic: () => void;
}) {
  return (
    <>
      <h2>诊断目标</h2>
      <div className="target-option selected static-target">
        <span>
          <strong>主显示器</strong>
          <small>使用显示器级截图验证当前画面可捕获性。</small>
        </span>
      </div>

      <SharedCaptureOptions
        saveSamples={saveSamples}
        delaySeconds={delaySeconds}
        disabled={loading}
        onSaveSamplesChange={onSaveSamplesChange}
        onDelaySecondsChange={onDelaySecondsChange}
      />

      <button className="primary-button" onClick={onRunDiagnostic} disabled={loading} type="button">
        {loading ? (delaySeconds > 0 ? `等待 ${delaySeconds} 秒后截图...` : "诊断中...") : "运行截图诊断"}
      </button>

      {report ? (
        <div className="export-box">
          <strong>导出位置</strong>
          <span>{report.reportDir}</span>
          <span>日志：{report.logPath}</span>
          <span>JSON：{report.jsonPath}</span>
        </div>
      ) : null}
    </>
  );
}

function CalibrationControls({
  saveSamples,
  delaySeconds,
  monitorTargets,
  selectedMonitorId,
  displayModeNote,
  language,
  loading,
  saving,
  canSave,
  onSaveSamplesChange,
  onDelaySecondsChange,
  onSelectedMonitorIdChange,
  onDisplayModeNoteChange,
  onLanguageChange,
  onCapture,
  onSave,
}: {
  saveSamples: boolean;
  delaySeconds: number;
  monitorTargets: CaptureTarget[];
  selectedMonitorId: string;
  displayModeNote: string;
  language: string;
  loading: boolean;
  saving: boolean;
  canSave: boolean;
  onSaveSamplesChange: (value: boolean) => void;
  onDelaySecondsChange: (value: number) => void;
  onSelectedMonitorIdChange: (value: string) => void;
  onDisplayModeNoteChange: (value: string) => void;
  onLanguageChange: (value: string) => void;
  onCapture: () => void;
  onSave: () => void;
}) {
  return (
    <>
      <h2>校准截图</h2>
      <div className="delay-field">
        <label htmlFor="monitorId">显示器</label>
        <select
          id="monitorId"
          value={selectedMonitorId}
          onChange={(event) => onSelectedMonitorIdChange(event.currentTarget.value)}
          disabled={loading || saving || monitorTargets.length === 0}
        >
          {monitorTargets.length > 0 ? (
            monitorTargets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.label}
                {target.bounds ? ` · ${target.bounds.width}×${target.bounds.height}` : ""}
              </option>
            ))
          ) : (
            <option value="">主显示器</option>
          )}
        </select>
        <small>默认使用主显示器；如果能枚举到显示器，则使用列表中的第一项。</small>
      </div>

      <SharedCaptureOptions
        saveSamples={saveSamples}
        delaySeconds={delaySeconds}
        disabled={loading || saving}
        onSaveSamplesChange={onSaveSamplesChange}
        onDelaySecondsChange={onDelaySecondsChange}
      />

      <div className="delay-field">
        <label htmlFor="displayModeNote">显示说明</label>
        <input
          id="displayModeNote"
          value={displayModeNote}
          onChange={(event) => onDisplayModeNoteChange(event.currentTarget.value)}
          disabled={loading || saving}
        />
      </div>

      <div className="delay-field">
        <label htmlFor="language">语言</label>
        <select
          id="language"
          value={language}
          onChange={(event) => onLanguageChange(event.currentTarget.value)}
          disabled={loading || saving}
        >
          <option value="zh_CN">简体中文</option>
          <option value="en_US">English</option>
        </select>
      </div>

      <div className="button-stack">
        <button className="primary-button" onClick={onCapture} disabled={loading || saving} type="button">
          {loading ? (delaySeconds > 0 ? `等待 ${delaySeconds} 秒后截图...` : "截图中...") : "获取校准截图"}
        </button>
        <button
          className="secondary-button"
          onClick={onSave}
          disabled={!canSave || loading || saving}
          type="button"
        >
          {saving ? "保存中..." : "保存校准配置"}
        </button>
      </div>
    </>
  );
}

function OverlayControls({
  loading,
  hasCalibrationProfile,
  onOpen,
  onClose,
  onSetClickThrough,
}: {
  loading: boolean;
  hasCalibrationProfile: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSetClickThrough: (enabled: boolean) => void;
}) {
  return (
    <>
      <h2>Overlay POC</h2>
      <div className="target-option selected static-target">
        <span>
          <strong>非侵入式透明测试窗口</strong>
          <small>
            打开时默认请求点击穿透，只显示三张测试卡片，不接 OCR、不查询 ApexLOL、不做自动选择。
          </small>
        </span>
      </div>

      <div className="overlay-note">
        {hasCalibrationProfile
          ? "已读取到校准配置，Overlay 会优先使用底部锚点生成卡片位置。"
          : "尚未读取到校准配置，Overlay 会使用默认三列测试位置。"}
      </div>

      <div className="button-stack">
        <button className="primary-button" onClick={onOpen} disabled={loading} type="button">
          {loading ? "执行中..." : "打开透明 Overlay"}
        </button>
        <button className="secondary-button" onClick={onClose} disabled={loading} type="button">
          关闭 Overlay
        </button>
        <button className="secondary-button" onClick={() => onSetClickThrough(true)} disabled={loading} type="button">
          启用点击穿透
        </button>
        <button className="secondary-button" onClick={() => onSetClickThrough(false)} disabled={loading} type="button">
          关闭点击穿透
        </button>
      </div>
    </>
  );
}

function OcrControls({
  loading,
  canRun,
  hasCalibrationProfile,
  hasCalibrationSnapshot,
  onRun,
}: {
  loading: boolean;
  canRun: boolean;
  hasCalibrationProfile: boolean;
  hasCalibrationSnapshot: boolean;
  onRun: () => void;
}) {
  return (
    <>
      <h2>OCR POC</h2>
      <div className="target-option selected static-target">
        <span>
          <strong>三块名称区域识别</strong>
          <small>只裁剪已保存校准配置里的 nameRegions，不做全屏 OCR、不接 ApexLOL、不接 Overlay 数据。</small>
        </span>
      </div>

      <div className={canRun ? "success-strip" : "overlay-status-strip"}>
        {canRun
          ? "已具备校准配置和当前校准截图，可以手动运行 OCR。"
          : hasCalibrationProfile
            ? "已有校准配置，但没有当前校准截图；请先到校准页获取截图。"
            : hasCalibrationSnapshot
              ? "已有当前校准截图，但还没有保存校准配置。"
              : "请先到校准页获取截图并保存校准配置。"}
      </div>

      <div className="button-stack">
        <button className="primary-button" onClick={onRun} disabled={loading || !canRun} type="button">
          {loading ? "OCR 识别中..." : "运行三槽 OCR"}
        </button>
      </div>
    </>
  );
}

function StateMachineControls({
  loading,
  canComplete,
  onRefresh,
  onComplete,
}: {
  loading: boolean;
  canComplete: boolean;
  onRefresh: () => void;
  onComplete: () => void;
}) {
  return (
    <>
      <h2>状态机 POC</h2>
      <div className="target-option selected static-target">
        <span>
          <strong>本地只读 Live Client Data API</strong>
          <small>
            只读取本机 active-player 英雄和等级，视觉检测输入为人工开关；不做自动点击、自动选择或 ApexLOL 查询。
          </small>
        </span>
      </div>

      <div className="overlay-note">
        默认不自动轮询。需要更新英雄、等级或接口状态时，请手动刷新本地接口。
      </div>

      <div className="button-stack">
        <button className="primary-button" onClick={onRefresh} disabled={loading} type="button">
          {loading ? "刷新中..." : "手动刷新本地接口"}
        </button>
        <button className="secondary-button" onClick={onComplete} disabled={loading || !canComplete} type="button">
          标记当前轮完成
        </button>
      </div>
    </>
  );
}

function SharedCaptureOptions({
  saveSamples,
  delaySeconds,
  disabled,
  onSaveSamplesChange,
  onDelaySecondsChange,
}: {
  saveSamples: boolean;
  delaySeconds: number;
  disabled: boolean;
  onSaveSamplesChange: (value: boolean) => void;
  onDelaySecondsChange: (value: number) => void;
}) {
  return (
    <>
      <label className="check-row">
        <input
          type="checkbox"
          checked={saveSamples}
          onChange={(event) => onSaveSamplesChange(event.currentTarget.checked)}
          disabled={disabled}
        />
        保存截图样本
      </label>

      <div className="delay-field">
        <label htmlFor="delaySeconds">延迟截图</label>
        <select
          id="delaySeconds"
          value={delaySeconds}
          onChange={(event) => onDelaySecondsChange(Number(event.currentTarget.value))}
          disabled={disabled}
        >
          <option value={0}>立即</option>
          <option value={5}>5 秒</option>
          <option value={8}>8 秒</option>
          <option value={12}>12 秒</option>
          <option value={20}>20 秒</option>
        </select>
        <small>点击后切回要校准的画面，等待自动截图。</small>
      </div>
    </>
  );
}

function OverlayWorkspace({
  result,
  closeResult,
  clickThroughResult,
  error,
  hasCalibrationProfile,
}: {
  result: OverlayPocResult | null;
  closeResult: OverlayPocCloseResult | null;
  clickThroughResult: OverlayPocClickThroughResult | null;
  error: string | null;
  hasCalibrationProfile: boolean;
}) {
  return (
    <section className="report-panel overlay-workspace">
      <div className="report-header">
        <div>
          <h2>Overlay POC 验证</h2>
          <p>
            这是非侵入式 Overlay POC。必须人工分别在窗口、无边框、独占全屏下验证卡片可见性和点击穿透。
          </p>
        </div>
        <span className="report-id">Stage 2B</span>
      </div>

      {error ? <div className="error-strip">{error}</div> : null}
      {closeResult ? (
        <div className={closeResult.closed ? "success-strip" : "overlay-status-strip"}>
          {closeResult.message} label：{closeResult.label}
        </div>
      ) : null}
      {clickThroughResult ? (
        <div className={clickThroughResult.applied ? "success-strip" : "overlay-status-strip"}>
          {clickThroughResult.message} 请求：{formatBoolean(clickThroughResult.requested)}；结果：
          {formatBoolean(clickThroughResult.applied)}；支持：{formatBoolean(clickThroughResult.supported)}
        </div>
      ) : null}

      <div className="overlay-note strong">
        {hasCalibrationProfile
          ? "当前有校准配置：后端会优先按 bottomAnchors 计算测试卡片。"
          : "当前没有校准配置：后端会回退到默认三列测试位置。"}
      </div>

      {result ? (
        <>
          <div className="overlay-result-grid">
            <div className="info-panel">
              <h2>窗口</h2>
              <dl>
                <dt>label</dt>
                <dd>{result.label}</dd>
                <dt>URL</dt>
                <dd>{result.url}</dd>
                <dt>已创建</dt>
                <dd>{formatBoolean(result.created)}</dd>
              </dl>
            </div>

            <div className="info-panel">
              <h2>目标尺寸</h2>
              <dl>
                <dt>来源</dt>
                <dd>{result.target.source}</dd>
                <dt>逻辑</dt>
                <dd>{formatRect(result.target.logicalBounds)}</dd>
                <dt>物理</dt>
                <dd>{formatRect(result.target.bounds)}</dd>
                <dt>缩放</dt>
                <dd>{result.target.scaleFactor.toFixed(2)}</dd>
              </dl>
            </div>

            <div className="info-panel">
              <h2>窗口能力</h2>
              <dl>
                <dt>透明请求</dt>
                <dd>{formatBoolean(result.transparentRequested)}</dd>
                <dt>透明结果</dt>
                <dd>{formatBoolean(result.transparentEnabled)}</dd>
                <dt>穿透请求</dt>
                <dd>{formatBoolean(result.clickThroughRequested)}</dd>
                <dt>穿透结果</dt>
                <dd>{formatBoolean(result.clickThroughEnabled)}</dd>
              </dl>
            </div>
          </div>

          <section className="overlay-card-report">
            <h2>三张测试卡片坐标</h2>
            <div className="overlay-card-list">
              {result.cards.map((card) => (
                <article key={card.slot} className="attempt-item">
                  <header>
                    <strong>slot {card.slot}</strong>
                    <span className="badge success">{card.source}</span>
                  </header>
                  <dl>
                    <dt>标题</dt>
                    <dd>{card.title}</dd>
                    <dt>内容</dt>
                    <dd>{card.body}</dd>
                    <dt>坐标</dt>
                    <dd>{formatRect(card.bounds)}</dd>
                  </dl>
                </article>
              ))}
            </div>
          </section>

          <section className="overlay-card-report">
            <h2>后端消息</h2>
            <ul className="plain-list">
              {result.messages.map((message, index) => (
                <li key={`${message}-${index}`}>{message}</li>
              ))}
            </ul>
          </section>
        </>
      ) : (
        <section className="empty-state">
          <h2>等待打开 Overlay</h2>
          <p>点击左侧按钮后，主窗口会展示后端返回的窗口信息、点击穿透结果和三张测试卡片坐标。</p>
        </section>
      )}
    </section>
  );
}

function OcrWorkspace({
  profile,
  snapshot,
  results,
  loading,
  error,
  message,
  progress,
  changedSlots,
  onManualCorrect,
}: {
  profile: CalibrationProfile | null;
  snapshot: CalibrationSnapshotResult | null;
  results: OcrSlotResult[];
  loading: boolean;
  error: string | null;
  message: string | null;
  progress: string | null;
  changedSlots: number[];
  onManualCorrect: (slot: number, value: string) => void;
}) {
  const sortedResults = results.slice().sort((left, right) => left.slot - right.slot);

  return (
    <section className="report-panel ocr-workspace">
      <div className="report-header">
        <div>
          <h2>OCR 与词库纠错 POC</h2>
          <p>基于当前校准截图裁剪三块 nameRegions，识别后用本地海克斯词库输出标准名称。</p>
        </div>
        <span className="report-id">Stage 2C</span>
      </div>

      {error ? <div className="error-strip">{error}</div> : null}
      {message ? <div className="success-strip">{message}</div> : null}
      {progress ? <div className="overlay-status-strip">{progress}</div> : null}

      <div className="ocr-source-grid">
        <div className="info-panel">
          <h2>校准配置</h2>
          {profile ? (
            <dl>
              <dt>名称</dt>
              <dd>{profile.profileName}</dd>
              <dt>显示器</dt>
              <dd>{profile.monitorName}</dd>
              <dt>区域</dt>
              <dd>{profile.nameRegions.length} 个 nameRegions</dd>
            </dl>
          ) : (
            <p className="muted">尚未读取到校准配置。</p>
          )}
        </div>

        <div className="info-panel">
          <h2>校准截图</h2>
          {snapshot?.samplePath ? (
            <dl>
              <dt>尺寸</dt>
              <dd>
                {snapshot.width} × {snapshot.height}
              </dd>
              <dt>样本</dt>
              <dd>{snapshot.samplePath}</dd>
            </dl>
          ) : (
            <p className="muted">没有当前截图，请先到校准页获取截图。</p>
          )}
        </div>
      </div>

      {sortedResults.length > 0 ? (
        <div className="ocr-result-list">
          {sortedResults.map((result) => (
            <article
              key={result.slot}
              className={`ocr-result-card ${changedSlots.includes(result.slot) ? "changed" : ""}`}
            >
              <header>
                <strong>slot {result.slot}</strong>
                <span className={`badge ${result.status}`}>
                  {result.status === "suspect" ? "疑似结果" : formatOcrStatus(result.status)}
                </span>
              </header>
              <dl>
                <dt>原始文本</dt>
                <dd>{result.rawText || "未识别到文本"}</dd>
                <dt>置信度</dt>
                <dd>{formatScore(result.confidence)}</dd>
                <dt>标准名称</dt>
                <dd>{result.matchedName || "未匹配"}</dd>
                <dt>匹配分</dt>
                <dd>{formatScore(result.matchScore * 100)}</dd>
                <dt>状态</dt>
                <dd>{result.message ?? formatOcrStatus(result.status)}</dd>
              </dl>
              {changedSlots.includes(result.slot) ? (
                <p className="slot-refresh-note">只刷新对应 slot</p>
              ) : null}
              <label className="manual-correction-field">
                人工修正
                <input
                  key={`${result.slot}-${result.matchedName}-${result.status}`}
                  list="hex-name-library"
                  defaultValue={result.matchedName}
                  onBlur={(event) => onManualCorrect(result.slot, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      onManualCorrect(result.slot, event.currentTarget.value);
                    }
                  }}
                  disabled={loading}
                />
              </label>
            </article>
          ))}
        </div>
      ) : (
        <section className="empty-state">
          <h2>等待 OCR</h2>
          <p>点击左侧按钮后，系统会逐个裁剪 slot1/2/3 的名称区域并识别。低置信度或低匹配分会标记为疑似结果。</p>
        </section>
      )}

      <datalist id="hex-name-library">
        {HEX_NAME_LIBRARY.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </section>
  );
}

function StateMachineWorkspace({
  player,
  loading,
  visualInput,
  slots,
  changedSlots,
  completedMilestones,
  pendingMilestoneQueue,
  status,
  ocrResults,
  events,
  onRefresh,
  onVisualInputChange,
  onSlotChange,
  onApplyOcrResults,
  onClearChangedSlots,
  onCompleteCurrentMilestone,
}: {
  player: LiveClientActivePlayerResult | null;
  loading: boolean;
  visualInput: VisualDetectionInput;
  slots: string[];
  changedSlots: number[];
  completedMilestones: number[];
  pendingMilestoneQueue: number[];
  status: StateMachineStatus;
  ocrResults: OcrSlotResult[];
  events: StateMachineEvent[];
  onRefresh: () => void;
  onVisualInputChange: (patch: Partial<VisualDetectionInput>) => void;
  onSlotChange: (slot: number, value: string) => void;
  onApplyOcrResults: () => void;
  onClearChangedSlots: () => void;
  onCompleteCurrentMilestone: () => void;
}) {
  const currentMilestone = pendingMilestoneQueue[0] ?? null;
  const canCompleteCurrentRound = Boolean(currentMilestone) && !visualInput.buttonVisible;
  const sortedOcrResults = ocrResults.slice().sort((left, right) => left.slot - right.slot);

  return (
    <section className="report-panel state-machine-workspace">
      <div className="report-header">
        <div>
          <h2>Stage 2D 本地接口与状态机 POC</h2>
          <p>
            读取本机 Live Client Data API 的英雄和等级，结合人工视觉输入与 Stage 2C OCR 名称演示海克斯选择状态机。
          </p>
        </div>
        <span className="report-id">Stage 2D</span>
      </div>

      <div className="overlay-note strong">
        这是 POC。视觉检测输入是人工开关；本页不新增进程扫描、窗口标题识别、Hook、内存读取、自动点击、自动选择或 ApexLOL 查询。
      </div>

      <div className="state-machine-summary">
        <div className="state-current-card">
          <span>当前状态</span>
          <strong>{status}</strong>
          <p>{formatStateMachineStatus(status)}</p>
        </div>

        <div className="state-status-grid">
          {STATE_MACHINE_STATUSES.map((item) => (
            <span key={item} className={`state-pill ${item === status ? "active" : ""}`}>
              {item}
            </span>
          ))}
        </div>
      </div>

      <div className="state-machine-grid">
        <section className="info-panel">
          <div className="panel-title-row">
            <h2>本地接口</h2>
            <button className="ghost-button compact-button" onClick={onRefresh} disabled={loading} type="button">
              {loading ? "刷新中..." : "刷新"}
            </button>
          </div>
          {player ? (
            <dl>
              <dt>available</dt>
              <dd>{formatBoolean(player.available)}</dd>
              <dt>英雄</dt>
              <dd>{player.championName ?? "-"}</dd>
              <dt>等级</dt>
              <dd>{player.level ?? "-"}</dd>
              <dt>耗时</dt>
              <dd>{player.durationMs}ms</dd>
              <dt>检查时间</dt>
              <dd>{formatDateTime(player.checkedAt)}</dd>
              <dt>error</dt>
              <dd>{player.error ?? "-"}</dd>
            </dl>
          ) : (
            <p className="muted">尚未刷新本地接口。默认不自动轮询，请手动刷新。</p>
          )}
        </section>

        <section className="info-panel">
          <h2>档位队列</h2>
          <dl>
            <dt>档位</dt>
            <dd>{AUGMENT_MILESTONES.join(" / ")}</dd>
            <dt>已完成</dt>
            <dd>{formatMilestoneQueue(completedMilestones)}</dd>
            <dt>待处理</dt>
            <dd>{formatMilestoneQueue(pendingMilestoneQueue)}</dd>
            <dt>当前轮</dt>
            <dd>{currentMilestone ? `${currentMilestone} 级` : "-"}</dd>
          </dl>
          <button
            className="secondary-button inline-action"
            onClick={onCompleteCurrentMilestone}
            disabled={!canCompleteCurrentRound}
            type="button"
          >
            标记当前轮完成
          </button>
          <p className="muted">
            按钮仍存在时不能标记完成；卡片消失不等于完成，只有按钮消失才允许阶段结束。
          </p>
        </section>
      </div>

      <section className="state-machine-grid">
        <div className="info-panel">
          <h2>人工视觉检测输入</h2>
          <div className="toggle-grid">
            <button
              className={`toggle-button ${visualInput.buttonVisible ? "active" : ""}`}
              onClick={() => onVisualInputChange({ buttonVisible: true })}
              type="button"
            >
              按钮存在
            </button>
            <button
              className={`toggle-button ${!visualInput.buttonVisible ? "active" : ""}`}
              onClick={() => onVisualInputChange({ buttonVisible: false })}
              type="button"
            >
              按钮不存在
            </button>
            <button
              className={`toggle-button ${!visualInput.cardsExpanded ? "active" : ""}`}
              onClick={() => onVisualInputChange({ cardsExpanded: false })}
              type="button"
            >
              卡片收起
            </button>
            <button
              className={`toggle-button ${visualInput.cardsExpanded ? "active" : ""}`}
              onClick={() => onVisualInputChange({ cardsExpanded: true })}
              type="button"
            >
              卡片展开
            </button>
          </div>
          <p className="muted">
            按钮存在且卡片收起会提示隐藏 Overlay 且不标记完成；按钮存在且卡片展开时允许使用三 slot 名称。
          </p>
        </div>

        <div className="info-panel">
          <div className="panel-title-row">
            <h2>三 slot 名称</h2>
            <button className="ghost-button compact-button" onClick={onApplyOcrResults} type="button">
              读取 OCR
            </button>
          </div>
          {sortedOcrResults.length > 0 ? (
            <p className="muted">可读取 Stage 2C 当前 OCR 结果；名称变化只标记变化 slot，不重置整个阶段。</p>
          ) : (
            <p className="muted">当前没有 Stage 2C OCR 结果，可直接手动输入三 slot 名称。</p>
          )}
          <div className="slot-input-grid">
            {[1, 2, 3].map((slot) => (
              <label key={slot} className={`slot-input ${changedSlots.includes(slot) ? "changed" : ""}`}>
                <span>slot {slot}</span>
                <input
                  value={slots[slot - 1] ?? ""}
                  onChange={(event) => onSlotChange(slot, event.currentTarget.value)}
                  placeholder="手动输入海克斯名称"
                />
              </label>
            ))}
          </div>
          {changedSlots.length > 0 ? (
            <div className="slot-change-actions">
              <span>变化 slot：{changedSlots.join("、")}</span>
              <button className="ghost-button compact-button" onClick={onClearChangedSlots} type="button">
                清除标记
              </button>
            </div>
          ) : null}
        </div>
      </section>

      <section className="info-panel">
        <h2>状态机规则说明</h2>
        <ul className="rule-list">
          <li>接口 unavailable 或等级低于 3：保持普通监听。</li>
          <li>有待处理档位且按钮不存在：进入可触发状态。</li>
          <li>按钮存在且卡片收起：认为入口折叠，提示隐藏 Overlay，不标记完成。</li>
          <li>按钮存在且卡片展开：进入展开状态，可使用三 slot 名称。</li>
          <li>点击“标记当前轮完成”只移除队列首个档位；多档位会按 3、7、11、15 依次处理。</li>
        </ul>
      </section>

      <section className="info-panel">
        <h2>事件日志</h2>
        {events.length > 0 ? (
          <ol className="event-list">
            {events.map((event) => (
              <li key={event.id}>
                <time>{event.time}</time>
                <span>{event.message}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">暂无事件。刷新接口、状态变化、队列变化和 slot 变化都会记录。</p>
        )}
      </section>
    </section>
  );
}

function EnvironmentView({
  environment,
  targets,
}: {
  environment: EnvironmentSnapshot | null;
  targets: CaptureTarget[];
}) {
  return (
    <section className="info-grid">
      <div className="info-panel">
        <h2>运行环境</h2>
        {environment ? (
          <dl>
            <dt>系统</dt>
            <dd>{environment.os}</dd>
            <dt>目标</dt>
            <dd>
              {environment.rustTargetOs} / {environment.rustTargetArch}
            </dd>
            <dt>数据目录</dt>
            <dd>{environment.appDataDir}</dd>
          </dl>
        ) : (
          <p className="muted">等待读取环境信息。</p>
        )}
      </div>

      <div className="info-panel">
        <h2>诊断范围</h2>
        <p className="muted">当前版本只使用显示器级截图。</p>
        <p className="metric-line">显示器数量：{targets.filter((target) => target.kind === "monitor").length}</p>
      </div>

      <div className="info-panel">
        <h2>可见目标</h2>
        <p className="metric-line">已枚举 {targets.length} 个可用目标。</p>
        <div className="target-scroll">
          {targets.slice(0, 12).map((item) => (
            <div key={`${item.kind}-${item.id}-${item.label}`} className="target-row">
              <span>{item.label}</span>
              <small>
                {item.kind}
                {item.bounds ? ` · ${item.bounds.width}x${item.bounds.height}` : ""}
              </small>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CalibrationWorkspace({
  snapshot,
  profile,
  regions,
  activeRegionKey,
  error,
  message,
  onActiveRegionChange,
  onRegionChange,
  onClearAll,
  onReloadProfile,
}: {
  snapshot: CalibrationSnapshotResult | null;
  profile: CalibrationProfile | null;
  regions: RegionMap;
  activeRegionKey: RegionKey;
  error: string | null;
  message: string | null;
  onActiveRegionChange: (key: RegionKey) => void;
  onRegionChange: (key: RegionKey, region: RatioRegion | null) => void;
  onClearAll: () => void;
  onReloadProfile: () => void;
}) {
  const [dragSelection, setDragSelection] = useState<DragSelection | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const width = snapshot?.width ?? profile?.screenshotWidth ?? 1920;
  const height = snapshot?.height ?? profile?.screenshotHeight ?? 1080;
  const imageSrc = snapshot?.samplePath ? convertFileSrc(snapshot.samplePath) : null;
  const activeDefinition = REGION_DEFINITIONS.find((definition) => definition.key === activeRegionKey);
  const selectedCount = REGION_DEFINITIONS.filter((definition) => regions[definition.key]).length;
  const visibleRegions = dragSelection
    ? {
        ...regions,
        [dragSelection.key]: normalizeSelection(dragSelection),
      }
    : regions;

  useEffect(() => {
    setImageFailed(false);
  }, [snapshot?.samplePath]);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!snapshot && !profile) {
      return;
    }
    const point = pointFromPointer(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragSelection({
      key: activeRegionKey,
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
    });
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragSelection) {
      return;
    }
    const point = pointFromPointer(event);
    setDragSelection((current) =>
      current
        ? {
            ...current,
            currentX: point.x,
            currentY: point.y,
          }
        : current,
    );
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragSelection) {
      return;
    }
    const point = pointFromPointer(event);
    const completed = normalizeSelection({
      ...dragSelection,
      currentX: point.x,
      currentY: point.y,
    });
    setDragSelection(null);
    if (completed.widthRatio < 0.002 || completed.heightRatio < 0.002) {
      return;
    }
    onRegionChange(dragSelection.key, completed);
  }

  return (
    <section className="calibration-panel">
      <div className="calibration-header">
        <div>
          <h2>校准工作区</h2>
          <p>
            当前区域：{activeDefinition?.label ?? "-"}，已完成 {selectedCount}/{REGION_DEFINITIONS.length} 个区域。
          </p>
        </div>
        <div className="calibration-actions">
          <button className="ghost-button" onClick={() => onRegionChange(activeRegionKey, null)} type="button">
            重选当前区域
          </button>
          <button className="ghost-button" onClick={onClearAll} type="button">
            清空区域
          </button>
          <button className="ghost-button" onClick={onReloadProfile} type="button">
            读取已有配置
          </button>
        </div>
      </div>

      {error ? <div className="error-strip">{error}</div> : null}
      {message ? <div className="success-strip">{message}</div> : null}

      <div className="calibration-layout">
        <div className="preview-section">
          <div className="preview-meta">
            <span>
              截图尺寸：{width} × {height}
            </span>
            <span>样本路径：{snapshot?.samplePath ?? "尚未保存样本"}</span>
          </div>

          <div
            className="calibration-preview"
            style={{ aspectRatio: `${width} / ${height}` }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => setDragSelection(null)}
          >
            {imageSrc && !imageFailed ? (
              <img
                src={imageSrc}
                alt="校准截图预览"
                draggable={false}
                onLoad={() => setImageFailed(false)}
                onError={() => setImageFailed(true)}
              />
            ) : (
              <div className="preview-placeholder">
                <strong>{snapshot ? "无法直接预览本地样本" : "等待校准截图"}</strong>
                <span>
                  {snapshot
                    ? "当前环境未能通过本地文件协议显示截图，仍可按截图尺寸使用占位预览框选。"
                    : "获取截图后会按返回尺寸显示预览区域。"}
                </span>
              </div>
            )}

            {REGION_DEFINITIONS.map((definition) => {
              const region = visibleRegions[definition.key];
              if (!region) {
                return null;
              }
              return (
                <div
                  key={definition.key}
                  className={`region-box ${definition.key === activeRegionKey ? "active" : ""}`}
                  style={regionToStyle(region)}
                >
                  <span>{definition.label}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="region-panel">
          <h3>区域列表</h3>
          <div className="region-list">
            {REGION_DEFINITIONS.map((definition) => {
              const region = regions[definition.key];
              return (
                <button
                  key={definition.key}
                  className={`region-item ${definition.key === activeRegionKey ? "selected" : ""}`}
                  onClick={() => onActiveRegionChange(definition.key)}
                  type="button"
                >
                  <span>
                    <strong>{definition.label}</strong>
                    <small>{definition.summary}</small>
                  </span>
                  <em>{region ? formatRegion(region) : "未框选"}</em>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {profile ? <CalibrationProfileSummary profile={profile} /> : null}
    </section>
  );
}

function CalibrationProfileSummary({ profile }: { profile: CalibrationProfile }) {
  return (
    <section className="profile-summary">
      <div>
        <h2>已有配置</h2>
        <p>
          {profile.profileName} · {profile.monitorName} · {profile.screenshotWidth}×{profile.screenshotHeight}
        </p>
        <p>
          语言：{profile.language}；显示说明：{profile.displayModeNote ?? "未填写"}；Overlay：间距 {profile.overlay.gap}，
          最大高度 {profile.overlay.maxHeight}，隐藏延迟 {profile.overlay.autoHideAfterMissingMs}ms
        </p>
      </div>
      <div className="profile-region-grid">
        {profile.nameRegions.map((region) => (
          <span key={`name-${region.slot}`}>名称 slot{region.slot}：{formatRegion(region)}</span>
        ))}
        {profile.bottomAnchors.map((region) => (
          <span key={`anchor-${region.slot}`}>锚点 slot{region.slot}：{formatRegion(region)}</span>
        ))}
        <span>展开按钮：{formatRegion(profile.toggleButtonRegion)}</span>
      </div>
    </section>
  );
}

function ReportView({ report }: { report: DiagnosticReport }) {
  return (
    <section className="report-panel">
      <div className="report-header">
        <div>
          <h2>诊断结果</h2>
          <p>{report.summary}</p>
        </div>
        <span className="report-id">{report.id}</span>
      </div>

      <div className="attempt-list">
        {report.attempts.map((attempt) => (
          <article key={attempt.strategy} className="attempt-item">
            <header>
              <strong>{attempt.strategy}</strong>
              <span className={attempt.status === "success" ? "badge success" : "badge failed"}>
                {attempt.status === "success" ? "成功" : "失败"}
              </span>
            </header>
            <dl>
              <dt>目标</dt>
              <dd>{attempt.targetLabel}</dd>
              <dt>耗时</dt>
              <dd>{attempt.durationMs}ms</dd>
              <dt>尺寸</dt>
              <dd>{attempt.width && attempt.height ? `${attempt.width} × ${attempt.height}` : "-"}</dd>
              <dt>黑屏判断</dt>
              <dd>
                {attempt.blackScreenSuspected == null
                  ? "-"
                  : attempt.blackScreenSuspected
                    ? "疑似黑屏"
                    : "未疑似黑屏"}
              </dd>
              <dt>样本</dt>
              <dd>{attempt.savedPath ?? "-"}</dd>
            </dl>
            {attempt.metrics ? (
              <div className="metrics">
                <span>平均亮度 {attempt.metrics.averageLuma.toFixed(2)}</span>
                <span>方差 {attempt.metrics.lumaVariance.toFixed(2)}</span>
                <span>近黑像素 {(attempt.metrics.nearBlackRatio * 100).toFixed(2)}%</span>
              </div>
            ) : null}
            {attempt.error ? <p className="attempt-error">{attempt.error}</p> : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function EmptyState() {
  return (
    <section className="empty-state">
      <h2>等待诊断</h2>
      <p>运行前请把目标画面切到要测试的显示模式。全屏测试建议使用延迟截图。</p>
    </section>
  );
}

function OverlayPocPage() {
  const [state, setState] = useState<OverlayStoredState>(() => readOverlayState() ?? defaultOverlayState());

  useEffect(() => {
    document.documentElement.classList.add("overlay-document");

    function refreshOverlayState() {
      setState(readOverlayState() ?? defaultOverlayState());
    }

    refreshOverlayState();
    window.addEventListener("storage", refreshOverlayState);
    window.addEventListener("resize", refreshOverlayState);
    const timer = window.setInterval(refreshOverlayState, 500);

    return () => {
      document.documentElement.classList.remove("overlay-document");
      window.removeEventListener("storage", refreshOverlayState);
      window.removeEventListener("resize", refreshOverlayState);
      window.clearInterval(timer);
    };
  }, []);

  return (
    <main className="overlay-root" aria-label="Overlay POC 测试卡片">
      {state.cards
        .slice()
        .sort((left, right) => left.slot - right.slot)
        .map((card) => (
          <article key={card.slot} className="overlay-card" style={rectToAbsoluteStyle(card.bounds)}>
            <div className="overlay-card-rating">评级占位 {ratingPlaceholder(card.slot)}</div>
            <h1>英雄占位 × 海克斯占位</h1>
            <p>{card.body || "当前仅用于验证 Overlay 可见性与位置，不做自动选择。"}</p>
            <span>数据来源占位：{card.source}</span>
          </article>
        ))}
    </main>
  );
}

function buildOcrResult(slot: number, rawText: string, confidence: number): OcrSlotResult {
  const cleanRawText = rawText.replace(/\s+/g, " ").trim();
  const match = matchHexName(cleanRawText);
  const status =
    confidence < OCR_CONFIDENCE_THRESHOLD || match.score < OCR_MATCH_THRESHOLD ? "suspect" : "recognized";

  return {
    slot,
    rawText: cleanRawText,
    confidence: Math.max(0, confidence || 0),
    matchedName: match.name,
    matchScore: match.score,
    status,
    message:
      status === "suspect"
        ? "疑似结果，需要人工确认或修正"
        : "已通过词库匹配",
  };
}

function matchHexName(rawText: string) {
  const normalizedRawText = normalizeOcrText(rawText);
  if (!normalizedRawText) {
    return { name: "", score: 0 };
  }

  return HEX_NAME_LIBRARY.map((name) => {
    const normalizedName = normalizeOcrText(name);
    const distanceScore = similarityScore(normalizedRawText, normalizedName);
    const containsScore =
      normalizedRawText.includes(normalizedName) || normalizedName.includes(normalizedRawText) ? 0.94 : 0;
    return {
      name,
      score: Math.max(distanceScore, containsScore),
    };
  }).reduce((best, current) => (current.score > best.score ? current : best), {
    name: "",
    score: 0,
  });
}

function normalizeOcrText(value: string) {
  return value
    .replace(/[^\p{Script=Han}a-zA-Z0-9]/gu, "")
    .replace(/[〇○]/g, "零")
    .trim()
    .toLowerCase();
}

function similarityScore(left: string, right: string) {
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

function levenshteinDistance(left: string[], right: string[]) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array<number>(right.length + 1);

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

function loadImageElement(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取当前校准截图。"));
    image.src = src;
  });
}

function cropRegionToCanvas(image: HTMLImageElement, region: SlottedRatioRegion) {
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  const sourceX = Math.round(region.xRatio * naturalWidth);
  const sourceY = Math.round(region.yRatio * naturalHeight);
  const sourceWidth = Math.max(1, Math.round(region.widthRatio * naturalWidth));
  const sourceHeight = Math.max(1, Math.round(region.heightRatio * naturalHeight));
  const scale = sourceWidth < 260 ? 2 : 1;
  const canvas = document.createElement("canvas");
  canvas.width = sourceWidth * scale;
  canvas.height = sourceHeight * scale;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("当前环境无法创建 OCR 裁剪画布。");
  }

  context.imageSmoothingEnabled = false;
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function pointFromPointer(event: React.PointerEvent<HTMLDivElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left) / rect.width),
    y: clamp((event.clientY - rect.top) / rect.height),
  };
}

function normalizeSelection(selection: DragSelection): RatioRegion {
  const xRatio = Math.min(selection.startX, selection.currentX);
  const yRatio = Math.min(selection.startY, selection.currentY);
  const widthRatio = Math.abs(selection.currentX - selection.startX);
  const heightRatio = Math.abs(selection.currentY - selection.startY);
  return {
    xRatio: roundRatio(xRatio),
    yRatio: roundRatio(yRatio),
    widthRatio: roundRatio(widthRatio),
    heightRatio: roundRatio(heightRatio),
  };
}

function profileToRegions(profile: CalibrationProfile): RegionMap {
  return {
    "name-1": profile.nameRegions.find((region) => region.slot === 1) ?? null,
    "name-2": profile.nameRegions.find((region) => region.slot === 2) ?? null,
    "name-3": profile.nameRegions.find((region) => region.slot === 3) ?? null,
    "anchor-1": profile.bottomAnchors.find((region) => region.slot === 1) ?? null,
    "anchor-2": profile.bottomAnchors.find((region) => region.slot === 2) ?? null,
    "anchor-3": profile.bottomAnchors.find((region) => region.slot === 3) ?? null,
    toggle: profile.toggleButtonRegion,
  };
}

function buildSlottedRegions(regions: RegionMap, group: "name" | "anchor"): SlottedRatioRegion[] {
  return REGION_DEFINITIONS.filter((definition) => definition.group === group)
    .map((definition) => {
      const region = regions[definition.key];
      if (!region || !definition.slot) {
        return null;
      }
      return {
        slot: definition.slot,
        ...region,
      };
    })
    .filter((region): region is SlottedRatioRegion => Boolean(region));
}

function allRegionsSelected(regions: RegionMap) {
  return REGION_DEFINITIONS.every((definition) => Boolean(regions[definition.key]));
}

function buildPendingMilestoneQueue(
  player: LiveClientActivePlayerResult | null,
  completedMilestones: number[],
) {
  if (!player?.available || !player.level) {
    return [];
  }
  return AUGMENT_MILESTONES.filter(
    (milestone) => player.level !== null && player.level !== undefined && milestone <= player.level,
  ).filter((milestone) => !completedMilestones.includes(milestone));
}

function deriveStateMachineStatus(
  player: LiveClientActivePlayerResult | null,
  pendingMilestoneQueue: number[],
  completedMilestones: number[],
  visualInput: VisualDetectionInput,
): StateMachineStatus {
  if (!player?.available || !player.level || player.level < 3) {
    return "IN_GAME_MONITORING";
  }
  if (pendingMilestoneQueue.length === 0) {
    const allMilestonesCompleted = AUGMENT_MILESTONES.every((milestone) => completedMilestones.includes(milestone));
    return allMilestonesCompleted ? "AUGMENT_STAGE_COMPLETED" : "AUGMENT_ROUND_COMPLETED";
  }
  if (!visualInput.buttonVisible) {
    return "AUGMENT_ELIGIBLE";
  }
  if (visualInput.cardsExpanded) {
    return "AUGMENT_EXPANDED";
  }
  return "AUGMENT_COLLAPSED";
}

function regionToStyle(region: RatioRegion): React.CSSProperties {
  return {
    left: `${region.xRatio * 100}%`,
    top: `${region.yRatio * 100}%`,
    width: `${region.widthRatio * 100}%`,
    height: `${region.heightRatio * 100}%`,
  };
}

function formatRegion(region: RatioRegion) {
  return `${region.xRatio.toFixed(4)}, ${region.yRatio.toFixed(4)}, ${region.widthRatio.toFixed(4)}, ${region.heightRatio.toFixed(4)}`;
}

function formatRect(rect: RectInfo) {
  return `x=${rect.x}, y=${rect.y}, w=${rect.width}, h=${rect.height}`;
}

function formatBoolean(value: boolean) {
  return value ? "是" : "否";
}

function formatOcrStatus(status: OcrSlotStatus) {
  if (status === "recognized") {
    return "已匹配";
  }
  if (status === "manual") {
    return "人工修正";
  }
  if (status === "failed") {
    return "失败";
  }
  if (status === "pending") {
    return "等待";
  }
  return "疑似结果";
}

function formatStateMachineStatus(status: StateMachineStatus) {
  switch (status) {
    case "IN_GAME_MONITORING":
      return "普通监听：接口不可用、未进入游戏或等级低于 3。";
    case "AUGMENT_ELIGIBLE":
      return "有待处理档位，但按钮当前不存在，等待人工确认入口出现。";
    case "AUGMENT_STAGE_ACTIVE":
      return "海克斯阶段已激活。";
    case "AUGMENT_COLLAPSED":
      return "按钮存在且卡片收起：应隐藏 Overlay，不标记完成。";
    case "AUGMENT_EXPANDED":
      return "按钮存在且卡片展开：可以使用三 slot 名称。";
    case "AUGMENT_ROUND_COMPLETED":
      return "当前等级已触发的档位都已完成，继续监听后续等级。";
    case "AUGMENT_STAGE_COMPLETED":
      return "3、7、11、15 四个档位都已完成。";
    default:
      return status;
  }
}

function formatMilestoneQueue(values: number[]) {
  return values.length > 0 ? values.map((value) => `${value} 级`).join(" -> ") : "无";
}

function formatDateTime(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString("zh-CN", { hour12: false });
}

function formatScore(value: number) {
  return Number.isFinite(value) ? value.toFixed(1) : "0.0";
}

function rectToAbsoluteStyle(rect: RectInfo): React.CSSProperties {
  return {
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

function ratingPlaceholder(slot: number) {
  return ["夯爆了", "顶级", "人上人"][slot - 1] ?? "评级占位";
}

function writeOverlayState(result: OverlayPocResult) {
  const state: OverlayStoredState = {
    updatedAt: new Date().toISOString(),
    label: result.label,
    target: result.target,
    cards: result.cards,
  };
  window.localStorage.setItem(OVERLAY_STORAGE_KEY, JSON.stringify(state));
}

function readOverlayState(): OverlayStoredState | null {
  try {
    const raw = window.localStorage.getItem(OVERLAY_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as OverlayStoredState;
    if (!Array.isArray(parsed.cards) || !parsed.target) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function defaultOverlayState(): OverlayStoredState {
  const width = Math.max(window.innerWidth || 1280, 1);
  const height = Math.max(window.innerHeight || 720, 1);
  return {
    updatedAt: new Date().toISOString(),
    label: "overlay-poc",
    target: {
      monitorId: null,
      monitorName: null,
      source: "frontend.defaultCards",
      bounds: { x: 0, y: 0, width, height },
      logicalBounds: { x: 0, y: 0, width, height },
      scaleFactor: 1,
    },
    cards: defaultOverlayCards(width, height),
  };
}

function defaultOverlayCards(width: number, height: number): OverlayPocCardInfo[] {
  const gap = 24;
  const horizontalPadding = 36;
  const availableWidth = Math.max(width - horizontalPadding * 2 - gap * 2, 240);
  const cardWidth = Math.max(120, Math.min(300, Math.floor(availableWidth / 3)));
  const cardHeight = 118;
  const totalWidth = cardWidth * 3 + gap * 2;
  const startX = Math.max(12, Math.floor((width - totalWidth) / 2));
  const top = Math.max(24, height - cardHeight - 80);

  return [1, 2, 3].map((slot, index) => ({
    slot,
    title: `测试卡片 ${slot}`,
    body: "当前仅用于验证 Overlay 可见性与位置，不做 OCR、不查询 ApexLOL。",
    bounds: {
      x: startX + index * (cardWidth + gap),
      y: top,
      width: cardWidth,
      height: cardHeight,
    },
    source: "frontend.defaultCards",
  }));
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

function roundRatio(value: number) {
  return Math.round(clamp(value) * 10000) / 10000;
}

const query = new URLSearchParams(window.location.search);
const isOverlayView = query.get("view") === "overlay";

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isOverlayView ? <OverlayPocPage /> : <App />}
  </React.StrictMode>,
);
