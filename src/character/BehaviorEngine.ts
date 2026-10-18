import type { BehaviorConfig, Rect } from "../types/manifest";

export type CharState =
  | "IDLE"
  | "WALKING"
  | "SITTING"
  | "FALLING"
  | "CLIMBING"
  | "GRABBED"
  | "THROWN";

export interface BehaviorResult {
  x: number; // window top-left, physical px
  y: number;
  vx: number;
  vy: number;
  state: CharState;
  facingRight: boolean;
  animation: string;
}

interface Surface {
  y: number;
  xMin: number;
  xMax: number;
}

interface ClimbState {
  mode: "up" | "down";
  wallX: number; // x of the wall the character hugs
  targetY: number; // feet-Y at which the climb ends
  facing: boolean; // true => wall is on the character's right
}

export type ReactMode = "none" | "chase" | "flee";

export interface EngineOpts {
  behaviors: BehaviorConfig;
  windowW: number; // full window size, physical px
  windowH: number;
  spriteW: number; // drawn sprite size, physical px
  spriteH: number;
  unit: number; // physics scale (manifest.scale)
  reactMode: ReactMode; // how it reacts to the cursor
}

const SNAP = 8;

/**
 * Physics + state machine. Owns the character's window-top-left position in
 * physical screen pixels and decides which animation should play. Supports
 * gravity/landing/walking, climbing window & screen edges, sitting/idle/sleep,
 * cursor reactions (chase/flee), and a dizzy daze after a hard landing.
 */
export class BehaviorEngine {
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  state: CharState = "FALLING";
  facingRight = Math.random() < 0.5;

  private b: BehaviorConfig;
  private W: number;
  private H: number;
  private sw: number;
  private sh: number;
  private ox: number;
  private oy: number;
  private gravity: number;
  private walkSpeed: number;
  private climbSpeed: number;
  private terminal: number;
  private reactMode: ReactMode;

  private sitTimer = 0;
  private sitAnim = "sit"; // "sit" (also used for sleep/dizzy)
  private idleTimer = 0;
  private climb: ClimbState | null = null;
  private chaseTimer = 0;
  private chaseDir = 0; // -1 | +1 while reacting to the cursor
  private screenW = 1920;
  private screenH = 1080;

  constructor(opts: EngineOpts, startX: number, startY: number) {
    this.b = opts.behaviors;
    this.W = opts.windowW;
    this.H = opts.windowH;
    this.sw = opts.spriteW;
    this.sh = opts.spriteH;
    this.ox = (this.W - this.sw) / 2;
    this.oy = (this.H - this.sh) / 2;
    const u = opts.unit;
    this.gravity = this.b.gravity * u;
    this.walkSpeed = this.b.walkSpeed * u;
    this.climbSpeed = this.b.climbSpeed * u;
    this.terminal = 22 * u;
    this.reactMode = opts.reactMode;
    this.x = startX;
    this.y = startY;
  }

  private get footCenterX(): number {
    return this.x + this.ox + this.sw / 2;
  }
  private get feetY(): number {
    return this.y + this.oy + this.sh;
  }
  private setFeetY(fy: number): void {
    this.y = fy - this.oy - this.sh;
  }
  private spriteRight(): number {
    return this.x + this.ox + this.sw;
  }
  private spriteLeft(): number {
    return this.x + this.ox;
  }

  // ----- external (mouse) controls -------------------------------------
  grab(): void {
    this.state = "GRABBED";
    this.climb = null;
    this.vx = 0;
    this.vy = 0;
  }
  setWindowPos(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }
  release(vx: number, vy: number): void {
    this.state = "THROWN";
    this.vx = vx;
    this.vy = vy;
  }
  sendHome(screenH: number): void {
    this.climb = null;
    this.setFeetY(screenH);
    this.vx = 0;
    this.vy = 0;
    this.state = "WALKING";
  }

  // ----- surface queries -----------------------------------------------
  private candidateSurfaces(footCenterX: number, rects: Rect[]): Surface[] {
    const out: Surface[] = [{ y: this.screenH, xMin: 0, xMax: this.screenW }];
    for (const r of rects) {
      if (footCenterX >= r.x && footCenterX <= r.x + r.width) {
        out.push({ y: r.y, xMin: r.x, xMax: r.x + r.width });
      }
    }
    return out;
  }

  private supportAt(footCenterX: number, feetY: number, rects: Rect[]): Surface | null {
    let best: Surface | null = null;
    let bestDelta = Infinity;
    for (const s of this.candidateSurfaces(footCenterX, rects)) {
      const d = Math.abs(s.y - feetY);
      if (d <= SNAP && d < bestDelta) {
        best = s;
        bestDelta = d;
      }
    }
    return best;
  }

  private landingSurface(prevFeetY: number, nextFeetY: number, footCenterX: number, rects: Rect[]): Surface | null {
    let best: Surface | null = null;
    for (const s of this.candidateSurfaces(footCenterX, rects)) {
      if (s.y >= prevFeetY - 0.5 && s.y <= nextFeetY) {
        if (!best || s.y < best.y) best = s;
      }
    }
    return best;
  }

  /** Lowest surface strictly below the feet (for climbing down). */
  private surfaceBelow(footCenterX: number, feetY: number, rects: Rect[]): number {
    let best = this.screenH;
    for (const s of this.candidateSurfaces(footCenterX, rects)) {
      if (s.y > feetY + 1 && s.y < best) best = s.y;
    }
    return best;
  }

  /** A wall the character can climb up, given its facing & adjacency. */
  private findClimbUpWall(rects: Rect[]): ClimbState | null {
    const reach = this.walkSpeed * 2 + 6;
    if (this.facingRight) {
      if (this.spriteRight() >= this.screenW - 2) {
        return { mode: "up", wallX: this.screenW, targetY: 0, facing: true };
      }
      for (const r of rects) {
        if (
          r.x >= this.spriteRight() - 2 &&
          r.x <= this.spriteRight() + reach &&
          r.y < this.feetY - 4 &&
          r.y + r.height > this.feetY - 4
        ) {
          return { mode: "up", wallX: r.x, targetY: r.y, facing: true };
        }
      }
    } else {
      if (this.spriteLeft() <= 2) {
        return { mode: "up", wallX: 0, targetY: 0, facing: false };
      }
      for (const r of rects) {
        const right = r.x + r.width;
        if (
          right <= this.spriteLeft() + 2 &&
          right >= this.spriteLeft() - reach &&
          r.y < this.feetY - 4 &&
          r.y + r.height > this.feetY - 4
        ) {
          return { mode: "up", wallX: right, targetY: r.y, facing: false };
        }
      }
    }
    return null;
  }

  private pinToWall(climb: ClimbState): void {
    if (climb.facing) {
      this.x = climb.wallX - this.ox - this.sw; // right side touches wall
    } else {
      this.x = climb.wallX - this.ox; // left side touches wall
    }
  }

  // ----- main update ----------------------------------------------------
  update(dt: number, rects: Rect[], screen: { width: number; height: number }, cursor?: { x: number; y: number } | null): BehaviorResult {
    const f = Math.min(3, dt * 60);
    this.screenW = screen.width;
    this.screenH = screen.height;
    if (this.chaseTimer > 0) this.chaseTimer -= dt;

    switch (this.state) {
      case "GRABBED":
        return this.snapshot("grabbed");

      case "THROWN":
      case "FALLING": {
        this.vy = Math.min(this.terminal, this.vy + this.gravity * f);
        const prevFeetY = this.feetY;
        if (this.state === "THROWN") {
          this.x += this.vx * f;
          const left = this.spriteLeft();
          const right = this.spriteRight();
          if (left < 0) {
            this.x = -this.ox;
            this.vx = Math.abs(this.vx) * 0.45;
          } else if (right > this.screenW) {
            this.x = this.screenW - this.ox - this.sw;
            this.vx = -Math.abs(this.vx) * 0.45;
          }
          if (this.vx !== 0) this.facingRight = this.vx > 0;
        }
        this.y += this.vy * f;
        const landed = this.landingSurface(prevFeetY, this.feetY, this.footCenterX, rects);
        if (landed) {
          const impact = this.vy;
          this.setFeetY(landed.y);
          this.vy = 0;
          this.vx = 0;
          // Hard landing => dizzy daze (reuses the sit animation).
          if (impact > 14 * (this.terminal / 22)) {
            this.state = "SITTING";
            this.sitAnim = "sit";
            this.sitTimer = 1.2 + Math.random();
            return this.snapshot("sit");
          }
          this.state = "WALKING";
          return this.snapshot(this.facingRight ? "walk_right" : "walk_left");
        }
        return this.snapshot(this.state === "THROWN" ? "thrown" : "fall");
      }

      case "CLIMBING": {
        const climb = this.climb;
        if (!climb) {
          this.state = "FALLING";
          return this.snapshot("fall");
        }
        this.pinToWall(climb);
        // small chance to give up
        if (Math.random() < 0.004 * f) {
          this.climb = null;
          this.state = "FALLING";
          return this.snapshot("fall");
        }
        if (climb.mode === "up") {
          this.setFeetY(this.feetY - this.climbSpeed * f);
          if (this.feetY <= climb.targetY) {
            this.setFeetY(Math.max(0, climb.targetY));
            this.climb = null;
            if (climb.targetY <= 0) {
              this.state = "FALLING"; // reached screen top, drop back
              return this.snapshot("fall");
            }
            // step onto the ledge top, facing inward
            this.facingRight = !climb.facing;
            this.state = "WALKING";
            return this.snapshot(this.facingRight ? "walk_right" : "walk_left");
          }
          return this.snapshot("climb_up");
        } else {
          this.setFeetY(this.feetY + this.climbSpeed * f);
          if (this.feetY >= climb.targetY) {
            this.setFeetY(climb.targetY);
            this.climb = null;
            this.state = "WALKING";
            return this.snapshot(this.facingRight ? "walk_right" : "walk_left");
          }
          return this.snapshot("climb_down");
        }
      }

      case "SITTING": {
        const support = this.supportAt(this.footCenterX, this.feetY, rects);
        if (!support) {
          this.state = "FALLING";
          return this.snapshot("fall");
        }
        this.setFeetY(support.y);
        this.sitTimer -= dt;
        if (this.sitTimer <= 0) this.state = "WALKING";
        return this.snapshot(this.sitAnim);
      }

      case "IDLE": {
        const support = this.supportAt(this.footCenterX, this.feetY, rects);
        if (!support) {
          this.state = "FALLING";
          return this.snapshot("fall");
        }
        this.setFeetY(support.y);
        this.idleTimer -= dt;
        if (this.idleTimer <= 0) this.state = "WALKING";
        return this.snapshot("idle");
      }

      case "WALKING":
      default: {
        const support = this.supportAt(this.footCenterX, this.feetY, rects);
        if (!support) {
          this.state = "FALLING";
          return this.snapshot("fall");
        }
        this.setFeetY(support.y);

        // cursor reaction: occasionally dart toward/away from a nearby cursor
        if (this.reactMode !== "none" && cursor && this.chaseTimer <= 0 && Math.random() < 0.02 * f) {
          const dx = cursor.x - this.footCenterX;
          if (Math.abs(dx) < 360 && Math.abs(dx) > 20) {
            const toward = dx > 0 ? 1 : -1;
            this.chaseDir = this.reactMode === "flee" ? -toward : toward;
            this.facingRight = this.chaseDir > 0;
            this.chaseTimer = 0.8 + Math.random() * 0.8;
          }
        }
        const reacting = this.chaseTimer > 0;

        if (!reacting) {
          // random idle / sit / sleep / turn
          if (this.b.canSit && Math.random() < this.b.sitChance * f) {
            this.state = "SITTING";
            this.sitAnim = "sit";
            this.sitTimer = 2 + Math.random() * 6;
            return this.snapshot("sit");
          }
          if (Math.random() < 0.0008 * f) {
            // sleep: a long sit
            this.state = "SITTING";
            this.sitAnim = "sit";
            this.sitTimer = 6 + Math.random() * 8;
            return this.snapshot("sit");
          }
          if (Math.random() < 0.0015 * f) {
            this.state = "IDLE";
            this.idleTimer = 0.5 + Math.random() * 2;
            return this.snapshot("idle");
          }
          if (Math.random() < this.b.turnChance * f) {
            this.facingRight = !this.facingRight;
          }
        }

        // climbing up onto a window/screen edge ahead
        if (this.b.canClimb && !reacting && Math.random() < 0.02 * f) {
          const wall = this.findClimbUpWall(rects);
          if (wall) {
            this.climb = wall;
            this.state = "CLIMBING";
            this.pinToWall(wall);
            return this.snapshot("climb_up");
          }
        }

        // move
        const speed = reacting ? this.walkSpeed * 1.7 : this.walkSpeed;
        const dir = reacting ? this.chaseDir : this.facingRight ? 1 : -1;
        const step = dir * speed * f;
        const nextFootCenter = this.footCenterX + step;
        const nextLeft = nextFootCenter - this.sw / 2;
        const nextRight = nextFootCenter + this.sw / 2;

        if (nextLeft <= 0) {
          this.x = -this.ox;
          this.facingRight = true;
          this.chaseTimer = 0;
        } else if (nextRight >= this.screenW) {
          this.x = this.screenW - this.ox - this.sw;
          this.facingRight = false;
          this.chaseTimer = 0;
        } else if (nextFootCenter < support.xMin || nextFootCenter > support.xMax) {
          // at the ledge of a window: climb down the side, fall off, or turn
          const onWindow = support.y < this.screenH - 1;
          if (onWindow && this.b.canClimb && Math.random() < 0.4) {
            const wallX = dir > 0 ? support.xMax : support.xMin;
            const targetY = this.surfaceBelow(wallX + dir * 4, this.feetY, rects);
            this.climb = { mode: "down", wallX, targetY, facing: dir > 0 };
            this.state = "CLIMBING";
            return this.snapshot("climb_down");
          }
          if (onWindow && Math.random() < 0.25) {
            this.x += step; // step off into the air -> falls next frame
          } else {
            this.facingRight = !this.facingRight;
            this.chaseTimer = 0;
          }
        } else {
          this.x += step;
        }
        return this.snapshot(this.facingRight ? "walk_right" : "walk_left");
      }
    }
  }

  private snapshot(animation: string): BehaviorResult {
    const minX = -this.ox;
    const maxX = Math.max(minX, this.screenW - this.ox - this.sw);
    this.x = Math.min(maxX, Math.max(minX, this.x));
    const maxY = this.screenH - this.oy - this.sh;
    const minY = -this.oy - this.sh;
    this.y = Math.min(maxY, Math.max(minY, this.y));
    return {
      x: this.x,
      y: this.y,
      vx: this.vx,
      vy: this.vy,
      state: this.state,
      facingRight: this.facingRight,
      animation,
    };
  }
}
