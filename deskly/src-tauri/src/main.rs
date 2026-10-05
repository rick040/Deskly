#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};
use sysinfo::System;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    webview::WebviewBuilder,
    window::WindowBuilder,
    Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WindowEvent,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const NO_WINDOW: u32 = 0x0800_0000;

struct Sys(Mutex<System>);

#[derive(Serialize)]
struct AppEntry {
    name: String,
    path: String,
}

// ---------- config (layout.json in the app config dir) ----------

fn config_path(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = fs::create_dir_all(&dir);
    dir.join("layout.json")
}

#[tauri::command]
fn load_config(app: tauri::AppHandle) -> Option<String> {
    fs::read_to_string(config_path(&app)).ok()
}

#[tauri::command]
fn save_config(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let path = config_path(&app);
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

// ---------- apps ----------

fn collect_lnk(dir: &Path, out: &mut Vec<AppEntry>, depth: u8) {
    if depth > 4 {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_lnk(&p, out, depth + 1);
        } else if p
            .extension()
            .map(|x| x.eq_ignore_ascii_case("lnk"))
            .unwrap_or(false)
        {
            let name = p
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let lower = name.to_lowercase();
            if lower.contains("uninstall") || lower.contains("verwijder") || lower.contains("readme")
            {
                continue;
            }
            out.push(AppEntry {
                name,
                path: p.to_string_lossy().to_string(),
            });
        }
    }
}

/// Everything in the Start Menu (includes Chrome "Apps" shortcuts).
#[tauri::command]
async fn list_apps() -> Vec<AppEntry> {
    let mut out = Vec::new();
    for var in ["ProgramData", "APPDATA"] {
        if let Ok(base) = std::env::var(var) {
            let dir = Path::new(&base).join("Microsoft/Windows/Start Menu/Programs");
            collect_lnk(&dir, &mut out, 0);
        }
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    out.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));
    out
}

/// Returns the file's icon as a PNG data URL (via PowerShell, no extra crates).
#[tauri::command]
async fn get_icon(path: String) -> Option<String> {
    let script = "Add-Type -AssemblyName System.Drawing; \
        $i=[System.Drawing.Icon]::ExtractAssociatedIcon($env:DESKLY_PATH); \
        if($i){$m=New-Object IO.MemoryStream; \
        $i.ToBitmap().Save($m,[System.Drawing.Imaging.ImageFormat]::Png); \
        [Convert]::ToBase64String($m.ToArray())}";
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("DESKLY_PATH", &path);
    #[cfg(windows)]
    cmd.creation_flags(NO_WINDOW);
    let out = cmd.output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(format!("data:image/png;base64,{s}"))
    }
}

/// Opens a shortcut, exe, folder or URL the same way double-clicking would.
#[tauri::command]
fn launch(path: String) -> Result<(), String> {
    let mut cmd = Command::new("explorer");
    cmd.arg(&path);
    #[cfg(windows)]
    cmd.creation_flags(NO_WINDOW);
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ---------- stats ----------

#[tauri::command]
fn sys_stats(state: tauri::State<Sys>) -> (f32, f32) {
    let mut sys = state.0.lock().unwrap();
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    let cpu = sys.global_cpu_usage();
    let ram = sys.used_memory() as f32 / sys.total_memory().max(1) as f32 * 100.0;
    (cpu, ram)
}

// ---------- web panels (native child webviews, so Notion etc. work) ----------

fn web_label(id: &str) -> String {
    format!("web-{id}")
}

#[tauri::command]
fn web_set(
    app: tauri::AppHandle,
    id: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let label = web_label(&id);
    if let Some(wv) = app.get_webview(&label) {
        wv.set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(w.max(10.0), h.max(10.0)))
            .map_err(|e| e.to_string())?;
    } else {
        let window = app.get_window("main").ok_or("main window missing")?;
        let parsed = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;
        window
            .add_child(
                WebviewBuilder::new(&label, WebviewUrl::External(parsed)),
                LogicalPosition::new(x, y),
                LogicalSize::new(w.max(10.0), h.max(10.0)),
            )
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn web_close(app: tauri::AppHandle, id: String) {
    if let Some(wv) = app.get_webview(&web_label(&id)) {
        let _ = wv.close();
    }
}

/// Native views always draw above the page, so hide them while a dialog is open.
#[tauri::command]
fn web_hide_all(app: tauri::AppHandle, hidden: bool) {
    for (label, wv) in app.webviews() {
        if label.starts_with("web-") {
            let _ = if hidden { wv.hide() } else { wv.show() };
        }
    }
}

fn main() {
    tauri::Builder::default()
        .manage(Sys(Mutex::new(System::new())))
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            list_apps,
            get_icon,
            launch,
            sys_stats,
            web_set,
            web_close,
            web_hide_all
        ])
        .setup(|app| {
            let window = WindowBuilder::new(app, "main")
                .title("Deskly")
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .skip_taskbar(true)
                .always_on_bottom(true)
                .maximized(true)
                .build()?;

            let scale = window.scale_factor()?;
            let size = window.inner_size()?.to_logical::<f64>(scale);
            window.add_child(
                WebviewBuilder::new("ui", WebviewUrl::App("index.html".into()))
                    .transparent(true)
                    .auto_resize(),
                LogicalPosition::new(0.0, 0.0),
                size,
            )?;

            // Clicking the desktop layer would raise it; push it back behind other windows.
            let w2 = window.clone();
            window.on_window_event(move |ev| {
                if let WindowEvent::Focused(true) = ev {
                    let _ = w2.set_always_on_bottom(false);
                    let _ = w2.set_always_on_bottom(true);
                }
            });

            let edit = MenuItem::with_id(app, "edit", "Edit layout", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Deskly", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&edit, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("Deskly")
                .menu(&menu)
                .on_menu_event(|app, ev| match ev.id.as_ref() {
                    "edit" => {
                        let _ = app.emit("toggle-edit", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Deskly");
}
