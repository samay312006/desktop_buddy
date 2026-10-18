import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { CharacterManifest } from "../types/manifest";

interface ActiveDto {
  label: string;
  id: string;
  name: string;
}

export function TrayPanel() {
  const [characters, setCharacters] = useState<CharacterManifest[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [active, setActive] = useState<ActiveDto[]>([]);
  const [status, setStatus] = useState<string>("Ready");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    const [chars, act] = await Promise.all([
      invoke<CharacterManifest[]>("get_characters"),
      invoke<ActiveDto[]>("list_active"),
    ]);
    setCharacters(chars);
    setActive(act);
    setPreviews((prev) => {
      const missing = chars.filter((c) => !prev[c.id]);
      if (missing.length) {
        missing.forEach(async (c) => {
          try {
            const b64 = await invoke<string>("get_preview", { id: c.id });
            setPreviews((p) => ({ ...p, [c.id]: `data:image/png;base64,${b64}` }));
          } catch {
            /* ignore */
          }
        });
      }
      return prev;
    });
  }, []);

  useEffect(() => {
    loadList().catch((e) => setStatus(`⚠ load: ${e}`));
  }, [loadList]);

  // Run an action, surfacing success/failure in the status line so nothing
  // fails silently.
  async function run(okMsg: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      setStatus(okMsg);
      await loadList();
    } catch (e) {
      setStatus(`⚠ ${e}`);
    }
  }

  const spawn = (c: CharacterManifest) => run(`Added ${c.name}`, () => invoke("spawn_character", { id: c.id }));
  const despawn = (a: ActiveDto) => run(`Removed ${a.name}`, () => invoke("despawn_character", { windowId: a.label }));
  const confirmDelete = (c: CharacterManifest) => {
    setConfirmId(null);
    setPreviews((p) => {
      const r = { ...p };
      delete r[c.id];
      return r;
    });
    return run(`Deleted ${c.name}`, () => invoke("delete_character", { id: c.id }));
  };
  const reload = () => run("Reloaded characters", () => invoke("reload_characters"));
  const openFolder = () => run("Opened folder", () => invoke("open_characters_folder"));
  const quit = () => invoke("quit_app").catch((e) => setStatus(`⚠ ${e}`));

  const addZip = async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: "Shimeji character", extensions: ["zip"] }],
    });
    if (typeof picked !== "string") return;
    setStatus("Importing…");
    await run("Installed character", async () => {
      const m = await invoke<CharacterManifest>("install_character", { zipPath: picked });
      setStatus(`Installed ${m.name}`);
    });
  };

  const countById = (id: string) => active.filter((a) => a.id === id).length;

  return (
    <div className="tray-panel">
      <header className="tp-header">
        <span className="tp-title">🐾 Shimeji</span>
        <span className="tp-badge">{active.length} active</span>
      </header>

      <section className="tp-section">
        <h3 className="tp-h3">Running</h3>
        {active.length === 0 && <p className="tp-empty">No characters on screen.</p>}
        <ul className="tp-active">
          {active.map((a) => (
            <li key={a.label} className="tp-active-row">
              <img className="tp-thumb-sm" src={previews[a.id]} alt="" />
              <span className="tp-name">{a.name}</span>
              <button className="tp-x" title="Remove from screen" onClick={() => despawn(a)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="tp-section tp-grow">
        <div className="tp-chars-head">
          <h3 className="tp-h3">Characters</h3>
          <button className="tp-import" onClick={addZip} title="Import a Shimeji .zip">
            + Add Character
          </button>
        </div>
        <ul className="tp-chars">
          {characters.map((c) => (
            <li key={c.id} className="tp-char-row">
              <img className="tp-thumb" src={previews[c.id]} alt="" />
              <div className="tp-char-meta">
                <span className="tp-name">{c.name}</span>
                <span className="tp-author">
                  {c.author}
                  {countById(c.id) > 0 ? ` · ${countById(c.id)} on screen` : ""}
                </span>
              </div>
              {confirmId === c.id ? (
                <div className="tp-confirm">
                  <span>Delete?</span>
                  <button className="tp-yes" onClick={() => confirmDelete(c)}>
                    Yes
                  </button>
                  <button className="tp-no" onClick={() => setConfirmId(null)}>
                    No
                  </button>
                </div>
              ) : (
                <>
                  <button className="tp-add" title="Add to screen" onClick={() => spawn(c)}>
                    +
                  </button>
                  <button className="tp-del" title="Delete character" onClick={() => setConfirmId(c.id)}>
                    🗑
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

      <div className="tp-status" title={status}>
        {status}
      </div>

      <footer className="tp-footer">
        <button onClick={openFolder}>Open Folder</button>
        <button onClick={reload}>Reload</button>
        <button className="tp-quit" onClick={quit}>
          Quit
        </button>
      </footer>
    </div>
  );
}
