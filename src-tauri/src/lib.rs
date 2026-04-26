use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::time::Instant;
use std::{
    fs,
    path::{Path, PathBuf},
};
use sysinfo::System;
use tauri::{AppHandle, Manager};

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    pub target: CaptureTargetKind,
    pub save_samples: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub enum CaptureTargetKind {
    PrimaryMonitor,
    LolWindow,
    ForegroundWindow,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTarget {
    pub kind: String,
    pub id: String,
    pub label: String,
    pub bounds: Option<RectInfo>,
    pub is_lol_candidate: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RectInfo {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: String,
    pub name: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentSnapshot {
    pub os: String,
    pub arch: String,
    pub family: String,
    pub app_data_dir: String,
    pub rust_target_os: String,
    pub rust_target_arch: String,
    pub lol_processes: Vec<ProcessInfo>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PixelMetrics {
    pub average_luma: f64,
    pub luma_variance: f64,
    pub near_black_ratio: f64,
    pub sampled_pixels: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CaptureAttempt {
    pub strategy: String,
    pub target_label: String,
    pub started_at: DateTime<Utc>,
    pub duration_ms: u128,
    pub status: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub saved_path: Option<String>,
    pub image_hash: Option<String>,
    pub black_screen_suspected: Option<bool>,
    pub metrics: Option<PixelMetrics>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReport {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub request: CaptureRequest,
    pub environment: EnvironmentSnapshot,
    pub targets: Vec<CaptureTarget>,
    pub attempts: Vec<CaptureAttempt>,
    pub summary: String,
    pub report_dir: String,
    pub log_path: String,
    pub json_path: String,
}

#[tauri::command]
fn get_environment_snapshot(app: AppHandle) -> Result<EnvironmentSnapshot, String> {
    let app_data_dir = app_data_dir(&app)?;
    Ok(environment_snapshot(&app_data_dir))
}

#[tauri::command]
fn list_capture_targets() -> Result<Vec<CaptureTarget>, String> {
    Ok(platform::list_capture_targets())
}

#[tauri::command]
fn run_capture_diagnostic(
    app: AppHandle,
    request: CaptureRequest,
) -> Result<DiagnosticReport, String> {
    let base_dir = app_data_dir(&app)?;
    let id = Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let report_dir = base_dir.join("diagnostics").join(&id);
    fs::create_dir_all(&report_dir).map_err(|err| err.to_string())?;

    let environment = environment_snapshot(&base_dir);
    let targets = platform::list_capture_targets();
    let attempts = platform::run_capture_diagnostic(&request, &report_dir);
    let summary = summarize_attempts(&attempts);

    let mut report = DiagnosticReport {
        id,
        created_at: Utc::now(),
        request,
        environment,
        targets,
        attempts,
        summary,
        report_dir: report_dir.display().to_string(),
        log_path: String::new(),
        json_path: String::new(),
    };

    let log_path = report_dir.join("diagnostic.log");
    let json_path = report_dir.join("diagnostic.json");
    report.log_path = log_path.display().to_string();
    report.json_path = json_path.display().to_string();

    fs::write(&log_path, render_log(&report)).map_err(|err| err.to_string())?;
    fs::write(
        &json_path,
        serde_json::to_string_pretty(&report).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())?;

    Ok(report)
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_environment_snapshot,
            list_capture_targets,
            run_capture_diagnostic
        ])
        .run(tauri::generate_context!())
        .expect("启动 LOL 海克斯乱斗助手截图诊断失败");
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|err| err.to_string())
}

fn environment_snapshot(app_data_dir: &Path) -> EnvironmentSnapshot {
    let os = os_info::get();
    EnvironmentSnapshot {
        os: os.to_string(),
        arch: os.architecture().unwrap_or("unknown").to_string(),
        family: std::env::consts::FAMILY.to_string(),
        app_data_dir: app_data_dir.display().to_string(),
        rust_target_os: std::env::consts::OS.to_string(),
        rust_target_arch: std::env::consts::ARCH.to_string(),
        lol_processes: detect_lol_processes(),
    }
}

fn detect_lol_processes() -> Vec<ProcessInfo> {
    let mut system = System::new_all();
    system.refresh_processes();

    let mut processes: Vec<ProcessInfo> = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            let name = process.name().to_string();
            let lower = name.to_lowercase();
            let is_lol = lower.contains("league")
                || lower.contains("riot")
                || lower.contains("lol")
                || lower.contains("英雄联盟");
            is_lol.then(|| ProcessInfo {
                pid: pid.to_string(),
                name,
            })
        })
        .collect();

    processes.sort_by(|a, b| a.name.cmp(&b.name));
    processes
}

fn summarize_attempts(attempts: &[CaptureAttempt]) -> String {
    if attempts.iter().any(|attempt| attempt.status == "success") {
        let black_count = attempts
            .iter()
            .filter(|attempt| attempt.black_screen_suspected == Some(true))
            .count();
        if black_count > 0 {
            format!(
                "有截图策略成功，但 {} 个结果疑似黑屏，请优先查看样本图。",
                black_count
            )
        } else {
            "至少一个截图策略成功，未发现明显黑屏。".to_string()
        }
    } else {
        "所有截图策略均失败或在当前平台不可用。".to_string()
    }
}

fn render_log(report: &DiagnosticReport) -> String {
    let mut lines = Vec::new();
    lines.push(format!("诊断编号: {}", report.id));
    lines.push(format!("生成时间: {}", report.created_at));
    lines.push(format!("目标: {:?}", report.request.target));
    lines.push(format!("保存样本: {}", report.request.save_samples));
    lines.push(String::new());
    lines.push("[环境]".to_string());
    lines.push(format!("OS: {}", report.environment.os));
    lines.push(format!("架构: {}", report.environment.arch));
    lines.push(format!(
        "Rust target: {}-{}",
        report.environment.rust_target_os, report.environment.rust_target_arch
    ));
    lines.push(format!("应用数据目录: {}", report.environment.app_data_dir));
    lines.push(format!(
        "LOL/Riot 相关进程数: {}",
        report.environment.lol_processes.len()
    ));
    for process in &report.environment.lol_processes {
        lines.push(format!("  - pid={} name={}", process.pid, process.name));
    }
    lines.push(String::new());
    lines.push("[捕获目标]".to_string());
    for target in &report.targets {
        lines.push(format!(
            "  - kind={} id={} label={} bounds={:?} lol_candidate={}",
            target.kind, target.id, target.label, target.bounds, target.is_lol_candidate
        ));
    }
    lines.push(String::new());
    lines.push("[截图尝试]".to_string());
    for attempt in &report.attempts {
        lines.push(format!(
            "  - strategy={} target={} status={} duration={}ms",
            attempt.strategy, attempt.target_label, attempt.status, attempt.duration_ms
        ));
        lines.push(format!(
            "    size={:?}x{:?} black={:?} hash={:?}",
            attempt.width, attempt.height, attempt.black_screen_suspected, attempt.image_hash
        ));
        if let Some(metrics) = &attempt.metrics {
            lines.push(format!(
                "    metrics average_luma={:.2} variance={:.2} near_black_ratio={:.4} sampled_pixels={}",
                metrics.average_luma, metrics.luma_variance, metrics.near_black_ratio, metrics.sampled_pixels
            ));
        }
        if let Some(path) = &attempt.saved_path {
            lines.push(format!("    saved_path={}", path));
        }
        if let Some(error) = &attempt.error {
            lines.push(format!("    error={}", error));
        }
    }
    lines.push(String::new());
    lines.push(format!("[结论] {}", report.summary));
    lines.join("\n")
}

#[cfg(windows)]
fn build_attempt<F>(
    strategy: &str,
    target_label: &str,
    save_path: Option<PathBuf>,
    capture: F,
) -> CaptureAttempt
where
    F: FnOnce(Option<&Path>) -> Result<CapturedImage, String>,
{
    let started_at = Utc::now();
    let start = Instant::now();
    match capture(save_path.as_deref()) {
        Ok(image) => {
            let metrics = calculate_metrics(&image.rgba);
            let black_screen_suspected = metrics.average_luma < 8.0
                || (metrics.near_black_ratio > 0.985 && metrics.luma_variance < 20.0);
            CaptureAttempt {
                strategy: strategy.to_string(),
                target_label: target_label.to_string(),
                started_at,
                duration_ms: start.elapsed().as_millis(),
                status: "success".to_string(),
                width: Some(image.width),
                height: Some(image.height),
                saved_path: image.saved_path.map(|path| path.display().to_string()),
                image_hash: Some(hash_bytes(&image.rgba)),
                black_screen_suspected: Some(black_screen_suspected),
                metrics: Some(metrics),
                error: None,
            }
        }
        Err(error) => CaptureAttempt {
            strategy: strategy.to_string(),
            target_label: target_label.to_string(),
            started_at,
            duration_ms: start.elapsed().as_millis(),
            status: "failed".to_string(),
            width: None,
            height: None,
            saved_path: None,
            image_hash: None,
            black_screen_suspected: None,
            metrics: None,
            error: Some(error),
        },
    }
}

fn failed_attempt(
    strategy: &str,
    target_label: &str,
    message: impl Into<String>,
) -> CaptureAttempt {
    CaptureAttempt {
        strategy: strategy.to_string(),
        target_label: target_label.to_string(),
        started_at: Utc::now(),
        duration_ms: 0,
        status: "failed".to_string(),
        width: None,
        height: None,
        saved_path: None,
        image_hash: None,
        black_screen_suspected: None,
        metrics: None,
        error: Some(message.into()),
    }
}

#[cfg(windows)]
fn sample_path(report_dir: &Path, strategy: &str, request: &CaptureRequest) -> Option<PathBuf> {
    request.save_samples.then(|| {
        let name = format!(
            "{}-{}.png",
            strategy,
            format!("{:?}", request.target).to_lowercase()
        )
        .replace([' ', ':', '\\', '/'], "_");
        report_dir.join(name)
    })
}

#[cfg(windows)]
fn calculate_metrics(rgba: &[u8]) -> PixelMetrics {
    let mut count = 0usize;
    let mut sum = 0.0;
    let mut sum_sq = 0.0;
    let mut near_black = 0usize;

    for pixel in rgba.chunks_exact(4).step_by(16) {
        let r = pixel[0] as f64;
        let g = pixel[1] as f64;
        let b = pixel[2] as f64;
        let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        sum += luma;
        sum_sq += luma * luma;
        if luma < 12.0 {
            near_black += 1;
        }
        count += 1;
    }

    if count == 0 {
        return PixelMetrics {
            average_luma: 0.0,
            luma_variance: 0.0,
            near_black_ratio: 1.0,
            sampled_pixels: 0,
        };
    }

    let average = sum / count as f64;
    PixelMetrics {
        average_luma: average,
        luma_variance: (sum_sq / count as f64) - average * average,
        near_black_ratio: near_black as f64 / count as f64,
        sampled_pixels: count,
    }
}

#[cfg(windows)]
fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[derive(Debug)]
#[cfg(windows)]
struct CapturedImage {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
    saved_path: Option<PathBuf>,
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    pub fn list_capture_targets() -> Vec<CaptureTarget> {
        vec![CaptureTarget {
            kind: "platform".to_string(),
            id: "unsupported".to_string(),
            label: "当前不是 Windows，真实截图诊断需在 Windows 桌面环境运行".to_string(),
            bounds: None,
            is_lol_candidate: false,
        }]
    }

    pub fn run_capture_diagnostic(
        request: &CaptureRequest,
        _report_dir: &Path,
    ) -> Vec<CaptureAttempt> {
        let target = format!("{:?}", request.target);
        vec![
            failed_attempt(
                "xcap_requested_target",
                &target,
                "当前平台不是 Windows，跳过真实截图",
            ),
            failed_attempt(
                "xcap_primary_monitor",
                &target,
                "当前平台不是 Windows，跳过主显示器截图",
            ),
            failed_attempt(
                "xcap_center_region",
                &target,
                "当前平台不是 Windows，跳过中心区域截图",
            ),
        ]
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use xcap::{Monitor, Window};

    pub fn list_capture_targets() -> Vec<CaptureTarget> {
        let mut targets = Vec::new();

        if let Ok(monitors) = Monitor::all() {
            for (index, monitor) in monitors.iter().enumerate() {
                let label = monitor
                    .friendly_name()
                    .unwrap_or_else(|_| format!("显示器 {}", index + 1));
                let bounds = match (monitor.x(), monitor.y(), monitor.width(), monitor.height()) {
                    (Ok(x), Ok(y), Ok(width), Ok(height)) => Some(RectInfo {
                        x,
                        y,
                        width,
                        height,
                    }),
                    _ => None,
                };
                targets.push(CaptureTarget {
                    kind: "monitor".to_string(),
                    id: format!("monitor-{}", index),
                    label,
                    bounds,
                    is_lol_candidate: false,
                });
            }
        }

        if let Ok(windows) = Window::all() {
            for window in windows.into_iter().take(80) {
                let title = window.title().unwrap_or_default();
                if title.trim().is_empty() {
                    continue;
                }
                let is_lol_candidate = is_lol_title(&title);
                let bounds = match (window.x(), window.y(), window.width(), window.height()) {
                    (Ok(x), Ok(y), Ok(width), Ok(height)) => Some(RectInfo {
                        x,
                        y,
                        width,
                        height,
                    }),
                    _ => None,
                };
                targets.push(CaptureTarget {
                    kind: "window".to_string(),
                    id: window
                        .id()
                        .map(|id| id.to_string())
                        .unwrap_or_else(|_| "unknown".to_string()),
                    label: title,
                    bounds,
                    is_lol_candidate,
                });
            }
        }

        targets
    }

    pub fn run_capture_diagnostic(
        request: &CaptureRequest,
        report_dir: &Path,
    ) -> Vec<CaptureAttempt> {
        let target = format!("{:?}", request.target);
        vec![
            build_attempt(
                "xcap_requested_target",
                &target,
                sample_path(report_dir, "xcap_requested_target", request),
                |path| capture_with_xcap(request, path),
            ),
            build_attempt(
                "xcap_primary_monitor",
                &target,
                sample_path(report_dir, "xcap_primary_monitor", request),
                |path| capture_monitor_with_xcap(path),
            ),
            build_attempt(
                "xcap_center_region",
                &target,
                sample_path(report_dir, "xcap_center_region", request),
                |path| capture_center_region_with_xcap(path),
            ),
        ]
    }

    fn capture_with_xcap(
        request: &CaptureRequest,
        save_path: Option<&Path>,
    ) -> Result<CapturedImage, String> {
        match request.target {
            CaptureTargetKind::PrimaryMonitor => capture_monitor_with_xcap(save_path),
            CaptureTargetKind::LolWindow => {
                let window = find_xcap_lol_window()?;
                let image = window.capture_image().map_err(|err| err.to_string())?;
                save_xcap_image(image, save_path)
            }
            CaptureTargetKind::ForegroundWindow => {
                let window = find_xcap_foreground_like_window()?;
                let image = window.capture_image().map_err(|err| err.to_string())?;
                save_xcap_image(image, save_path)
            }
        }
    }

    fn capture_monitor_with_xcap(save_path: Option<&Path>) -> Result<CapturedImage, String> {
        let monitors = Monitor::all().map_err(|err| err.to_string())?;
        let monitor = monitors
            .into_iter()
            .find(|monitor| monitor.is_primary().unwrap_or(false))
            .or_else(|| Monitor::all().ok().and_then(|mut monitors| monitors.pop()))
            .ok_or_else(|| "未找到可捕获的显示器".to_string())?;
        let image = monitor.capture_image().map_err(|err| err.to_string())?;
        save_xcap_image(image, save_path)
    }

    fn capture_center_region_with_xcap(save_path: Option<&Path>) -> Result<CapturedImage, String> {
        let monitors = Monitor::all().map_err(|err| err.to_string())?;
        let monitor = monitors
            .into_iter()
            .find(|monitor| monitor.is_primary().unwrap_or(false))
            .or_else(|| Monitor::all().ok().and_then(|mut monitors| monitors.pop()))
            .ok_or_else(|| "未找到可捕获的显示器".to_string())?;
        let width = monitor.width().map_err(|err| err.to_string())?;
        let height = monitor.height().map_err(|err| err.to_string())?;
        let region_width = width.min(640);
        let region_height = height.min(360);
        let x = ((width as i32) - (region_width as i32)) / 2;
        let y = ((height as i32) - (region_height as i32)) / 2;
        let image = monitor
            .capture_region(x, y, region_width, region_height)
            .map_err(|err| err.to_string())?;
        save_xcap_image(image, save_path)
    }

    fn save_xcap_image(
        image: image::RgbaImage,
        save_path: Option<&Path>,
    ) -> Result<CapturedImage, String> {
        if let Some(path) = save_path {
            image.save(path).map_err(|err| err.to_string())?;
        }
        Ok(CapturedImage {
            width: image.width(),
            height: image.height(),
            rgba: image.into_raw(),
            saved_path: save_path.map(Path::to_path_buf),
        })
    }

    fn find_xcap_lol_window() -> Result<Window, String> {
        Window::all()
            .map_err(|err| err.to_string())?
            .into_iter()
            .find(|window| {
                window
                    .title()
                    .map(|title| is_lol_title(&title))
                    .unwrap_or(false)
            })
            .ok_or_else(|| "未找到 LOL 窗口".to_string())
    }

    fn find_xcap_foreground_like_window() -> Result<Window, String> {
        Window::all()
            .map_err(|err| err.to_string())?
            .into_iter()
            .find(|window| {
                !window.is_minimized().unwrap_or(false)
                    && window.width().unwrap_or(0) > 80
                    && window.height().unwrap_or(0) > 80
                    && !window.title().unwrap_or_default().trim().is_empty()
            })
            .ok_or_else(|| "未找到可捕获的前台候选窗口".to_string())
    }

    fn is_lol_title(title: &str) -> bool {
        let lower = title.to_lowercase();
        lower.contains("league of legends")
            || lower.contains("英雄联盟")
            || lower.contains("riot")
            || lower.contains("lol")
    }
}
