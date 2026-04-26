import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
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

function App() {
  const [saveSamples, setSaveSamples] = useState(true);
  const [delaySeconds, setDelaySeconds] = useState(8);
  const [environment, setEnvironment] = useState<EnvironmentSnapshot | null>(null);
  const [targets, setTargets] = useState<CaptureTarget[]>([]);
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setError(null);
    try {
      const [env, captureTargets] = await Promise.all([
        invoke<EnvironmentSnapshot>("get_environment_snapshot"),
        invoke<CaptureTarget[]>("list_capture_targets"),
      ]);
      setEnvironment(env);
      setTargets(captureTargets);
    } catch (err) {
      setError(String(err));
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

  return (
    <main className="app-shell">
      <section className="top-bar">
        <div>
          <h1>屏幕截图诊断工具</h1>
          <p>第一阶段只验证目标画面在全屏、无边框、窗口模式下能否稳定截图，并导出日志和样本。</p>
        </div>
        <button className="ghost-button" onClick={refresh} disabled={loading}>
          刷新环境
        </button>
      </section>

      {error ? <div className="error-strip">{error}</div> : null}

      <section className="workspace">
        <aside className="control-panel">
          <h2>诊断目标</h2>
          <div className="target-option selected static-target">
            <span>
              <strong>主显示器</strong>
              <small>只做显示器级截图，不扫描进程，不按窗口标题查找目标。</small>
            </span>
          </div>

          <label className="check-row">
            <input
              type="checkbox"
              checked={saveSamples}
              onChange={(event) => setSaveSamples(event.currentTarget.checked)}
            />
            保存截图样本
          </label>

          <div className="delay-field">
            <label htmlFor="delaySeconds">延迟截图</label>
            <select
              id="delaySeconds"
              value={delaySeconds}
              onChange={(event) => setDelaySeconds(Number(event.currentTarget.value))}
              disabled={loading}
            >
              <option value={0}>立即</option>
              <option value={5}>5 秒</option>
              <option value={8}>8 秒</option>
              <option value={12}>12 秒</option>
              <option value={20}>20 秒</option>
            </select>
            <small>全屏测试时点击诊断后立刻切回目标画面，等待自动截图。</small>
          </div>

          <button className="primary-button" onClick={runDiagnostic} disabled={loading}>
            {loading
              ? delaySeconds > 0
                ? `等待 ${delaySeconds} 秒后截图...`
                : "诊断中..."
              : "运行截图诊断"}
          </button>

          {report ? (
            <div className="export-box">
              <strong>导出位置</strong>
              <span>{report.reportDir}</span>
              <span>日志：{report.logPath}</span>
              <span>JSON：{report.jsonPath}</span>
            </div>
          ) : null}
        </aside>

        <section className="content-panel">
          <EnvironmentView environment={environment} targets={targets} />
          {report ? <ReportView report={report} /> : <EmptyState />}
        </section>
      </section>
    </main>
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
        <p className="muted">当前版本只枚举显示器并执行显示器截图，不读取游戏进程列表，不枚举窗口标题。</p>
        <p className="metric-line">显示器数量：{targets.length}</p>
      </div>

      <div className="info-panel">
        <h2>可见目标</h2>
        <p className="metric-line">已枚举 {targets.length} 个显示器/窗口。</p>
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
              <dd>
                {attempt.width && attempt.height ? `${attempt.width} × ${attempt.height}` : "-"}
              </dd>
              <dt>黑屏判断</dt>
              <dd>{attempt.blackScreenSuspected == null ? "-" : attempt.blackScreenSuspected ? "疑似黑屏" : "未疑似黑屏"}</dd>
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

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
