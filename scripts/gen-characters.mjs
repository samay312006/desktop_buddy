// Generates the bundled characters (recolored "Block Cat" variants with a
// distinguishing accessory + personality):
//   characters/<id>/{spritesheet.png, preview.png, manifest.json}
// Pure Node — no external deps. PNGs are built by hand using zlib.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHARS_DIR = join(__dirname, "..", "characters");

// ----- minimal PNG encoder (RGBA, 8-bit) ---------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.buf = Buffer.alloc(w * h * 4);
  }
  px(x, y, [r, g, b, a = 255]) {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const sa = a / 255;
    const da = this.buf[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    this.buf[i] = (r * sa + this.buf[i] * da * (1 - sa)) / oa;
    this.buf[i + 1] = (g * sa + this.buf[i + 1] * da * (1 - sa)) / oa;
    this.buf[i + 2] = (b * sa + this.buf[i + 2] * da * (1 - sa)) / oa;
    this.buf[i + 3] = oa * 255;
  }
  rect(x, y, w, h, color) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.px(xx, yy, color);
  }
}

const FW = 64;
const FH = 64;
const EYE = [255, 255, 255, 255];
const PUPIL = [25, 30, 45, 255];
const PUPIL_GRAB = [220, 60, 60, 255];

// Draw one cat frame with the given palette + accessory.
function drawCat(c, ox, oy, palette, accessory, opts = {}) {
  const { body, dk, ear } = palette;
  const { legPhase = 0, bob = 0, squash = 0, pupil = PUPIL, eyeY = 0, closed = false } = opts;

  const bw = 36;
  const bh = 30 - squash;
  const bx = ox + (FW - bw) / 2;
  const by = oy + (FH - bh) - 6 + bob + squash;

  c.rect(bx + 4, by - 7, 8, 8, ear);
  c.rect(bx + bw - 12, by - 7, 8, 8, ear);
  c.rect(bx, by, bw, bh, body);
  c.rect(bx + 3, by + bh - 6, bw - 6, 4, dk);
  const legY = by + bh;
  const offsets = [[0, 0, 0, 0], [2, 0, 0, 2], [0, 0, 0, 0], [0, 2, 2, 0]][legPhase % 4];
  const legXs = [bx + 3, bx + 12, bx + bw - 16, bx + bw - 7];
  for (let i = 0; i < 4; i++) c.rect(legXs[i], legY, 5, 6 - offsets[i], dk);
  c.rect(bx + bw - 2, by + 4, 6, 4, body);
  c.rect(bx + bw + 3, by, 4, 8, body);

  const ey = by + 8 + eyeY;
  const elx = bx + 9;
  const erx = bx + bw - 16;

  // accessory drawn *behind* the eyes where relevant
  if (accessory === "mask") {
    c.rect(bx + 5, ey - 2, bw - 10, 11, [20, 20, 28, 255]); // burglar mask band
  }

  if (closed) {
    c.rect(elx, ey + 3, 7, 2, PUPIL);
    c.rect(erx, ey + 3, 7, 2, PUPIL);
  } else {
    c.rect(elx, ey, 7, 7, EYE);
    c.rect(erx, ey, 7, 7, EYE);
    c.rect(elx + 2, ey + 2, 3, 3, pupil);
    c.rect(erx + 2, ey + 2, 3, 3, pupil);
  }

  // accessory drawn *in front*
  if (accessory === "glasses") {
    const fr = [30, 30, 40, 255];
    for (const x of [elx - 1, erx - 1]) {
      c.rect(x, ey - 1, 9, 1, fr);
      c.rect(x, ey + 7, 9, 1, fr);
      c.rect(x, ey - 1, 1, 9, fr);
      c.rect(x + 8, ey - 1, 1, 9, fr);
    }
    c.rect(elx + 8, ey + 2, erx - (elx + 8), 1, fr); // bridge
  } else if (accessory === "brows") {
    c.rect(elx, ey - 4, 7, 2, dk); // angry slanted brows
    c.px(elx + 6, ey - 5, dk);
    c.rect(erx, ey - 4, 7, 2, dk);
    c.px(erx, ey - 5, dk);
  } else if (accessory === "heart") {
    const h = [225, 60, 90, 255];
    const hx = bx + bw / 2 - 3;
    const hy = by + bh - 12;
    c.rect(hx, hy, 2, 2, h);
    c.rect(hx + 4, hy, 2, 2, h);
    c.rect(hx, hy + 1, 6, 2, h);
    c.rect(hx + 1, hy + 3, 4, 1, h);
    c.rect(hx + 2, hy + 4, 2, 1, h);
  }
}

const ANIMS = [
  ["idle", 4, (i) => ({ bob: [0, -1, 0, 1][i], closed: i === 2 })],
  ["walk_right", 6, (i) => ({ legPhase: i % 4, bob: i % 2 })],
  ["walk_left", 6, (i) => ({ legPhase: i % 4, bob: i % 2 })],
  ["fall", 2, (i) => ({ eyeY: -1, bob: i })],
  ["climb_up", 4, (i) => ({ legPhase: i % 4, eyeY: -1 })],
  ["climb_down", 4, (i) => ({ legPhase: i % 4, eyeY: 1 })],
  ["sit", 2, (i) => ({ squash: 8, bob: i, closed: i === 1 })],
  ["grabbed", 2, (i) => ({ squash: -2, bob: -i, pupil: PUPIL_GRAB })],
  ["thrown", 2, (i) => ({ eyeY: -1, bob: i * 2, pupil: PUPIL_GRAB })],
];

const cols = Math.max(...ANIMS.map(([, n]) => n));
const rows = ANIMS.length;

function buildSheet(palette, accessory) {
  const sheet = new Canvas(cols * FW, rows * FH);
  ANIMS.forEach(([, frames, opts], row) => {
    for (let i = 0; i < frames; i++) drawCat(sheet, i * FW, row * FH, palette, accessory, opts(i));
  });
  return sheet;
}

function buildPreview(palette, accessory) {
  const preview = new Canvas(128, 128);
  const tmp = new Canvas(FW, FH);
  drawCat(tmp, 0, 0, palette, accessory, {});
  for (let y = 0; y < FH; y++)
    for (let x = 0; x < FW; x++) {
      const si = (y * FW + x) * 4;
      if (tmp.buf[si + 3] === 0) continue;
      preview.rect(x * 2, y * 2, 2, 2, [tmp.buf[si], tmp.buf[si + 1], tmp.buf[si + 2], tmp.buf[si + 3]]);
    }
  return preview;
}

const animations = {
  idle: { row: 0, frames: 4, loop: true },
  walk_right: { row: 1, frames: 6, loop: true },
  walk_left: { row: 2, frames: 6, loop: true },
  fall: { row: 3, frames: 2, loop: true },
  climb_up: { row: 4, frames: 4, loop: true },
  climb_down: { row: 5, frames: 4, loop: true },
  sit: { row: 6, frames: 2, loop: true },
  grabbed: { row: 7, frames: 2, loop: true },
  thrown: { row: 8, frames: 2, loop: false },
};

const CHARACTERS = [
  {
    id: "coder-cat",
    name: "Coder Cat",
    personality: "coder",
    palette: { body: [90, 110, 160, 255], dk: [60, 75, 120, 255], ear: [70, 88, 135, 255] },
    accessory: "glasses",
    behaviors: { canClimb: true, canSit: true },
  },
  {
    id: "roaster",
    name: "Roaster",
    personality: "roaster",
    palette: { body: [200, 90, 70, 255], dk: [150, 55, 45, 255], ear: [180, 75, 60, 255] },
    accessory: "brows",
    behaviors: { canClimb: true, canSit: true },
  },
  {
    id: "love-guru",
    name: "Love Guru",
    personality: "love",
    palette: { body: [225, 120, 170, 255], dk: [180, 85, 130, 255], ear: [210, 105, 150, 255] },
    accessory: "heart",
    behaviors: { canClimb: true, canSit: true },
  },
  {
    id: "thief",
    name: "Thief",
    personality: "thief",
    palette: { body: [85, 80, 100, 255], dk: [52, 48, 64, 255], ear: [68, 64, 82, 255] },
    accessory: "mask",
    behaviors: { canClimb: true, canSit: false },
  },
];

for (const ch of CHARACTERS) {
  const dir = join(CHARS_DIR, ch.id);
  mkdirSync(dir, { recursive: true });
  const sheet = buildSheet(ch.palette, ch.accessory);
  const preview = buildPreview(ch.palette, ch.accessory);
  const manifest = {
    id: ch.id,
    name: ch.name,
    author: "shimeji-app",
    version: "1.0.0",
    personality: ch.personality,
    frameWidth: FW,
    frameHeight: FH,
    fps: 8,
    scale: 2,
    animations,
    behaviors: {
      gravity: 0.5,
      walkSpeed: 1.5,
      climbSpeed: 1.0,
      canClimb: ch.behaviors.canClimb,
      canSit: ch.behaviors.canSit,
      sitChance: 0.002,
      turnChance: 0.001,
      speakChance: 0.004,
    },
  };
  writeFileSync(join(dir, "spritesheet.png"), encodePNG(sheet.w, sheet.h, sheet.buf));
  writeFileSync(join(dir, "preview.png"), encodePNG(preview.w, preview.h, preview.buf));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`Generated ${ch.name} → characters/${ch.id}`);
}
console.log("Done.");
