import type { CharacterManifest } from "../types/manifest";

/**
 * Tracks which animation is playing and advances frames based on fps timing.
 * Non-looping animations run to completion and are not interrupted unless
 * `forcePlay()` is used.
 */
export class AnimationController {
  private manifest: CharacterManifest;
  private current: string;
  private frameIndex = 0;
  private elapsed = 0; // seconds accumulated toward the next frame
  private frameDuration: number;
  private done = false; // a non-looping animation has finished
  private onComplete?: () => void;

  constructor(manifest: CharacterManifest, initial = "idle") {
    this.manifest = manifest;
    this.current = manifest.animations[initial] ? initial : Object.keys(manifest.animations)[0];
    this.frameDuration = 1 / Math.max(1, manifest.fps);
  }

  get currentName(): string {
    return this.current;
  }

  /** Switch animation. No-op if already playing it. */
  play(name: string, onComplete?: () => void): void {
    if (!this.manifest.animations[name]) return;
    // Don't restart the same looping animation.
    if (name === this.current && this.manifest.animations[name].loop) return;
    // Don't interrupt an unfinished non-looping animation.
    if (
      name !== this.current &&
      !this.manifest.animations[this.current].loop &&
      !this.done
    ) {
      return;
    }
    this.switch(name, onComplete);
  }

  /** Force a switch even if a non-looping animation is mid-play. */
  forcePlay(name: string, onComplete?: () => void): void {
    if (!this.manifest.animations[name]) return;
    this.switch(name, onComplete);
  }

  private switch(name: string, onComplete?: () => void): void {
    this.current = name;
    this.frameIndex = 0;
    this.elapsed = 0;
    this.done = false;
    this.onComplete = onComplete;
  }

  /** Advance the frame clock. `dt` in seconds. */
  update(dt: number): void {
    const anim = this.manifest.animations[this.current];
    if (!anim || anim.frames <= 1) return;
    if (this.done) return;

    this.elapsed += dt;
    while (this.elapsed >= this.frameDuration) {
      this.elapsed -= this.frameDuration;
      this.frameIndex++;
      if (this.frameIndex >= anim.frames) {
        if (anim.loop) {
          this.frameIndex = 0;
        } else {
          this.frameIndex = anim.frames - 1;
          this.done = true;
          this.onComplete?.();
          this.onComplete = undefined;
          break;
        }
      }
    }
  }

  /** Spritesheet cell for the current frame. */
  getCurrentFrame(): { row: number; col: number } {
    const anim = this.manifest.animations[this.current];
    return { row: anim ? anim.row : 0, col: this.frameIndex };
  }
}
