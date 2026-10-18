//! Shimeji app entry: spawns character windows, streams OS window rects to the
//! frontend, persists the active set, and hosts a tray + control panel.

mod character_manager;
mod importer;
mod ipc;
mod window_manager;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use character_manager::CharacterManifest;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, RunEvent, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};
use window_manager::CHARACTER_WINDOW_TITLE;

/// A running character window.
pub struct ActiveInstance {
    pub label: String,
    pub id: String,
}

pub struct AppState {
    pub home: PathBuf,
    pub characters: Mutex<Vec<CharacterManifest>>,
    pub active: Mutex<Vec<ActiveInstance>>,
    pub spawn_counter: Mutex<usize>,
}

impl AppState {
    pub fn persist_active(&self) {
        let ids: Vec<String> = self.active.lock().unwrap().iter().map(|a| a.id.clone()).collect();
        character_manager::write_active(&self.home, &ids);
    }
}

/// Allocate a label for a new instance of `id` and record it in the active set.
/// Returns the label + manifest so the caller can build the window.
fn track_active(app: &AppHandle, id: &str) -> Result<(String, CharacterManifest), String> {
    let state = app.state::<AppState>();
    let manifest = state
        .characters
        .lock()
        .unwrap()
        .iter()
        .find(|c| c.id == id)
        .cloned()
        .ok_or_else(|| format!("unknown character: {id}"))?;
    let index = {
        let mut counter = state.spawn_counter.lock().unwrap();
        *counter += 1;
        *counter
    };
    let label = format!("char__{}__{}", manifest.id, index);
    state.active.lock().unwrap().push(ActiveInstance {
        label: label.clone(),
        id: id.to_string(),
    });
    state.persist_active();
    Ok((label, manifest))
}

/// Spawn a character window for `id` from a command. Webview windows must be
/// created on the main thread (creating/showing from a command's worker thread
/// doesn't reliably show them), so dispatch the build there.
pub fn spawn_and_track(app: &AppHandle, id: &str) -> Result<String, String> {
    let (label, manifest) = track_active(app, id)?;
    let app2 = app.clone();
    let label2 = label.clone();
    app.run_on_main_thread(move || {
        if let Err(e) = create_character_window(&app2, &manifest, &label2) {
            eprintln!("create_character_window({label2}) failed: {e}");
        }
    })
    .map_err(|e| e.to_string())?;
    Ok(label)
}

/// Close a character window and drop it from the active set.
pub fn despawn_tracked(app: &AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.close();
    }
    let state = app.state::<AppState>();
    state.active.lock().unwrap().retain(|a| a.label != label);
    state.persist_active();
}

/// Create one character window sized `frameW*scale*2 × frameH*scale*2`
/// (physical px), placed at a random x along the bottom of the primary monitor.
pub fn create_character_window(
    app: &AppHandle,
    manifest: &CharacterManifest,
    label: &str,
) -> tauri::Result<()> {
    let phys_w = manifest.frame_width as f64 * manifest.scale * 2.0;
    let phys_h = manifest.frame_height as f64 * manifest.scale * 2.0;
    let scale_factor = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);

    let win = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(CHARACTER_WINDOW_TITLE)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .inner_size(phys_w / scale_factor, phys_h / scale_factor)
        .build()?;

    // Monitor queries can fail when this runs off the main thread (e.g. from the
    // tray-panel "+" command), so keep positioning non-fatal — show() must
    // always run, and the frontend physics will settle the character anyway.
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let size = monitor.size();
        let pos = monitor.position();
        let max_x = (size.width as f64 - phys_w).max(0.0);
        let x = pos.x as f64 + rand::random::<f64>() * max_x;
        let y = pos.y as f64 + (size.height as f64 - phys_h);
        let _ = win.set_position(PhysicalPosition::new(x as i32, y as i32));
    }
    win.show()?;
    Ok(())
}

/// The hidden control-panel window. Closing it just hides it (so the app stays
/// alive and the panel can be reopened from the tray).
fn create_tray_panel(app: &AppHandle) -> tauri::Result<()> {
    let win = WebviewWindowBuilder::new(app, "tray-panel", WebviewUrl::App("index.html".into()))
        .title("Shimeji")
        .inner_size(340.0, 560.0)
        .min_inner_size(300.0, 420.0)
        .resizable(true)
        .always_on_top(true)
        .visible(false)
        .build()?;
    let w = win.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = w.hide();
        }
    });
    Ok(())
}

fn toggle_panel(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("tray-panel") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

fn start_window_watch(app: AppHandle) {
    std::thread::spawn(move || loop {
        let rects = window_manager::enumerate_windows();
        let _ = app.emit("window-rects", &rects);
        std::thread::sleep(Duration::from_millis(150));
    });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Panel", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Shimeji", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut builder = TrayIconBuilder::new()
        .tooltip("Shimeji")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => toggle_panel(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_panel(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Single-instance must be registered first: a second launch just
        // reveals the panel instead of colliding on the WebView2 data dir.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("tray-panel") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            ipc::get_characters,
            ipc::get_character,
            ipc::get_spritesheet,
            ipc::get_preview,
            ipc::spawn_character,
            ipc::despawn_character,
            ipc::delete_character,
            ipc::install_character,
            ipc::list_active,
            ipc::reload_characters,
            ipc::open_characters_folder,
            ipc::get_screen_size,
            ipc::set_window_position,
            ipc::set_click_through,
            ipc::get_window_label,
            ipc::get_window_id,
            ipc::get_cursor_pos,
            ipc::move_os_window,
            ipc::capture_region,
            ipc::quit_app,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            let home = app
                .path()
                .home_dir()
                .expect("could not resolve home directory");

            character_manager::ensure_builtin_characters(&home)
                .expect("could not write builtin characters");
            let characters = character_manager::load_characters(&home);

            // First run => activate every builtin; otherwise restore active.json.
            let active_ids = character_manager::read_active(&home)
                .unwrap_or_else(|| characters.iter().map(|c| c.id.clone()).collect());

            app.manage(AppState {
                home,
                characters: Mutex::new(characters),
                active: Mutex::new(Vec::new()),
                spawn_counter: Mutex::new(0),
            });

            create_tray_panel(&handle)?;
            // We're on the main thread here, so build restored windows directly.
            for id in &active_ids {
                match track_active(&handle, id) {
                    Ok((label, manifest)) => {
                        if let Err(e) = create_character_window(&handle, &manifest, &label) {
                            eprintln!("restore build {label}: {e}");
                        }
                    }
                    Err(e) => eprintln!("restore: {e}"),
                }
            }

            build_tray(&handle)?;
            start_window_watch(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, event| {
        // Keep running in the tray even when every window is closed; only an
        // explicit Quit (which carries an exit code) actually exits.
        if let RunEvent::ExitRequested { code, api, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}
