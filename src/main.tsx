import React, { useEffect, useMemo, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { createRoot } from "react-dom/client";
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

type Mode = "diagnostic" | "calibration";
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
          </div>
          <button
            className="ghost-button"
            onClick={refresh}
            disabled={loading || calibrationLoading || calibrationSaving}
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

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

function roundRatio(value: number) {
  return Math.round(clamp(value) * 10000) / 10000;
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
