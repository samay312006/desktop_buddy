//! OS window enumeration + helpers (cursor position, moving foreign windows).
//! Returns screen-space rectangles in physical pixels. Only the Windows path is
//! implemented; macOS/Linux return empties so the app still compiles/runs.

use serde::Serialize;

/// Title given to every shimeji character window. Used so the frontend can tell
/// character windows apart from real app windows.
pub const CHARACTER_WINDOW_TITLE: &str = "Shimeji Character";

/// A screen-space rectangle in physical pixels, with enough OS context for
/// speech (title) and window-nudging (id).
#[derive(Debug, Clone, Serialize)]
pub struct Rect {
    pub id: i64, // native handle (HWND) as i64; 0 if unavailable
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub title: String,
    pub foreground: bool,
    pub is_character: bool,
}

pub fn enumerate_windows() -> Vec<Rect> {
    platform::enumerate_windows()
}

/// Current mouse cursor position in physical screen pixels.
pub fn cursor_pos() -> (i32, i32) {
    platform::cursor_pos()
}

/// Move a foreign OS window (by native handle) to a physical-pixel position.
pub fn move_window(id: i64, x: i32, y: i32) {
    platform::move_window(id, x, y);
}

/// Grab a screen region (physical px) as RGBA pixels: `(width, height, rgba)`.
pub fn capture_region(x: i32, y: i32, w: i32, h: i32) -> Option<(u32, u32, Vec<u8>)> {
    platform::capture_region(x, y, w, h)
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{Rect, CHARACTER_WINDOW_TITLE};
    use std::ffi::c_void;
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, POINT, RECT, TRUE};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits,
        GetDC, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        HGDIOBJ, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetCursorPos, GetForegroundWindow, GetWindowLongW, GetWindowRect,
        GetWindowTextW, IsIconic, IsWindowVisible, SetWindowPos, GWL_EXSTYLE, HWND_TOP,
        SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, WS_EX_TOOLWINDOW,
    };

    struct Collector {
        rects: Vec<Rect>,
        foreground: isize,
    }

    pub fn enumerate_windows() -> Vec<Rect> {
        let fg = unsafe { GetForegroundWindow() };
        let mut collector = Collector {
            rects: Vec::new(),
            foreground: fg.0 as isize,
        };
        unsafe {
            let _ = EnumWindows(Some(enum_proc), LPARAM(&mut collector as *mut Collector as isize));
        }
        collector.rects
    }

    pub fn cursor_pos() -> (i32, i32) {
        let mut p = POINT::default();
        unsafe {
            let _ = GetCursorPos(&mut p);
        }
        (p.x, p.y)
    }

    pub fn move_window(id: i64, x: i32, y: i32) {
        if id == 0 {
            return;
        }
        let hwnd = HWND(id as isize as *mut c_void);
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                HWND_TOP,
                x,
                y,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }

    pub fn capture_region(x: i32, y: i32, w: i32, h: i32) -> Option<(u32, u32, Vec<u8>)> {
        if w <= 0 || h <= 0 || w > 4000 || h > 4000 {
            return None;
        }
        unsafe {
            let screen = GetDC(None);
            if screen.is_invalid() {
                return None;
            }
            let mem = CreateCompatibleDC(screen);
            let bmp = CreateCompatibleBitmap(screen, w, h);
            let old = SelectObject(mem, HGDIOBJ(bmp.0));
            let blit_ok = BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY).is_ok();

            let mut bmi = BITMAPINFO::default();
            bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bmi.bmiHeader.biWidth = w;
            bmi.bmiHeader.biHeight = -h; // top-down
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = BI_RGB.0;

            let mut buf = vec![0u8; (w * h * 4) as usize];
            let lines = GetDIBits(
                mem,
                bmp,
                0,
                h as u32,
                Some(buf.as_mut_ptr() as *mut c_void),
                &mut bmi,
                DIB_RGB_COLORS,
            );

            SelectObject(mem, old);
            let _ = DeleteObject(HGDIOBJ(bmp.0));
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);

            if !blit_ok || lines == 0 {
                return None;
            }
            // BGRA (GDI) -> RGBA, force opaque alpha.
            let mut rgba = vec![0u8; buf.len()];
            for i in (0..buf.len()).step_by(4) {
                rgba[i] = buf[i + 2];
                rgba[i + 1] = buf[i + 1];
                rgba[i + 2] = buf[i];
                rgba[i + 3] = 255;
            }
            Some((w as u32, h as u32, rgba))
        }
    }

    fn window_title(hwnd: HWND) -> String {
        let mut buf = [0u16; 256];
        let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
        if len <= 0 {
            String::new()
        } else {
            String::from_utf16_lossy(&buf[..len as usize])
        }
    }

    fn is_cloaked(hwnd: HWND) -> bool {
        let mut cloaked: u32 = 0;
        let ok = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut u32 as *mut c_void,
                std::mem::size_of::<u32>() as u32,
            )
        };
        ok.is_ok() && cloaked != 0
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let collector = &mut *(lparam.0 as *mut Collector);

        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() || is_cloaked(hwnd) {
            return TRUE;
        }

        let title = window_title(hwnd);
        if title.is_empty() {
            return TRUE;
        }
        let is_character = title == CHARACTER_WINDOW_TITLE;

        // Skip tool windows (palettes/tooltips) — but keep character windows even
        // though skip-taskbar marks them as tool windows, so cats can walk on
        // each other.
        if !is_character {
            let exstyle = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            if exstyle & WS_EX_TOOLWINDOW.0 != 0 {
                return TRUE;
            }
        }

        let mut r = RECT::default();
        if GetWindowRect(hwnd, &mut r).is_err() {
            return TRUE;
        }
        let width = r.right - r.left;
        let height = r.bottom - r.top;
        if width < 40 || height < 40 || width > 30000 || height > 30000 {
            return TRUE;
        }

        let id = hwnd.0 as isize as i64;
        collector.rects.push(Rect {
            id,
            x: r.left,
            y: r.top,
            width,
            height,
            title,
            foreground: hwnd.0 as isize == collector.foreground,
            is_character,
        });
        TRUE
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use super::Rect;
    pub fn enumerate_windows() -> Vec<Rect> {
        Vec::new()
    }
    pub fn cursor_pos() -> (i32, i32) {
        (0, 0)
    }
    pub fn move_window(_id: i64, _x: i32, _y: i32) {}
    pub fn capture_region(_x: i32, _y: i32, _w: i32, _h: i32) -> Option<(u32, u32, Vec<u8>)> {
        None
    }
}
