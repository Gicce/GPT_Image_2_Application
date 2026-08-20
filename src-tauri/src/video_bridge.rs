//! CY Video Bridge V1 发送端：把图库图片同步为 CY Video Studio 的素材。
//! 发现机制完全依赖接收端写入的 `%LOCALAPPDATA%\CY Video Studio\bridge.json`，
//! 端口与 token 每次启动随机，绝不硬编码。
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

pub const BRIDGE_PROTOCOL: &str = "CY_VIDEO_BRIDGE_V1";
pub const SOURCE_APP: &str = "cy-image";
/// 离线类错误前缀，前端据此展示「重新检测」交互
pub const OFFLINE_ERROR_PREFIX: &str = "CY_VIDEO_OFFLINE:";

/// 接收端 (cy-video-studio bridge_discovery.rs) 的发现文件，snake_case JSON
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct DiscoveryFile {
    protocol: String,
    #[allow(dead_code)]
    version: u32,
    #[allow(dead_code)]
    app: String,
    host: String,
    port: u16,
    #[allow(dead_code)]
    pid: u32,
    token: String,
    #[allow(dead_code)]
    started_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSyncParams {
    pub image_id: String,
    pub task_id: Option<String>,
    pub file_path: String,
    pub file_name: String,
    /// 兼容字段：仅旧调用方使用（等价 final_prompt）；新调用方应传 user_prompt_raw + final_prompt
    pub prompt: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub created_at: Option<String>,
    pub model: Option<String>,
    // ---------- V0.4.0 契约补全：创作元数据完整同步 ----------
    /// 用户原始创作需求（Task.user_prompt_raw）
    pub user_prompt_raw: Option<String>,
    /// AI 优化后真正提交模型的提示词（Task.final_prompt）
    pub final_prompt: Option<String>,
    /// 最终负面提示词（Task.final_negative_prompt / negative_prompt）
    pub final_negative_prompt: Option<String>,
    /// 是否经过 Prompt 优化（Task.prompt_optimized）
    pub prompt_optimized: Option<bool>,
    /// 素材显示标题（用于 Video 端 display_name）
    pub display_title: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSyncResult {
    pub asset_id: String,
    pub message: String,
    pub already_synced: bool,
}

fn discovery_path() -> Option<std::path::PathBuf> {
    dirs::data_local_dir().map(|d| d.join("CY Video Studio").join("bridge.json"))
}

/// 校验用户手动选择的 CY Video Studio 可执行路径（命令层入口）
pub fn validate_saved_executable(raw: &str) -> Result<std::path::PathBuf, String> {
    validate_executable(raw).map_err(|e| format!("所选文件无效：{e}"))
}

/// Bridge 健康检查（短超时，供前端 300～500ms 轮询）。
/// bridge.json 可能是已退出实例的残留：读不到 / 连不上 / 协议不符均视为离线。
pub async fn bridge_online() -> bool {
    let discovery = match read_discovery() {
        Ok(d) => d,
        Err(_) => return false,
    };
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .connect_timeout(std::time::Duration::from_secs(1))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let base = format!("http://{}:{}", discovery.host, discovery.port);
    let health = match client
        .get(format!("{base}/bridge/health"))
        .bearer_auth(&discovery.token)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(_) => return false,
    };
    if !health.status().is_success() {
        return false;
    }
    let body: serde_json::Value = match health.json().await {
        Ok(v) => v,
        Err(_) => return false,
    };
    body.get("protocol").and_then(|v| v.as_str()) == Some(BRIDGE_PROTOCOL)
}

/// CY Video Studio 启动结果（launch_video_studio 命令返回体）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoLaunchOutcome {
    /// spawned = 本次真的拉起了进程；already_running = 进程已在（启动中），只需等 Bridge
    pub launched: bool,
    /// already_online / already_running_process / spawned
    pub reason: String,
    /// 实际使用的可执行文件（already_* 时为空）
    pub executable: String,
}

/// 可执行文件候选名（Tauri 产物以 Cargo 包名为准，兼容 productName 命名）
const VIDEO_EXE_NAMES: [&str; 2] = ["cy-video-studio.exe", "CY Video Studio.exe"];
/// MSI / NSIS 常见安装目录名
const VIDEO_INSTALL_DIRS: [&str; 2] = ["CY Video Studio", "cy-video-studio"];

fn is_executable_path(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("exe"))
            .unwrap_or(false)
}

/// 校验外部输入的可执行路径（用户手选 / 设置保存值）：必须存在且为 .exe
fn validate_executable(raw: &str) -> Result<std::path::PathBuf, String> {
    let trimmed = raw.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("路径为空".to_string());
    }
    let path = Path::new(trimmed);
    if !is_executable_path(path) {
        return Err(format!("不是有效的可执行文件：{trimmed}"));
    }
    Ok(path.to_path_buf())
}

#[cfg(windows)]
fn registry_probe() -> Option<std::path::PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let roots = [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE];
    // 1) App Paths：{root}\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\<exe>
    for root in roots {
        for exe in VIDEO_EXE_NAMES {
            let subkey = format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}");
            if let Ok(key) = RegKey::predef(root).open_subkey(&subkey) {
                if let Ok(default) = key.get_value::<String, _>("") {
                    if let Ok(path) = validate_executable(&default) {
                        return Some(path);
                    }
                }
            }
        }
    }
    // 2) Uninstall 表：DisplayName 含「CY Video Studio」→ InstallLocation 下找 exe
    let mut uninstall_roots: Vec<(winreg::HKEY, &str)> = Vec::new();
    for root in roots {
        uninstall_roots.push((root, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"));
    }
    uninstall_roots.push((
        HKEY_LOCAL_MACHINE,
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ));
    for (root, path) in uninstall_roots {
        let Ok(uninstall) = RegKey::predef(root).open_subkey(path) else {
            continue;
        };
        for key in uninstall.enum_keys().flatten() {
            let Ok(entry) = uninstall.open_subkey(&key) else {
                continue;
            };
            let display: String = entry.get_value("DisplayName").unwrap_or_default();
            if !display.contains("CY Video Studio") {
                continue;
            }
            let install_dir: String = entry.get_value("InstallLocation").unwrap_or_default();
            let install_dir = install_dir.trim().trim_matches('"').to_string();
            if install_dir.is_empty() {
                continue;
            }
            for dir_name in VIDEO_INSTALL_DIRS {
                for exe in VIDEO_EXE_NAMES {
                    let candidate = Path::new(&install_dir).join(dir_name).join(exe);
                    if is_executable_path(&candidate) {
                        return Some(candidate);
                    }
                }
            }
            for exe in VIDEO_EXE_NAMES {
                let candidate = Path::new(&install_dir).join(exe);
                if is_executable_path(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn registry_probe() -> Option<std::path::PathBuf> {
    None
}

/// 常见安装目录探测（不写死开发机路径，只用环境变量 + 标准安装位置）
fn common_install_candidates() -> Vec<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    let mut program_roots: Vec<std::path::PathBuf> = Vec::new();
    if let Some(pf) = std::env::var_os("ProgramFiles") {
        program_roots.push(std::path::PathBuf::from(pf));
    } else {
        program_roots.push(std::path::PathBuf::from(r"C:\Program Files"));
    }
    if let Some(pf86) = std::env::var_os("ProgramFiles(x86)") {
        program_roots.push(std::path::PathBuf::from(pf86));
    } else {
        program_roots.push(std::path::PathBuf::from(r"C:\Program Files (x86)"));
    }
    if let Some(local) = dirs::data_local_dir() {
        program_roots.push(local.join("Programs"));
    }
    for root in program_roots {
        for dir_name in VIDEO_INSTALL_DIRS {
            for exe in VIDEO_EXE_NAMES {
                candidates.push(root.join(dir_name).join(exe));
            }
        }
    }
    candidates
}

/// 发现顺序：设置保存路径（失效自动忽略）→ 注册表 → 常见安装目录
fn resolve_video_executable(saved_path: &str) -> Option<std::path::PathBuf> {
    if !saved_path.trim().is_empty() {
        if let Ok(path) = validate_executable(saved_path) {
            return Some(path);
        }
        // 保存路径已失效（用户移动 / 卸载）：清掉并继续 discovery
    }
    registry_probe().or_else(|| {
        common_install_candidates()
            .into_iter()
            .find(|c| is_executable_path(c))
    })
}

/// bridge.json 里的 pid 是否仍是 CY Video Studio 进程（区分「正在启动」和「真离线」，
/// 避免重复拉起第二份）。通过 tasklist 查询，不引入 unsafe。
#[cfg(windows)]
fn video_process_running() -> bool {
    let Some(discovery_text) = discovery_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
    else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&discovery_text) else {
        return false;
    };
    let pid = match value.get("pid").and_then(|v| v.as_u64()) {
        Some(pid) if pid > 0 => pid,
        _ => return false,
    };
    let output = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let Ok(output) = output else {
        return false;
    };
    let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
    text.contains("cy-video-studio") || text.contains("cy video studio")
}

#[cfg(not(windows))]
fn video_process_running() -> bool {
    false
}

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// 短时间防重复拉起（Video 启动慢于 Bridge 写文件时，避免连续点击 spawn 多份）
static LAST_SPAWN_AT: once_cell::sync::Lazy<std::sync::Mutex<Option<std::time::Instant>>> =
    once_cell::sync::Lazy::new(|| std::sync::Mutex::new(None));
const RESPAWN_GUARD: std::time::Duration = std::time::Duration::from_secs(8);

/// 启动 CY Video Studio（不在本进程等待）：Bridge 在线 / 进程已在（启动中）时直接返回。
pub fn launch_video_studio(saved_path: &str) -> Result<VideoLaunchOutcome, String> {
    let exe = resolve_video_executable(saved_path).ok_or_else(|| {
        "CY_VIDEO_NOT_FOUND:未检测到 CY Video Studio 的安装位置。可手动选择 CY Video Studio.exe 后重试。".to_string()
    })?;

    {
        let last = LAST_SPAWN_AT.lock().unwrap();
        if let Some(at) = *last {
            if at.elapsed() < RESPAWN_GUARD {
                return Ok(VideoLaunchOutcome {
                    launched: false,
                    reason: "spawn_guard".into(),
                    executable: exe.display().to_string(),
                });
            }
        }
    }
    if video_process_running() {
        return Ok(VideoLaunchOutcome {
            launched: false,
            reason: "already_running_process".into(),
            executable: String::new(),
        });
    }

    #[cfg(windows)]
    let mut command = {
        let mut cmd = std::process::Command::new(&exe);
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
        cmd
    };
    #[cfg(not(windows))]
    let mut command = std::process::Command::new(&exe);
    if let Some(dir) = exe.parent() {
        let _ = command.current_dir(dir);
    }
    command
        .spawn()
        .map_err(|e| format!("启动 CY Video Studio 失败（{}）：{e}", exe.display()))?;
    if let Ok(mut last) = LAST_SPAWN_AT.lock() {
        *last = Some(std::time::Instant::now());
    }
    Ok(VideoLaunchOutcome {
        launched: true,
        reason: "spawned".into(),
        executable: exe.display().to_string(),
    })
}

fn read_discovery() -> Result<DiscoveryFile, String> {
    let path = discovery_path().ok_or_else(|| format!("{OFFLINE_ERROR_PREFIX}无法定位本地应用数据目录"))?;
    let content = std::fs::read_to_string(&path)
        .map_err(|_| format!("{OFFLINE_ERROR_PREFIX}CY Video Studio 当前未连接（未找到 bridge.json），请启动 CY Video Studio 后重试"))?;
    let parsed: DiscoveryFile = serde_json::from_str(&content)
        .map_err(|_| format!("{OFFLINE_ERROR_PREFIX}CY Video Studio 的 bridge.json 已损坏，请重启 CY Video Studio 后重试"))?;
    if parsed.protocol != BRIDGE_PROTOCOL {
        return Err(format!(
            "{OFFLINE_ERROR_PREFIX}CY Video Studio Bridge 协议不兼容（{}，需要 {}），请升级 CY Video Studio",
            parsed.protocol, BRIDGE_PROTOCOL
        ));
    }
    Ok(parsed)
}

fn mime_for_path(path: &Path) -> Result<&'static str, String> {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "webp" => Ok("image/webp"),
        other => Err(format!("CY Video Studio 仅支持 PNG / JPEG / WebP 图片，当前格式：{other}")),
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)
        .map_err(|_| format!("图片文件不存在：{}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| format!("读取图片失败：{e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    Ok(digest.iter().map(|b| format!("{b:02x}")).collect())
}

/// 同步入口：发现 -> 健康检查（顺带验证 token 与存活）-> sha256 -> POST receive-image。
pub async fn sync_image(params: VideoSyncParams) -> Result<VideoSyncResult, String> {
    let discovery = read_discovery()?;
    let base = format!("http://{}:{}", discovery.host, discovery.port);

    let file_path = Path::new(&params.file_path);
    if !file_path.is_file() {
        return Err(format!("图片文件不存在：{}", params.file_path));
    }
    let mime = mime_for_path(file_path)?;
    let sha = sha256_file(file_path)?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| format!("初始化同步客户端失败：{e}"))?;

    // 健康检查：bridge.json 可能是上个已退出实例的残留，连接失败/401/协议不符均按离线处理
    let health = client
        .get(format!("{base}/bridge/health"))
        .bearer_auth(&discovery.token)
        .send()
        .await
        .map_err(|_| format!("{OFFLINE_ERROR_PREFIX}CY Video Studio 当前未连接，请启动 CY Video Studio 后重试"))?;
    if !health.status().is_success() {
        return Err(format!(
            "{OFFLINE_ERROR_PREFIX}CY Video Studio Bridge 校验失败（HTTP {}），请重启 CY Video Studio 后重试",
            health.status().as_u16()
        ));
    }
    let health_body: serde_json::Value = health
        .json()
        .await
        .map_err(|_| format!("{OFFLINE_ERROR_PREFIX}CY Video Studio 响应异常，请重启 CY Video Studio 后重试"))?;
    if health_body.get("protocol").and_then(|v| v.as_str()) != Some(BRIDGE_PROTOCOL) {
        return Err(format!(
            "{OFFLINE_ERROR_PREFIX}CY Video Studio Bridge 协议不匹配，请升级 CY Video Studio"
        ));
    }

    // 去重键是 (source_app, source_asset_id)；接收端对重复 sourceAssetId 幂等返回同一素材。
    // V0.4.0 契约：user_prompt_raw → sourcePrompt（用户原话）；final_prompt → videoPrompt（优化稿）。
    // 旧调用方只传 prompt（= final_prompt）时：sourcePrompt 回落 prompt，videoPrompt 仍为空
    // 由接收端按"未优化"语义处理——绝不把优化稿伪装成用户原话的同时又丢失优化标记。
    let raw = params
        .user_prompt_raw
        .clone()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            // 未传 final_prompt 说明走旧语义：prompt 既当 raw 也当优化稿无凭据，只落 raw
            if params.final_prompt.is_none() {
                params.prompt.clone().filter(|s| !s.trim().is_empty())
            } else {
                None
            }
        });
    let optimized = params
        .final_prompt
        .clone()
        .filter(|s| !s.trim().is_empty());
    let negative = params
        .final_negative_prompt
        .clone()
        .filter(|s| !s.trim().is_empty());
    let optimized_flag = params
        .prompt_optimized
        .unwrap_or(optimized.is_some());
    let body = serde_json::json!({
        "sourceApp": SOURCE_APP,
        "sourceAssetId": params.image_id,
        "projectId": null,
        "filePath": params.file_path,
        "sha256": sha,
        "mimeType": mime,
        "width": params.width,
        "height": params.height,
        "sourcePrompt": raw,
        "videoPrompt": optimized,
        "negativePrompt": negative,
        "promptStatus": if optimized_flag { "optimized" } else { "not_optimized" },
        "promptLanguage": "zh-CN",
        "displayName": params.display_title.clone().filter(|s| !s.trim().is_empty()),
        "openCreator": false,
        "sourceTaskId": params.task_id,
        "sourceModel": params.model,
        "sourceCreatedAt": params.created_at,
        "sourceFileName": params.file_name,
    });
    let resp = client
        .post(format!("{base}/bridge/receive-image"))
        .bearer_auth(&discovery.token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("同步请求失败：{e}"))?;
    let status = resp.status();
    let resp_body: serde_json::Value = resp.json().await.map_err(|e| format!("解析同步响应失败：{e}"))?;
    if !status.is_success() {
        let msg = resp_body
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        return Err(format!("同步到 CY Video Studio 失败：{msg}"));
    }
    let asset_id = resp_body
        .get("assetId")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let already_synced = resp_body
        .get("alreadySynced")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Ok(VideoSyncResult {
        message: if already_synced {
            "该素材已同步到 CY Video Studio".into()
        } else {
            "已同步到 CY Video Studio".into()
        },
        asset_id,
        already_synced,
    })
}
