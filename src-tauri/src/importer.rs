//! Imports original Shimeji-EE character packages (zip) into our format.
//!
//! Community Shimeji ship a folder of individual frames `shime1.png … shimeN.png`
//! (plus `conf/*.xml`). We pack those frames into a single spritesheet grid and
//! generate a `manifest.json`, mapping the well-known standard frame layout onto
//! our 9 animations. Frame roles follow the canonical Shimeji set; anything
//! missing falls back to the standing frame, so the result is always usable.

use crate::character_manager::{
    characters_dir, AnimationDef, BehaviorConfig, CharacterManifest,
};
use image::{imageops, RgbaImage};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Read;
use std::path::Path;

fn parse_shime(name: &str) -> Option<u32> {
    // basename like "shime12.png"
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name).to_lowercase();
    let mid = base.strip_prefix("shime")?.strip_suffix(".png")?;
    mid.parse().ok()
}

fn sanitize_id(stem: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in stem.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "imported".to_string()
    } else {
        trimmed
    }
}

fn prettify(stem: &str) -> String {
    stem.replace(['_', '-'], " ").split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn install_from_zip(home: &Path, zip_path: &Path) -> Result<CharacterManifest, String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("open zip: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read zip: {e}"))?;

    // Collect the shimeN.png frames.
    let mut frames: BTreeMap<u32, RgbaImage> = BTreeMap::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        if let Some(num) = parse_shime(&name) {
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            if let Ok(img) = image::load_from_memory(&buf) {
                frames.insert(num, img.to_rgba8());
            }
        }
    }
    if frames.is_empty() {
        return Err("No Shimeji frames (shime1.png, shime2.png, …) found in the zip.".into());
    }

    let cell_w = frames.values().map(|f| f.width()).max().unwrap();
    let cell_h = frames.values().map(|f| f.height()).max().unwrap();
    let first_key = *frames.keys().next().unwrap();

    // Pick frames for an animation row, falling back to the first frame.
    let pick = |nums: &[u32]| -> Vec<u32> {
        let v: Vec<u32> = nums.iter().copied().filter(|n| frames.contains_key(n)).collect();
        if v.is_empty() {
            vec![first_key]
        } else {
            v
        }
    };

    // (name, frame numbers, loop) — canonical Shimeji frame roles.
    let rows: Vec<(&str, Vec<u32>, bool)> = vec![
        ("idle", pick(&[1]), true),
        ("walk_right", pick(&[2, 3]), true),
        ("walk_left", pick(&[2, 3]), true),
        ("fall", pick(&[5]), true),
        ("climb_up", pick(&[11, 12]), true),
        ("climb_down", pick(&[13, 14]), true),
        ("sit", pick(&[4]), true),
        ("grabbed", pick(&[22, 23]), true),
        ("thrown", pick(&[5]), false),
    ];

    let max_cols = rows.iter().map(|(_, f, _)| f.len() as u32).max().unwrap().max(1);
    let mut sheet = RgbaImage::new(cell_w * max_cols, cell_h * rows.len() as u32);
    for (ri, (_, fnums, _)) in rows.iter().enumerate() {
        for (ci, num) in fnums.iter().enumerate() {
            if let Some(frame) = frames.get(num) {
                let dx = ci as u32 * cell_w + (cell_w - frame.width()) / 2;
                let dy = ri as u32 * cell_h + (cell_h - frame.height()); // bottom-anchored
                imageops::overlay(&mut sheet, frame, dx as i64, dy as i64);
            }
        }
    }

    let stem = zip_path.file_stem().and_then(|s| s.to_str()).unwrap_or("imported");
    let id = sanitize_id(stem);
    let name = prettify(stem);

    let dir = characters_dir(home).join(&id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    sheet
        .save(dir.join("spritesheet.png"))
        .map_err(|e| format!("write spritesheet: {e}"))?;

    // Preview: the first frame fit into 128x128.
    let preview = imageops::thumbnail(frames.get(&first_key).unwrap(), 128, 128);
    preview
        .save(dir.join("preview.png"))
        .map_err(|e| format!("write preview: {e}"))?;

    let mut animations: HashMap<String, AnimationDef> = HashMap::new();
    for (ri, (anim, fnums, looping)) in rows.iter().enumerate() {
        animations.insert(
            anim.to_string(),
            AnimationDef {
                row: ri as u32,
                frames: fnums.len() as u32,
                loops: *looping,
            },
        );
    }

    let manifest = CharacterManifest {
        id: id.clone(),
        name,
        author: "imported".to_string(),
        version: "1.0.0".to_string(),
        personality: String::new(),
        frame_width: cell_w,
        frame_height: cell_h,
        fps: 8.0,
        scale: 1.0,
        animations,
        behaviors: BehaviorConfig {
            gravity: 0.5,
            walk_speed: 2.0,
            climb_speed: 1.5,
            can_climb: true,
            can_sit: true,
            sit_chance: 0.002,
            turn_chance: 0.0015,
            speak_chance: 0.0,
        },
    };
    fs::write(
        dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    Ok(manifest)
}
