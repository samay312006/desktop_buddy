import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { CharacterManifest } from "../types/manifest";

export interface SpriteHandle {
  draw(frame: { row: number; col: number }, facingRight: boolean): void;
  /** Is the backing-store pixel (sprite-local, physical px) non-transparent? */
  isOpaqueAt(x: number, y: number): boolean;
}

interface Props {
  manifest: CharacterManifest;
  spritesheet: ImageBitmap | null;
}

/**
 * Canvas sprite renderer. The backing store is the sprite's physical size; the
 * CSS size divides by devicePixelRatio so the sprite occupies exactly that many
 * physical pixels on screen (DPI-correct). Drawing is driven imperatively from
 * the game loop via the forwarded `draw` handle.
 */
export const SpriteRenderer = forwardRef<SpriteHandle, Props>(
  ({ manifest, spritesheet }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const dpr = window.devicePixelRatio || 1;
    const fw = manifest.frameWidth;
    const fh = manifest.frameHeight;
    const sw = Math.round(fw * manifest.scale); // physical sprite px
    const sh = Math.round(fh * manifest.scale);

    useEffect(() => {
      const c = canvasRef.current;
      if (!c) return;
      c.width = sw;
      c.height = sh;
      c.style.width = `${sw / dpr}px`;
      c.style.height = `${sh / dpr}px`;
      const ctx = c.getContext("2d");
      if (ctx) ctx.imageSmoothingEnabled = false;
    }, [sw, sh, dpr]);

    useImperativeHandle(
      ref,
      () => ({
        draw(frame, facingRight) {
          const c = canvasRef.current;
          if (!c) return;
          const ctx = c.getContext("2d");
          if (!ctx) return;
          ctx.clearRect(0, 0, c.width, c.height);
          if (!spritesheet) return;
          ctx.imageSmoothingEnabled = false;
          ctx.save();
          if (!facingRight) {
            ctx.translate(sw, 0);
            ctx.scale(-1, 1);
          }
          ctx.drawImage(spritesheet, frame.col * fw, frame.row * fh, fw, fh, 0, 0, sw, sh);
          ctx.restore();
        },
        isOpaqueAt(x, y) {
          const c = canvasRef.current;
          if (!c || x < 0 || y < 0 || x >= c.width || y >= c.height) return false;
          const ctx = c.getContext("2d", { willReadFrequently: true });
          if (!ctx) return false;
          try {
            return ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3] > 12;
          } catch {
            return true; // if readback fails, treat as solid (stay interactive)
          }
        },
      }),
      [spritesheet, sw, sh, fw, fh],
    );

    return <canvas ref={canvasRef} className="sprite-canvas" />;
  },
);

SpriteRenderer.displayName = "SpriteRenderer";
