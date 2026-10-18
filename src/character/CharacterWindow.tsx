import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { CharacterManifest, Rect } from "../types/manifest";
import { AnimationController } from "./AnimationController";
import { BehaviorEngine, type ReactMode } from "./BehaviorEngine";
import { SpriteRenderer, type SpriteHandle } from "./SpriteRenderer";
import { SpeechBubble } from "./SpeechBubble";
import { detectContext, pickLine, type SpeechContext } from "../speech/speechPacks";

const NON_INTERRUPTIBLE = new Set(["thrown"]);
const CALM = new Set(["WALKING", "IDLE", "SITTING"]);

const REACT_BY_PERSONALITY: Record<string, ReactMode> = {
  coder: "none",
  roaster: "chase",
  love: "flee",
  thief: "chase",
};

export function CharacterWindow() {
  const [manifest, setManifest] = useState<CharacterManifest | null>(null);
  const [sheet, setSheet] = useState<ImageBitmap | null>(null);
  const [bubble, setBubble] = useState<string | null>(null);
  const [stolen, setStolen] = useState<string | null>(null);
  const spriteRef = useRef<SpriteHandle>(null);

  const rectsRef = useRef<Rect[]>([]);
  const screenRef = useRef({ width: 1920, height: 1080 });
  const engineRef = useRef<BehaviorEngine | null>(null);
  const controllerRef = useRef<AnimationController | null>(null);
  const labelRef = useRef<string>("");
  const ownIdRef = useRef<number>(0);
  const personalityRef = useRef<string>("");
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const ctxRef = useRef<SpeechContext>({ app: null, lang: null });
  const geomRef = useRef<{ ox: number; oy: number; sw: number; sh: number } | null>(null);
  const clickThroughRef = useRef<boolean | null>(null);

  // speech timing
  const nextSpeakRef = useRef(0);
  const bubbleUntilRef = useRef(0);
  // thief stealing
  const nextStealRef = useRef(0);
  const carriedUntilRef = useRef(0);

  // drag state
  const draggingRef = useRef(false);
  const grabAnchorRef = useRef({ x: 0, y: 0 });
  const historyRef = useRef<{ x: number; y: number; t: number }[]>([]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    (async () => {
      const label = await invoke<string>("get_window_label");
      labelRef.current = label;
      const id = label.split("__")[1] ?? "coder-cat";

      const m = await invoke<CharacterManifest | null>("get_character", { id });
      if (!m || cancelled) return;
      personalityRef.current = m.personality;

      const b64 = await invoke<string>("get_spritesheet", { id });
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      if (cancelled) return;

      const [sw, sh] = await invoke<[number, number]>("get_screen_size");
      screenRef.current = { width: sw, height: sh };
      ownIdRef.current = await invoke<number>("get_window_id");

      const win = getCurrentWindow();
      const size = await win.innerSize();
      const pos = await win.outerPosition();

      const spriteW = Math.round(m.frameWidth * m.scale);
      const spriteH = Math.round(m.frameHeight * m.scale);
      geomRef.current = {
        ox: (size.width - spriteW) / 2,
        oy: (size.height - spriteH) / 2,
        sw: spriteW,
        sh: spriteH,
      };

      engineRef.current = new BehaviorEngine(
        {
          behaviors: m.behaviors,
          windowW: size.width,
          windowH: size.height,
          spriteW,
          spriteH,
          unit: m.scale,
          reactMode: REACT_BY_PERSONALITY[m.personality] ?? "none",
        },
        pos.x,
        pos.y,
      );
      controllerRef.current = new AnimationController(m, "fall");

      const now = performance.now();
      nextSpeakRef.current = now + 2500 + Math.random() * 4000;
      nextStealRef.current = now + 4000 + Math.random() * 6000;

      setManifest(m);
      setSheet(bmp);

      unlisten = await listen<Rect[]>("window-rects", (e) => {
        rectsRef.current = e.payload;
      });
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!manifest || !sheet) return;
    // Cap the loop well below 60fps: moving a transparent, always-on-top OS
    // window every frame (via IPC) floods the compositor with several
    // characters on screen. ~33fps is plenty for a desktop pet.
    const FRAME_MS = 1000 / 33;
    let raf = 0;
    let last = performance.now();
    let lastSent = { x: NaN, y: NaN };
    let cursorPollAt = 0;

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const elapsed = now - last;
      if (elapsed < FRAME_MS) return; // throttle
      const dt = Math.min(0.05, elapsed / 1000);
      last = now;

      const engine = engineRef.current;
      const controller = controllerRef.current;
      const sprite = spriteRef.current;
      if (!engine || !controller || !sprite) return;

      // poll cursor + foreground context a few times a second
      if (now >= cursorPollAt) {
        cursorPollAt = now + 120;
        invoke<[number, number]>("get_cursor_pos")
          .then(([cx, cy]) => {
            cursorRef.current = { x: cx, y: cy };
            updateClickThrough(cx, cy);
          })
          .catch(() => {});
        const fg = rectsRef.current.find((r) => r.foreground && !r.isCharacter);
        if (fg) ctxRef.current = detectContext(fg.title);
      }

      // exclude our own window so we don't stand on ourselves
      const own = ownIdRef.current;
      const rects = own ? rectsRef.current.filter((r) => r.id !== own) : rectsRef.current;

      const result = engine.update(dt, rects, screenRef.current, cursorRef.current);

      if (NON_INTERRUPTIBLE.has(result.animation)) controller.forcePlay(result.animation);
      else controller.play(result.animation);
      controller.update(dt);
      sprite.draw(controller.getCurrentFrame(), result.facingRight);

      const rx = Math.round(result.x);
      const ry = Math.round(result.y);
      if (rx !== lastSent.x || ry !== lastSent.y) {
        lastSent = { x: rx, y: ry };
        invoke("set_window_position", { windowId: labelRef.current, x: rx, y: ry }).catch(() => {});
      }

      handleSpeech(now, result.state);
      if (personalityRef.current === "thief") handleThief(now, engine);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, sheet]);

  // Make the window click-through except over opaque sprite pixels, so clicks
  // pass to apps behind the cat but the cat itself stays grabbable.
  function setClickThrough(ignore: boolean) {
    if (clickThroughRef.current === ignore) return;
    clickThroughRef.current = ignore;
    invoke("set_click_through", { windowId: labelRef.current, ignore }).catch(() => {});
  }
  function updateClickThrough(cx: number, cy: number) {
    if (draggingRef.current) {
      setClickThrough(false);
      return;
    }
    const engine = engineRef.current;
    const sprite = spriteRef.current;
    const g = geomRef.current;
    if (!engine || !sprite || !g) return;
    const localX = cx - (engine.x + g.ox);
    const localY = cy - (engine.y + g.oy);
    const over = localX >= 0 && localY >= 0 && localX < g.sw && localY < g.sh && sprite.isOpaqueAt(localX, localY);
    setClickThrough(!over);
  }

  function handleSpeech(now: number, state: string) {
    if (bubbleUntilRef.current && now > bubbleUntilRef.current) {
      bubbleUntilRef.current = 0;
      setBubble(null);
    }
    if (now >= nextSpeakRef.current && bubbleUntilRef.current === 0 && CALM.has(state)) {
      const line = pickLine(personalityRef.current, ctxRef.current);
      nextSpeakRef.current = now + 8000 + Math.random() * 9000;
      if (line) {
        setBubble(line);
        bubbleUntilRef.current = now + 4200;
      }
    }
  }

  // Thief: periodically grab a snapshot of a screen region (a piece of a nearby
  // app window, or whatever is under it) and carry that "stolen" tile for a
  // while, then drop it.
  function handleThief(now: number, engine: BehaviorEngine) {
    if (carriedUntilRef.current) {
      if (now > carriedUntilRef.current) {
        carriedUntilRef.current = 0;
        setStolen(null);
      }
      return;
    }
    if (now < nextStealRef.current) return;
    nextStealRef.current = now + 9000 + Math.random() * 9000;

    const g = geomRef.current;
    if (!g) return;
    const SIZE = 72;
    const footCenterX = engine.x + g.ox + g.sw / 2;

    // Prefer stealing a patch from inside the nearest real window.
    let best: Rect | null = null;
    let bestDist = Infinity;
    for (const r of rectsRef.current) {
      if (r.id === 0 || r.id === ownIdRef.current || r.isCharacter) continue;
      const d = Math.abs(r.x + r.width / 2 - footCenterX);
      if (d < bestDist && d < 800) {
        best = r;
        bestDist = d;
      }
    }
    let rx: number;
    let ry: number;
    if (best && best.width > SIZE + 12 && best.height > SIZE + 12) {
      rx = best.x + 6 + Math.random() * (best.width - SIZE - 12);
      ry = best.y + 6 + Math.random() * (best.height - SIZE - 12);
    } else {
      rx = footCenterX - SIZE / 2;
      ry = engine.y + g.oy;
    }
    const sw = screenRef.current.width;
    const sh = screenRef.current.height;
    rx = Math.max(0, Math.min(sw - SIZE, Math.round(rx)));
    ry = Math.max(0, Math.min(sh - SIZE, Math.round(ry)));

    invoke<string>("capture_region", { x: rx, y: ry, w: SIZE, h: SIZE })
      .then((b64) => {
        setStolen(`data:image/png;base64,${b64}`);
        carriedUntilRef.current = now + 7000 + Math.random() * 4000;
        if (bubbleUntilRef.current === 0) {
          const line = pickLine("thief", ctxRef.current);
          if (line) {
            setBubble(line);
            bubbleUntilRef.current = now + 3500;
          }
        }
      })
      .catch(() => {});
  }

  // --- drag & throw ---------------------------------------------------
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const engine = engineRef.current;
    if (!engine) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    draggingRef.current = true;
    const dpr = window.devicePixelRatio || 1;
    grabAnchorRef.current = { x: e.clientX * dpr, y: e.clientY * dpr };
    historyRef.current = [{ x: e.screenX, y: e.screenY, t: performance.now() }];
    engine.grab();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const engine = engineRef.current;
    if (!engine) return;
    engine.setWindowPos(e.screenX - grabAnchorRef.current.x, e.screenY - grabAnchorRef.current.y);
    const h = historyRef.current;
    h.push({ x: e.screenX, y: e.screenY, t: performance.now() });
    if (h.length > 6) h.shift();
  };

  const onPointerUp = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const engine = engineRef.current;
    if (!engine) return;
    const h = historyRef.current;
    let vx = 0;
    let vy = 0;
    if (h.length >= 2) {
      const newest = h[h.length - 1];
      let oldest = h[0];
      for (const s of h) {
        if (newest.t - s.t <= 120) {
          oldest = s;
          break;
        }
      }
      const dtS = Math.max(0.001, (newest.t - oldest.t) / 1000);
      const cap = 40;
      vx = Math.max(-cap, Math.min(cap, (newest.x - oldest.x) / dtS / 60));
      vy = Math.max(-cap, Math.min(cap, (newest.y - oldest.y) / dtS / 60));
    }
    engine.release(vx, vy);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    engineRef.current?.sendHome(screenRef.current.height);
  };

  if (!manifest) return null;

  return (
    <div
      className="character-root"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={onContextMenu}
    >
      <SpeechBubble text={bubble} />
      <SpriteRenderer ref={spriteRef} manifest={manifest} spritesheet={sheet} />
      {stolen && <img className="stolen-item" src={stolen} alt="" />}
    </div>
  );
}
