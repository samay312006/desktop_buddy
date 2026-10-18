// TypeScript mirror of the character manifest schema (see manifest.json).

export interface AnimationDef {
  row: number;
  frames: number;
  loop: boolean;
}

export interface BehaviorConfig {
  gravity: number;
  walkSpeed: number;
  climbSpeed: number;
  canClimb: boolean;
  canSit: boolean;
  sitChance: number;
  turnChance: number;
  speakChance: number;
}

export type AnimationName =
  | "idle"
  | "walk_right"
  | "walk_left"
  | "fall"
  | "climb_up"
  | "climb_down"
  | "sit"
  | "grabbed"
  | "thrown";

export interface CharacterManifest {
  id: string;
  name: string;
  author: string;
  version: string;
  personality: string;
  frameWidth: number;
  frameHeight: number;
  fps: number;
  scale: number;
  animations: Record<string, AnimationDef>;
  behaviors: BehaviorConfig;
}

/** A screen-space rectangle in physical pixels (from the Rust backend). */
export interface Rect {
  id: number; // native window handle (HWND) as a number; 0 if unavailable
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  foreground: boolean;
  isCharacter: boolean;
}
