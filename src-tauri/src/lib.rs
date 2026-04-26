use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::time::Instant;
use std::{
    fs,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const OVERLAY_POC_LABEL: &str = "overlay-poc";
const OVERLAY_POC_URL: &str = "index.html?view=overlay";

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    pub save_samples: bool,
    #[serde(default)]
    pub delay_seconds: u64,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationSnapshotRequest {
    #[serde(default)]
    pub monitor_id: Option<String>,
    #[serde(default)]
    pub delay_seconds: u64,
    #[serde(default)]
    pub save_sample: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTarget {
    pub kind: String,
    pub id: String,
    pub label: String,
    pub bounds: Option<RectInfo>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RectInfo {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
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
pub struct CalibrationMonitorInfo {
    pub id: String,
    pub name: String,
    pub is_primary: bool,
    pub bounds: RectInfo,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationSnapshotResult {
    pub created_at: DateTime<Utc>,
    pub sample_path: Option<String>,
    pub width: u32,
    pub height: u32,
    pub monitor: CalibrationMonitorInfo,
    pub metrics: PixelMetrics,
    pub black_screen_suspected: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RatioRegion {
    pub x_ratio: f64,
    pub y_ratio: f64,
    pub width_ratio: f64,
    pub height_ratio: f64,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SlottedRatioRegion {
    pub slot: u8,
    pub x_ratio: f64,
    pub y_ratio: f64,
    pub width_ratio: f64,
    pub height_ratio: f64,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationProfile {
    pub version: u32,
    pub profile_name: String,
    pub monitor_id: String,
    pub monitor_name: String,
    pub screenshot_width: u32,
    pub screenshot_height: u32,
    #[serde(default)]
    pub dpi_scale: Option<f64>,
    #[serde(default)]
    pub display_mode_note: Option<String>,
    pub language: String,
    pub name_regions: Vec<SlottedRatioRegion>,
    pub bottom_anchors: Vec<SlottedRatioRegion>,
    pub toggle_button_region: RatioRegion,
    pub overlay: serde_json::Value,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OverlayPocRequest {
    #[serde(default)]
    pub monitor_id: Option<String>,
    #[serde(default)]
    pub target: Option<OverlayPocTargetRequest>,
    #[serde(default)]
    pub cards: Vec<OverlayPocCardRequest>,
    #[serde(default = "default_true")]
    pub click_through: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OverlayPocTargetRequest {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OverlayPocCardRequest {
    pub slot: u8,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OverlayPocTargetInfo {
    pub monitor_id: Option<String>,
    pub monitor_name: Option<String>,
    pub source: String,
    pub bounds: RectInfo,
    pub logical_bounds: RectInfo,
    pub scale_factor: f64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OverlayPocCardInfo {
    pub slot: u8,
    pub title: String,
    pub body: String,
    pub bounds: RectInfo,
    pub source: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OverlayPocResult {
    pub created: bool,
    pub label: String,
    pub url: String,
    pub target: OverlayPocTargetInfo,
    pub click_through_requested: bool,
    pub click_through_enabled: bool,
    pub transparent_requested: bool,
    pub transparent_enabled: bool,
    pub cards: Vec<OverlayPocCardInfo>,
    pub messages: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OverlayPocCloseResult {
    pub label: String,
    pub closed: bool,
    pub message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OverlayPocClickThroughResult {
    pub label: String,
    pub requested: bool,
    pub applied: bool,
    pub supported: bool,
    pub message: String,
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

    let delay_seconds = request.delay_seconds.min(30);
    if delay_seconds > 0 {
        thread::sleep(Duration::from_secs(delay_seconds));
    }

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

#[tauri::command]
fn capture_calibration_snapshot(
    app: AppHandle,
    request: CalibrationSnapshotRequest,
) -> Result<CalibrationSnapshotResult, String> {
    let base_dir = app_data_dir(&app)?;
    let delay_seconds = request.delay_seconds.min(30);
    if delay_seconds > 0 {
        thread::sleep(Duration::from_secs(delay_seconds));
    }

    let snapshots_dir = base_dir.join("calibration").join("snapshots");
    if request.save_sample {
        fs::create_dir_all(&snapshots_dir).map_err(|err| err.to_string())?;
    }

    platform::capture_calibration_snapshot(&request, &snapshots_dir)
}

#[tauri::command]
fn save_calibration_profile(app: AppHandle, profile: CalibrationProfile) -> Result<(), String> {
    validate_calibration_profile(&profile)?;

    let profile_path = calibration_profile_path(&app)?;
    if let Some(parent) = profile_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    let content = serde_json::to_string_pretty(&profile).map_err(|err| err.to_string())?;
    fs::write(profile_path, content).map_err(|err| err.to_string())
}

#[tauri::command]
fn load_calibration_profile(app: AppHandle) -> Result<Option<CalibrationProfile>, String> {
    read_calibration_profile(&app)
}

#[tauri::command]
fn open_overlay_poc(
    app: AppHandle,
    request: OverlayPocRequest,
) -> Result<OverlayPocResult, String> {
    let mut messages = Vec::new();
    let profile = read_calibration_profile(&app)?;
    let target = resolve_overlay_target(&app, &request, profile.as_ref(), &mut messages)?;
    let cards = resolve_overlay_cards(&request, profile.as_ref(), &target, &mut messages)?;

    if let Some(existing) = app.get_webview_window(OVERLAY_POC_LABEL) {
        existing.close().map_err(|err| err.to_string())?;
        messages.push("已关闭旧的 Overlay POC 窗口后重新创建。".to_string());
    }

    let mut builder = WebviewWindowBuilder::new(
        &app,
        OVERLAY_POC_LABEL,
        WebviewUrl::App(OVERLAY_POC_URL.into()),
    )
    .title("Overlay POC")
    .position(
        f64::from(target.logical_bounds.x),
        f64::from(target.logical_bounds.y),
    )
    .inner_size(
        f64::from(target.logical_bounds.width),
        f64::from(target.logical_bounds.height),
    )
    .decorations(false)
    .always_on_top(true)
    .focused(false)
    .focusable(false)
    .skip_taskbar(true);

    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.transparent(true);
    }
    #[cfg(target_os = "macos")]
    {
        messages.push("当前构建未启用 macOS private API，Overlay 透明窗口已降级。".to_string());
    }
    let transparent_enabled = cfg!(not(target_os = "macos"));

    let window = builder.build().map_err(|err| err.to_string())?;
    if let Err(err) = window.set_focusable(false) {
        messages.push(format!("设置窗口不抢焦点失败: {}", err));
    }

    let click_through = if request.click_through {
        let result = set_overlay_click_through(&window, true);
        messages.push(result.message.clone());
        result.applied
    } else {
        messages.push("请求未启用点击穿透。".to_string());
        false
    };

    Ok(OverlayPocResult {
        created: true,
        label: OVERLAY_POC_LABEL.to_string(),
        url: OVERLAY_POC_URL.to_string(),
        target,
        click_through_requested: request.click_through,
        click_through_enabled: click_through,
        transparent_requested: true,
        transparent_enabled,
        cards,
        messages,
    })
}

#[tauri::command]
fn close_overlay_poc(app: AppHandle) -> Result<OverlayPocCloseResult, String> {
    if let Some(window) = app.get_webview_window(OVERLAY_POC_LABEL) {
        window.close().map_err(|err| err.to_string())?;
        Ok(OverlayPocCloseResult {
            label: OVERLAY_POC_LABEL.to_string(),
            closed: true,
            message: "Overlay POC 窗口已关闭。".to_string(),
        })
    } else {
        Ok(OverlayPocCloseResult {
            label: OVERLAY_POC_LABEL.to_string(),
            closed: false,
            message: "Overlay POC 窗口不存在，无需关闭。".to_string(),
        })
    }
}

#[tauri::command]
fn set_overlay_poc_click_through(
    app: AppHandle,
    enabled: bool,
) -> Result<OverlayPocClickThroughResult, String> {
    let window = app
        .get_webview_window(OVERLAY_POC_LABEL)
        .ok_or_else(|| "Overlay POC 窗口不存在，请先调用 openOverlayPoc。".to_string())?;
    Ok(set_overlay_click_through(&window, enabled))
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_environment_snapshot,
            list_capture_targets,
            run_capture_diagnostic,
            capture_calibration_snapshot,
            save_calibration_profile,
            load_calibration_profile,
            open_overlay_poc,
            close_overlay_poc,
            set_overlay_poc_click_through
        ])
        .run(tauri::generate_context!())
        .expect("启动屏幕截图诊断工具失败");
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|err| err.to_string())
}

fn calibration_profile_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("calibration").join("profile.json"))
}

fn read_calibration_profile(app: &AppHandle) -> Result<Option<CalibrationProfile>, String> {
    let profile_path = calibration_profile_path(app)?;
    if !profile_path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(profile_path).map_err(|err| err.to_string())?;
    let profile = serde_json::from_str(&content).map_err(|err| err.to_string())?;
    Ok(Some(profile))
}

fn default_true() -> bool {
    true
}

fn resolve_overlay_target(
    app: &AppHandle,
    request: &OverlayPocRequest,
    profile: Option<&CalibrationProfile>,
    messages: &mut Vec<String>,
) -> Result<OverlayPocTargetInfo, String> {
    if let Some(target) = &request.target {
        if target.width == 0 || target.height == 0 {
            return Err("Overlay POC target 宽高必须大于 0".to_string());
        }
        messages.push("使用请求传入的 Overlay 目标尺寸。".to_string());
        return Ok(OverlayPocTargetInfo {
            monitor_id: request.monitor_id.clone(),
            monitor_name: None,
            source: "request.target".to_string(),
            bounds: RectInfo {
                x: target.x,
                y: target.y,
                width: target.width,
                height: target.height,
            },
            logical_bounds: RectInfo {
                x: target.x,
                y: target.y,
                width: target.width,
                height: target.height,
            },
            scale_factor: 1.0,
        });
    }

    let requested_monitor_id = request
        .monitor_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
        .or_else(|| profile.map(|profile| profile.monitor_id.as_str()));

    if let Some(main_window) = app.get_webview_window("main") {
        match main_window.available_monitors() {
            Ok(monitors) => {
                if let Some((index, monitor)) =
                    select_tauri_monitor(&monitors, requested_monitor_id)
                {
                    let monitor_id = format!("monitor-{}", index);
                    let physical_position = monitor.position();
                    let physical_size = monitor.size();
                    let scale_factor = monitor.scale_factor();
                    let logical_x = f64::from(physical_position.x) / scale_factor;
                    let logical_y = f64::from(physical_position.y) / scale_factor;
                    let logical_width = f64::from(physical_size.width) / scale_factor;
                    let logical_height = f64::from(physical_size.height) / scale_factor;
                    messages.push(format!(
                        "使用 Tauri 显示器 {} 创建 Overlay POC。",
                        monitor_id
                    ));
                    return Ok(OverlayPocTargetInfo {
                        monitor_id: Some(monitor_id),
                        monitor_name: monitor.name().cloned(),
                        source: "tauri.availableMonitors".to_string(),
                        bounds: RectInfo {
                            x: physical_position.x,
                            y: physical_position.y,
                            width: physical_size.width,
                            height: physical_size.height,
                        },
                        logical_bounds: RectInfo {
                            x: round_to_i32(logical_x),
                            y: round_to_i32(logical_y),
                            width: round_to_u32(logical_width).max(1),
                            height: round_to_u32(logical_height).max(1),
                        },
                        scale_factor,
                    });
                }

                if let Some(id) = requested_monitor_id {
                    messages.push(format!(
                        "未在 Tauri 显示器列表中找到 {}，改用校准截图尺寸降级。",
                        id
                    ));
                }
            }
            Err(err) => messages.push(format!(
                "读取 Tauri 显示器列表失败，改用校准截图尺寸降级: {}",
                err
            )),
        }
    } else {
        messages.push("未找到 main 窗口，无法读取显示器列表，改用校准截图尺寸降级。".to_string());
    }

    if let Some(profile) = profile {
        return Ok(OverlayPocTargetInfo {
            monitor_id: Some(profile.monitor_id.clone()),
            monitor_name: Some(profile.monitor_name.clone()),
            source: "calibration.profileScreenshot".to_string(),
            bounds: RectInfo {
                x: 0,
                y: 0,
                width: profile.screenshot_width,
                height: profile.screenshot_height,
            },
            logical_bounds: RectInfo {
                x: 0,
                y: 0,
                width: profile.screenshot_width,
                height: profile.screenshot_height,
            },
            scale_factor: profile.dpi_scale.unwrap_or(1.0),
        });
    }

    messages.push("未找到校准配置，使用 1280x720 作为 Overlay POC 降级尺寸。".to_string());
    Ok(OverlayPocTargetInfo {
        monitor_id: request.monitor_id.clone(),
        monitor_name: None,
        source: "fallback.defaultSize".to_string(),
        bounds: RectInfo {
            x: 0,
            y: 0,
            width: 1280,
            height: 720,
        },
        logical_bounds: RectInfo {
            x: 0,
            y: 0,
            width: 1280,
            height: 720,
        },
        scale_factor: 1.0,
    })
}

fn select_tauri_monitor<'a>(
    monitors: &'a [tauri::window::Monitor],
    requested_monitor_id: Option<&str>,
) -> Option<(usize, &'a tauri::window::Monitor)> {
    if monitors.is_empty() {
        return None;
    }

    if let Some(id) = requested_monitor_id {
        if let Some(index_text) = id.strip_prefix("monitor-") {
            if let Ok(index) = index_text.parse::<usize>() {
                if let Some(monitor) = monitors.get(index) {
                    return Some((index, monitor));
                }
            }
        }

        if let Some((index, monitor)) = monitors
            .iter()
            .enumerate()
            .find(|(_, monitor)| monitor.name().is_some_and(|name| name == id))
        {
            return Some((index, monitor));
        }

        return None;
    }

    Some((0, &monitors[0]))
}

fn resolve_overlay_cards(
    request: &OverlayPocRequest,
    profile: Option<&CalibrationProfile>,
    target: &OverlayPocTargetInfo,
    messages: &mut Vec<String>,
) -> Result<Vec<OverlayPocCardInfo>, String> {
    if !request.cards.is_empty() {
        let mut cards = Vec::with_capacity(request.cards.len());
        for card in &request.cards {
            if card.width == 0 || card.height == 0 {
                return Err(format!("Overlay POC 卡片 slot{} 宽高必须大于 0", card.slot));
            }
            cards.push(OverlayPocCardInfo {
                slot: card.slot,
                title: card
                    .title
                    .clone()
                    .unwrap_or_else(|| format!("测试卡片 {}", card.slot)),
                body: card
                    .body
                    .clone()
                    .unwrap_or_else(|| "Overlay POC".to_string()),
                bounds: RectInfo {
                    x: card.x,
                    y: card.y,
                    width: card.width,
                    height: card.height,
                },
                source: "request.cards".to_string(),
            });
        }
        messages.push("使用请求传入的 Overlay 测试卡片位置。".to_string());
        return Ok(cards);
    }

    if let Some(profile) = profile {
        let cards = cards_from_calibration_profile(profile, target);
        if !cards.is_empty() {
            messages.push(
                "已根据 calibration/profile.json 的 bottomAnchors 生成测试卡片位置。".to_string(),
            );
            return Ok(cards);
        }
    }

    messages.push("未找到可用 bottomAnchors，使用默认三列测试卡片位置。".to_string());
    Ok(default_overlay_cards(target))
}

fn cards_from_calibration_profile(
    profile: &CalibrationProfile,
    target: &OverlayPocTargetInfo,
) -> Vec<OverlayPocCardInfo> {
    let gap = json_u32(&profile.overlay, "gap").unwrap_or(8);
    let max_height = json_u32(&profile.overlay, "maxHeight").unwrap_or(120);
    let target_width = target.logical_bounds.width;
    let target_height = target.logical_bounds.height;

    let mut anchors = profile.bottom_anchors.clone();
    anchors.sort_by_key(|anchor| anchor.slot);

    anchors
        .iter()
        .map(|anchor| {
            let anchor_rect =
                ratio_region_to_rect(&anchor.as_ratio_region(), target_width, target_height);
            let card_height = max_height.min(target_height.max(1));
            let y = anchor_rect
                .y
                .saturating_sub(u32_to_i32_saturating(gap))
                .saturating_sub(u32_to_i32_saturating(card_height))
                .max(0);
            OverlayPocCardInfo {
                slot: anchor.slot,
                title: format!("测试卡片 {}", anchor.slot),
                body: format!("slot {} · Overlay POC", anchor.slot),
                bounds: RectInfo {
                    x: anchor_rect.x,
                    y,
                    width: anchor_rect.width.max(1),
                    height: card_height.max(1),
                },
                source: "calibration.bottomAnchors".to_string(),
            }
        })
        .collect()
}

fn default_overlay_cards(target: &OverlayPocTargetInfo) -> Vec<OverlayPocCardInfo> {
    let width = target.logical_bounds.width;
    let height = target.logical_bounds.height;
    let card_width = (width / 5).clamp(180, 320).min(width.max(1));
    let card_height = 120.min(height.max(1));
    let gap = 24u32;
    let total_width = card_width
        .saturating_mul(3)
        .saturating_add(gap.saturating_mul(2));
    let start_x = if width > total_width {
        (width - total_width) / 2
    } else {
        0
    };
    let y = height
        .saturating_sub(card_height)
        .saturating_sub(80)
        .min(height.saturating_sub(card_height));

    (0..3)
        .map(|index| {
            let slot = index + 1;
            OverlayPocCardInfo {
                slot: slot as u8,
                title: format!("测试卡片 {}", slot),
                body: "Overlay POC".to_string(),
                bounds: RectInfo {
                    x: u32_to_i32_saturating(
                        start_x + index * card_width + index.saturating_mul(gap),
                    ),
                    y: u32_to_i32_saturating(y),
                    width: card_width,
                    height: card_height,
                },
                source: "fallback.defaultCards".to_string(),
            }
        })
        .collect()
}

fn ratio_region_to_rect(region: &RatioRegion, width: u32, height: u32) -> RectInfo {
    RectInfo {
        x: round_to_i32(region.x_ratio * f64::from(width)),
        y: round_to_i32(region.y_ratio * f64::from(height)),
        width: round_to_u32(region.width_ratio * f64::from(width)).max(1),
        height: round_to_u32(region.height_ratio * f64::from(height)).max(1),
    }
}

fn json_u32(value: &serde_json::Value, key: &str) -> Option<u32> {
    value
        .get(key)
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

fn round_to_i32(value: f64) -> i32 {
    if value.is_nan() {
        0
    } else if value > f64::from(i32::MAX) {
        i32::MAX
    } else if value < f64::from(i32::MIN) {
        i32::MIN
    } else {
        value.round() as i32
    }
}

fn round_to_u32(value: f64) -> u32 {
    if value.is_nan() || value <= 0.0 {
        0
    } else if value > f64::from(u32::MAX) {
        u32::MAX
    } else {
        value.round() as u32
    }
}

fn u32_to_i32_saturating(value: u32) -> i32 {
    i32::try_from(value).unwrap_or(i32::MAX)
}

#[cfg(windows)]
fn set_overlay_click_through(
    window: &tauri::WebviewWindow,
    enabled: bool,
) -> OverlayPocClickThroughResult {
    match window.set_ignore_cursor_events(enabled) {
        Ok(()) => OverlayPocClickThroughResult {
            label: OVERLAY_POC_LABEL.to_string(),
            requested: enabled,
            applied: enabled,
            supported: true,
            message: format!(
                "Windows 点击穿透已{}。",
                if enabled { "启用" } else { "关闭" }
            ),
        },
        Err(err) => OverlayPocClickThroughResult {
            label: OVERLAY_POC_LABEL.to_string(),
            requested: enabled,
            applied: false,
            supported: false,
            message: format!("Windows 点击穿透请求失败: {}", err),
        },
    }
}

#[cfg(not(windows))]
fn set_overlay_click_through(
    _window: &tauri::WebviewWindow,
    enabled: bool,
) -> OverlayPocClickThroughResult {
    OverlayPocClickThroughResult {
        label: OVERLAY_POC_LABEL.to_string(),
        requested: enabled,
        applied: false,
        supported: false,
        message: "当前非 Windows 构建，Overlay POC 点击穿透未启用；需要在 Windows 桌面环境实测。"
            .to_string(),
    }
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
    }
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
    lines.push(format!("保存样本: {}", report.request.save_samples));
    lines.push(format!("延迟截图: {} 秒", report.request.delay_seconds));
    lines.push(String::new());
    lines.push("[环境]".to_string());
    lines.push(format!("OS: {}", report.environment.os));
    lines.push(format!("架构: {}", report.environment.arch));
    lines.push(format!(
        "Rust target: {}-{}",
        report.environment.rust_target_os, report.environment.rust_target_arch
    ));
    lines.push(format!("应用数据目录: {}", report.environment.app_data_dir));
    lines.push(String::new());
    lines.push("[捕获目标]".to_string());
    for target in &report.targets {
        lines.push(format!(
            "  - kind={} id={} label={} bounds={:?}",
            target.kind, target.id, target.label, target.bounds
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

fn validate_calibration_profile(profile: &CalibrationProfile) -> Result<(), String> {
    if profile.version == 0 {
        return Err("校准配置 version 必须大于 0".to_string());
    }
    if profile.profile_name.trim().is_empty() {
        return Err("校准配置 profileName 不能为空".to_string());
    }
    if profile.monitor_id.trim().is_empty() {
        return Err("校准配置 monitorId 不能为空".to_string());
    }
    if profile.monitor_name.trim().is_empty() {
        return Err("校准配置 monitorName 不能为空".to_string());
    }
    if profile.screenshot_width == 0 || profile.screenshot_height == 0 {
        return Err("校准配置截图宽高必须大于 0".to_string());
    }
    if let Some(dpi_scale) = profile.dpi_scale {
        if !dpi_scale.is_finite() || dpi_scale <= 0.0 {
            return Err("校准配置 dpiScale 必须大于 0".to_string());
        }
    }
    if profile.language.trim().is_empty() {
        return Err("校准配置 language 不能为空".to_string());
    }

    validate_slotted_regions("nameRegions", &profile.name_regions)?;
    validate_slotted_regions("bottomAnchors", &profile.bottom_anchors)?;
    validate_region("toggleButtonRegion", &profile.toggle_button_region)
}

fn validate_slotted_regions(label: &str, regions: &[SlottedRatioRegion]) -> Result<(), String> {
    if regions.len() != 3 {
        return Err(format!("校准配置 {} 必须包含 3 个区域", label));
    }

    let mut seen = [false; 3];
    for region in regions {
        if !(1..=3).contains(&region.slot) {
            return Err(format!("校准配置 {} slot 必须为 1、2、3", label));
        }
        let index = usize::from(region.slot - 1);
        if seen[index] {
            return Err(format!("校准配置 {} slot {} 重复", label, region.slot));
        }
        seen[index] = true;
        validate_region(label, &region.as_ratio_region())?;
    }

    if seen.iter().all(|exists| *exists) {
        Ok(())
    } else {
        Err(format!("校准配置 {} slot 不完整", label))
    }
}

fn validate_region(label: &str, region: &RatioRegion) -> Result<(), String> {
    validate_ratio(label, "xRatio", region.x_ratio)?;
    validate_ratio(label, "yRatio", region.y_ratio)?;
    validate_ratio(label, "widthRatio", region.width_ratio)?;
    validate_ratio(label, "heightRatio", region.height_ratio)?;

    if region.width_ratio <= 0.0 || region.height_ratio <= 0.0 {
        return Err(format!("校准配置 {} 宽高比例必须大于 0", label));
    }
    if region.x_ratio + region.width_ratio > 1.0 || region.y_ratio + region.height_ratio > 1.0 {
        return Err(format!("校准配置 {} 区域不能超出截图范围", label));
    }

    Ok(())
}

fn validate_ratio(label: &str, field: &str, value: f64) -> Result<(), String> {
    if !value.is_finite() || !(0.0..=1.0).contains(&value) {
        return Err(format!("校准配置 {}.{} 必须在 0..=1 范围内", label, field));
    }
    Ok(())
}

impl SlottedRatioRegion {
    fn as_ratio_region(&self) -> RatioRegion {
        RatioRegion {
            x_ratio: self.x_ratio,
            y_ratio: self.y_ratio,
            width_ratio: self.width_ratio,
            height_ratio: self.height_ratio,
        }
    }
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

#[cfg(not(windows))]
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
        let name = format!("{}.png", strategy).replace([' ', ':', '\\', '/'], "_");
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
        }]
    }

    pub fn run_capture_diagnostic(
        _request: &CaptureRequest,
        _report_dir: &Path,
    ) -> Vec<CaptureAttempt> {
        vec![
            failed_attempt(
                "xcap_requested_target",
                "primary_monitor",
                "当前平台不是 Windows，跳过真实截图",
            ),
            failed_attempt(
                "xcap_primary_monitor",
                "primary_monitor",
                "当前平台不是 Windows，跳过主显示器截图",
            ),
            failed_attempt(
                "xcap_center_region",
                "primary_monitor",
                "当前平台不是 Windows，跳过中心区域截图",
            ),
        ]
    }

    pub fn capture_calibration_snapshot(
        _request: &CalibrationSnapshotRequest,
        _snapshots_dir: &Path,
    ) -> Result<CalibrationSnapshotResult, String> {
        Err("当前平台不是 Windows，校准截图需要在 Windows 桌面环境运行".to_string())
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use xcap::Monitor;

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
                });
            }
        }

        targets
    }

    pub fn run_capture_diagnostic(
        request: &CaptureRequest,
        report_dir: &Path,
    ) -> Vec<CaptureAttempt> {
        vec![
            build_attempt(
                "xcap_requested_target",
                "primary_monitor",
                sample_path(report_dir, "xcap_requested_target", request),
                capture_monitor_with_xcap,
            ),
            build_attempt(
                "xcap_primary_monitor",
                "primary_monitor",
                sample_path(report_dir, "xcap_primary_monitor", request),
                capture_monitor_with_xcap,
            ),
            build_attempt(
                "xcap_center_region",
                "primary_monitor",
                sample_path(report_dir, "xcap_center_region", request),
                capture_center_region_with_xcap,
            ),
        ]
    }

    pub fn capture_calibration_snapshot(
        request: &CalibrationSnapshotRequest,
        snapshots_dir: &Path,
    ) -> Result<CalibrationSnapshotResult, String> {
        let monitors = Monitor::all().map_err(|err| err.to_string())?;
        let selected_index = select_monitor_index(&monitors, request.monitor_id.as_deref())?;
        let monitor = monitors
            .get(selected_index)
            .ok_or_else(|| "未找到可捕获的显示器".to_string())?;
        let monitor_info = monitor_info(monitor, selected_index)?;
        let created_at = Utc::now();
        let save_path = request.save_sample.then(|| {
            snapshots_dir.join(format!(
                "calibration-{}-{}.png",
                created_at.format("%Y%m%d-%H%M%S"),
                monitor_info.id
            ))
        });

        let image = monitor.capture_image().map_err(|err| err.to_string())?;
        let captured = save_xcap_image(image, save_path.as_deref())?;
        let metrics = calculate_metrics(&captured.rgba);
        let black_screen_suspected = metrics.average_luma < 8.0
            || (metrics.near_black_ratio > 0.985 && metrics.luma_variance < 20.0);

        Ok(CalibrationSnapshotResult {
            created_at,
            sample_path: captured.saved_path.map(|path| path.display().to_string()),
            width: captured.width,
            height: captured.height,
            monitor: monitor_info,
            metrics,
            black_screen_suspected,
        })
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
        let x = (width - region_width) / 2;
        let y = (height - region_height) / 2;
        let image = monitor
            .capture_region(x, y, region_width, region_height)
            .map_err(|err| err.to_string())?;
        save_xcap_image(image, save_path)
    }

    fn select_monitor_index(
        monitors: &[Monitor],
        monitor_id: Option<&str>,
    ) -> Result<usize, String> {
        if monitors.is_empty() {
            return Err("未找到可捕获的显示器".to_string());
        }

        if let Some(id) = monitor_id.filter(|id| !id.trim().is_empty()) {
            let index_text = id
                .strip_prefix("monitor-")
                .ok_or_else(|| format!("不支持的显示器编号: {}", id))?;
            let index = index_text
                .parse::<usize>()
                .map_err(|_| format!("不支持的显示器编号: {}", id))?;
            if index < monitors.len() {
                return Ok(index);
            }
            return Err(format!("未找到显示器: {}", id));
        }

        Ok(monitors
            .iter()
            .position(|monitor| monitor.is_primary().unwrap_or(false))
            .unwrap_or(0))
    }

    fn monitor_info(monitor: &Monitor, index: usize) -> Result<CalibrationMonitorInfo, String> {
        Ok(CalibrationMonitorInfo {
            id: format!("monitor-{}", index),
            name: monitor
                .friendly_name()
                .unwrap_or_else(|_| format!("显示器 {}", index + 1)),
            is_primary: monitor.is_primary().unwrap_or(false),
            bounds: RectInfo {
                x: monitor.x().map_err(|err| err.to_string())?,
                y: monitor.y().map_err(|err| err.to_string())?,
                width: monitor.width().map_err(|err| err.to_string())?,
                height: monitor.height().map_err(|err| err.to_string())?,
            },
        })
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
}
