//! Tauri commands exposed to the frontend.

use crate::character_manager::{self, CharacterManifest};
use crate::AppState;
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager, PhysicalPosition, State, Window};

#[tauri::command]
pub fn get_characters(state: State<AppState>) -> Vec<CharacterManifest> {
    state.characters.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_character(state: State<AppState>, id: String) -> Option<CharacterManifest> {
    state.characters.lock().unwrap().iter().find(|c| c.id == id).cloned()
}

#[tauri::command]
pub fn get_spritesheet(state: State<AppState>, id: String) -> Result<String, String> {
    character_manager::spritesheet_base64(&state.home, &id)
}

#[tauri::command]
pub fn get_preview(state: State<AppState>, id: String) -> Result<String, String> {
    character_manager::preview_base64(&state.home, &id)
}

#[tauri::command]
pub fn spawn_character(app: AppHandle, id: String) -> Result<String, String> {
    crate::spawn_and_track(&app, &id)
}

#[tauri::command]
pub fn despawn_character(app: AppHandle, window_id: String) -> Result<(), String> {
    crate::despawn_tracked(&app, &window_id);
    Ok(())
}

/// Delete a character package from disk and despawn all of its instances.
#[tauri::command]
pub fn delete_character(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    let labels: Vec<String> = state
        .active
        .lock()
        .unwrap()
        .iter()
        .filter(|a| a.id == id)
        .map(|a| a.label.clone())
        .collect();
    for label in labels {
        crate::despawn_tracked(&app, &label);
    }
    character_manager::delete_character(&state.home, &id)?;
    *state.characters.lock().unwrap() = character_manager::load_characters(&state.home);
    Ok(())
}

#[derive(Serialize)]
pub struct ActiveDto {
    pub label: String,
    pub id: String,
    pub name: String,
}

#[tauri::command]
pub fn list_active(state: State<AppState>) -> Vec<ActiveDto> {
    let chars = state.characters.lock().unwrap();
    state
        .active
        .lock()
        .unwrap()
        .iter()
        .map(|a| {
            let name = chars
                .iter()
                .find(|c| c.id == a.id)
                .map(|c| c.name.clone())
                .unwrap_or_else(|| a.id.clone());
            ActiveDto {
                label: a.label.clone(),
                id: a.id.clone(),
                name,
            }
        })
        .collect()
}

/// Install a character from a Shimeji-EE zip, then refresh the character list.
#[tauri::command]
pub fn install_character(state: State<AppState>, zip_path: String) -> Result<CharacterManifest, String> {
    let manifest = crate::importer::install_from_zip(&state.home, std::path::Path::new(&zip_path))?;
    *state.characters.lock().unwrap() = character_manager::load_characters(&state.home);
    Ok(manifest)
}

/// Re-read the characters directory (e.g. after dropping in a new folder).
#[tauri::command]
pub fn reload_characters(state: State<AppState>) -> Vec<CharacterManifest> {
    let list = character_manager::load_characters(&state.home);
    *state.characters.lock().unwrap() = list.clone();
    list
}

#[tauri::command]
pub fn open_characters_folder(state: State<AppState>) -> Result<(), String> {
    let dir = character_manager::characters_dir(&state.home);
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &dir;
    }
    Ok(())
}

/// Capture a screen region (physical px) as a base64 PNG — used by the Thief to
/// "steal" a snippet of whatever is on screen and carry it around.
#[tauri::command]
pub fn capture_region(x: i32, y: i32, w: i32, h: i32) -> Result<String, String> {
    let (cw, ch, rgba) =
        crate::window_manager::capture_region(x, y, w, h).ok_or("capture failed")?;
    let img = image::RgbaImage::from_raw(cw, ch, rgba).ok_or("bad pixel buffer")?;
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(out.into_inner()))
}

#[tauri::command]
pub fn get_screen_size(window: Window) -> Result<(u32, u32), String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(window.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or_else(|| "no monitor found".to_string())?;
    let size = monitor.size();
    Ok((size.width, size.height))
}

#[tauri::command]
pub fn set_window_position(app: AppHandle, window_id: String, x: f64, y: f64) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&window_id) {
        win.set_position(PhysicalPosition::new(x as i32, y as i32))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Toggle whether a character window passes mouse events through to whatever is
/// behind it (used for transparent-pixel click-through).
#[tauri::command]
pub fn set_click_through(app: AppHandle, window_id: String, ignore: bool) {
    if let Some(win) = app.get_webview_window(&window_id) {
        let _ = win.set_ignore_cursor_events(ignore);
    }
}

#[tauri::command]
pub fn get_window_label(window: Window) -> String {
    window.label().to_string()
}

/// Native handle (HWND) of the calling window, to exclude its own window when
/// treating other character windows as surfaces.
#[tauri::command]
pub fn get_window_id(window: Window) -> i64 {
    #[cfg(target_os = "windows")]
    {
        window.hwnd().map(|h| h.0 as isize as i64).unwrap_or(0)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &window;
        0
    }
}

#[tauri::command]
pub fn get_cursor_pos() -> (i32, i32) {
    crate::window_manager::cursor_pos()
}

#[tauri::command]
pub fn move_os_window(id: i64, x: i32, y: i32) {
    crate::window_manager::move_window(id, x, y);
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}
