"use strict";

// Draws the toolbar icons (icon-16.png, icon-32.png): a page with a bookmark, the simplified form of
// the paper-stack illustration. The page fills the icon, its outline being the icon's edge:
// Chrome always shows the toolbar icon at 16 points, so any margin only makes the drawing smaller
// (and a cream margin vanishes on a light toolbar). Shapes are on a 128-unit grid, aligned to whole
// pixels at both sizes so the outline stays a crisp dark line, and rendered with 8x8 supersampling,
// so no image library is needed. icon-48.png and icon-128.png are the illustration itself, exported
// by hand, and are not touched here; the colours below are taken from it. Run: npm run icons
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const COLORS = {
  outline: [0x41, 0x36, 0x2e],
  page: [0xfe, 0xfc, 0xf7],
  ribbon: [0x96, 0x76, 0x45]
};

// One unit is 1/8 px at 16px and 1/4 px at 32px; every edge sits on a multiple of 8.
// The page starts one pixel down (two at 32px) so the bookmark can stick out above it.
const PAGE = { x: 0, y: 8, w: 128, h: 120, r: 24 };
const OUTLINE = 8;
// The bookmark sticks out above the page, right of centre as in the illustration.
const RIBBON = [[64, 0], [88, 0], [88, 96], [76, 80], [64, 96]];

function inRoundedRect(x, y, { x: rx, y: ry, w, h, r }) {
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  return x >= rx && x <= rx + w && y >= ry && y <= ry + h && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const PAGE_INSIDE = { x: PAGE.x + OUTLINE, y: PAGE.y + OUTLINE, w: PAGE.w - OUTLINE * 2, h: PAGE.h - OUTLINE * 2, r: PAGE.r - OUTLINE };

// Topmost shape wins: bookmark over page over outline.
function colorAt(x, y) {
  if (inPolygon(x, y, RIBBON)) return COLORS.ribbon;
  if (!inRoundedRect(x, y, PAGE)) return null;
  if (inRoundedRect(x, y, PAGE_INSIDE)) return COLORS.page;
  return COLORS.outline;
}

function render(size) {
  const samples = 8;
  const scale = 128 / size;
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const color = colorAt((px + (sx + 0.5) / samples) * scale, (py + (sy + 0.5) / samples) * scale);
          if (!color) continue;
          r += color[0];
          g += color[1];
          b += color[2];
          covered += 1;
        }
      }
      const offset = (py * size + px) * 4;
      if (covered) {
        pixels[offset] = Math.round(r / covered);
        pixels[offset + 1] = Math.round(g / covered);
        pixels[offset + 2] = Math.round(b / covered);
      }
      pixels[offset + 3] = Math.round((covered / (samples * samples)) * 255);
    }
  }
  return encodePng(size, size, pixels);
}

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Buffer.from([0]), rgba.subarray(y * width * 4, (y + 1) * width * 4));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const outDir = path.join(__dirname, "..", "icons");
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), render(size));
}
console.log("icon-16.png and icon-32.png written to", outDir);
