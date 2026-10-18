// Generates a fake Shimeji-EE frame set (img/shime1.png … shime23.png) for
// testing the importer. Distinct per frame so packing is visible.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "test-shimeji", "img");

const CRC = (() => { const t = new Uint32Array(256); for (let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;} return t; })();
function crc32(b){let c=0xffffffff;for(let i=0;i<b.length;i++)c=CRC[(c^b[i])&0xff]^(c>>>8);return (c^0xffffffff)>>>0;}
function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length,0);const b=Buffer.concat([Buffer.from(t,"ascii"),d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc32(b),0);return Buffer.concat([l,b,c]);}
function png(w,h,rgba){const sig=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=6;const raw=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++){raw[y*(w*4+1)]=0;rgba.copy(raw,y*(w*4+1)+1,y*w*4,(y+1)*w*4);}return Buffer.concat([sig,chunk("IHDR",ih),chunk("IDAT",deflateSync(raw,{level:9})),chunk("IEND",Buffer.alloc(0))]);}

const W = 96, H = 128;
function frame(n) {
  const buf = Buffer.alloc(W * H * 4); // transparent
  const hue = (n * 37) % 360;
  const [r, g, b] = hsl(hue, 0.6, 0.55);
  // body block near the bottom (feet-anchored), width varies a touch per frame
  const bw = 44 + (n % 3) * 4;
  const bh = 56;
  const bx = (W - bw) >> 1;
  const by = H - bh - 6;
  for (let y = by; y < by + bh; y++)
    for (let x = bx; x < bx + bw; x++) {
      const i = (y * W + x) * 4;
      buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = 255;
    }
  // eyes
  for (const ex of [bx + 12, bx + bw - 18])
    for (let y = by + 14; y < by + 22; y++)
      for (let x = ex; x < ex + 6; x++) { const i=(y*W+x)*4; buf[i]=buf[i+1]=buf[i+2]=255; buf[i+3]=255; }
  return png(W, H, buf);
}
function hsl(h,s,l){h/=360;const a=s*Math.min(l,1-l);const f=(n)=>{const k=(n+h*12)%12;return Math.round(255*(l-a*Math.max(-1,Math.min(k-3,9-k,1))));};return [f(0),f(8),f(4)];}

rmSync(join(__dirname, "..", "test-shimeji"), { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (let n = 1; n <= 23; n++) writeFileSync(join(OUT, `shime${n}.png`), frame(n));
console.log(`Wrote 23 frames to ${OUT}`);
