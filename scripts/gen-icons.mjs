#!/usr/bin/env node
/**
 * Generates + validates the PWA icons referenced by public/manifest.webmanifest (6a).
 *
 *   node scripts/gen-icons.mjs
 *
 * Generates the MASKABLE icons (public/icon-maskable-{192,512}.png) as real
 * PNGs using only Node stdlib (zlib.deflateSync + a hand-rolled chunk writer):
 * a warm-ember field with a centered accent mark held well inside the 80%
 * maskable safe zone. The "any"-purpose icons (/icon-192.png, /icon.png) are
 * the pre-existing app icons and are NOT touched.
 *
 * Also validates every PNG/SVG the manifest references: the PNG IHDR
 * dimensions must match the manifest's declared sizes, and the files must
 * exist. Run it after any icon change; CI-relevant failures exit non-zero.
 */
import { deflateSync } from "node:zlib";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "public");

// Warm-ember dark palette from app/globals.css (design tokens, no ad-hoc colors).
const BG = [0x1b, 0x19, 0x16, 0xff]; // --bg (warm ember)
const MARK = [0xe0, 0x7b, 0x54, 0xff]; // --accent (warm ember)
const CORE = [0xfa, 0xf9, 0xf6, 0xff]; // --bg (warm paper)

function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encode RGBA pixels (Uint8Array, length = w*h*4) as a PNG buffer. */
function encodePng(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter: none
    const srcStart = y * width * 4;
    if (typeof pixels.copy === "function") {
      pixels.copy(raw, rowStart + 1, srcStart, srcStart + width * 4);
    } else {
      raw.set(pixels.subarray(srcStart, srcStart + width * 4), rowStart + 1);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Maskable icon: full-bleed background + centered mark inside the 80% safe
 *  zone (Android masks crop up to 20% from every edge). */
function maskableIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const set = (x, y, [r, g, b, a]) => {
    const i = (y * size + x) * 4;
    pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = a;
  };
  const markHalf = Math.round(size * 0.28); // 56% mark → 44% clear margin ≫ safe zone
  const coreHalf = Math.round(size * 0.11);
  const center = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.abs(x + 0.5 - center);
      const dy = Math.abs(y + 0.5 - center);
      if (dx <= coreHalf && dy <= coreHalf) set(x, y, CORE);
      else if (dx <= markHalf && dy <= markHalf) set(x, y, MARK);
      else set(x, y, BG);
    }
  }
  return encodePng(size, size, pixels);
}

function readPngSize(filePath) {
  const buffer = readFileSync(filePath);
  const signatureOk = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!signatureOk) throw new Error(`${filePath}: not a PNG`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// ── generate ────────────────────────────────────────────────────────────────
for (const size of [192, 512]) {
  const target = join(publicDir, `icon-maskable-${size}.png`);
  writeFileSync(target, maskableIcon(size));
  console.log(`wrote ${target}`);
}

// ── validate everything the manifest references ─────────────────────────────
const manifest = JSON.parse(readFileSync(join(publicDir, "manifest.webmanifest"), "utf8"));
let failures = 0;
for (const icon of manifest.icons) {
  const path = join(publicDir, icon.src.replace(/^\//, ""));
  if (!existsSync(path)) {
    console.error(`MISSING: ${icon.src}`);
    failures += 1;
    continue;
  }
  if (icon.type === "image/png") {
    const { width, height } = readPngSize(path);
    const [declaredW, declaredH] = icon.sizes.split("x").map(Number);
    if (width !== declaredW || height !== declaredH) {
      console.error(`SIZE MISMATCH: ${icon.src} is ${width}x${height}, manifest declares ${icon.sizes}`);
      failures += 1;
    } else {
      console.log(`ok ${icon.src} ${width}x${height} (${icon.purpose ?? "any"})`);
    }
  } else {
    console.log(`ok ${icon.src} (${icon.type})`);
  }
}
if (failures > 0) {
  console.error(`${failures} manifest icon problem(s)`);
  process.exit(1);
}
