#!/usr/bin/env node
/**
 * Generates the native app icons (iOS + Android) from the omp-web brand mark.
 *
 *   node scripts/gen-app-icons.mjs            # write every icon
 *   node scripts/gen-app-icons.mjs --check    # validate dimensions + alpha only
 *
 * Artwork is the SAME mark the web app ships (components/OmpWebLogo.tsx, which
 * matches https://omp.sh/favicon.svg): the π glyph on gradient
 * #ed4abf → #9b4dff → #5ad8e6 over a #0f0a14 tile. Rendering goes through the
 * system Chrome (Playwright `channel: "chrome"`) so one vector source produces
 * crisp art at every required pixel size — no image deps in package.json.
 *
 * Outputs
 *   ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
 *       1024×1024, FULL BLEED, and RGB without an alpha channel: the App Store
 *       rejects icons that carry alpha, and iOS applies its own rounded mask.
 *   android/app/src/main/res/mipmap-<density>/ic_launcher.png        (tile)
 *   android/app/src/main/res/mipmap-<density>/ic_launcher_round.png  (circle)
 *   android/app/src/main/res/mipmap-<density>/ic_launcher_foreground.png
 *       adaptive-icon foreground layer: transparent, mark held inside the
 *       66dp safe zone of the 108dp canvas (the launcher crops the rest).
 *
 * The adaptive background COLOR lives in
 * android/app/src/main/res/values/ic_launcher_background.xml and is asserted
 * to be the brand tile colour, so a stray default white is caught here.
 */
import { deflateSync, inflateSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_ONLY = process.argv.includes("--check");

/* --------------------------------- brand --------------------------------- */

const TILE = "#0f0a14";
const GRADIENT = [
  { offset: "0", color: "#ed4abf" },
  { offset: "0.5", color: "#9b4dff" },
  { offset: "1", color: "#5ad8e6" },
];
/** π glyph, in the source 64-unit viewBox. */
const MARK_PATH = "M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z";
/** Mark bounding box inside that viewBox (x 14→50, y 16→56). */
const MARK_CENTER = { x: 32, y: 36 };
const MARK_WIDTH = 36;

/* ------------------------------- rasterizer ------------------------------- */

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require("playwright");
  } catch {
    // Fall back to the global install (this repo intentionally has no image
    // dependencies; the tool is a build-time convenience only).
    try {
      const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
      return createRequire(join(globalRoot, "noop.js"))("playwright");
    } catch {
      console.error(
        "gen-app-icons: playwright is required to rasterize the brand SVG.\n" +
          "  npm i -g playwright && npx playwright install chromium\n" +
          "  (or use the system Chrome — this script launches channel:\"chrome\")",
      );
      process.exit(2);
    }
  }
}

/** SVG for one variant. `span` = width of the mark as a fraction of the
 *  canvas; the tile/round variants add their own background layer. */
function svgFor({ size, variant, span }) {
  const gradId = `g-${variant}-${size}`;
  const defs = `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1">${GRADIENT.map(
    (stop) => `<stop offset="${stop.offset}" stop-color="${stop.color}"/>`,
  ).join("")}</linearGradient></defs>`;

  // Frame the canvas so the mark occupies `span` of the width: for the tile
  // variants that is the plain 64-unit viewBox; for the adaptive foreground the
  // same viewBox is widened so the mark lands inside the safe zone.
  if (variant === "foreground") {
    const box = MARK_WIDTH / span; // canvas units across
    const x = MARK_CENTER.x - box / 2;
    const y = MARK_CENTER.y - box / 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${x} ${y} ${box} ${box}">${defs}<path fill="url(#${gradId})" d="${MARK_PATH}"/></svg>`;
  }

  const background = variant === "round"
    ? `<circle cx="32" cy="32" r="32" fill="${TILE}"/>`
    : `<rect width="64" height="64" fill="${TILE}"/>`;
  // Scale the mark about its own bounding-box centre and then place that
  // centre on the CANVAS centre — the glyph's bbox is centred on y=36, not the
  // tile's y=32, so scaling alone would leave it sitting low in the tile.
  const scale = span / (MARK_WIDTH / 64);
  const mark = `<g transform="translate(32 32) scale(${scale}) translate(${-MARK_CENTER.x} ${-MARK_CENTER.y})"><path fill="url(#${gradId})" d="${MARK_PATH}"/></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">${defs}${background}${mark}</svg>`;
}

async function renderAll(jobs) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const results = [];
    for (const job of jobs) {
      const context = await browser.newContext({
        viewport: { width: job.size, height: job.size },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>${svgFor(job)}`;
      await page.setContent(html, { waitUntil: "load" });
      const buffer = await page.screenshot({
        omitBackground: job.variant === "foreground",
        clip: { x: 0, y: 0, width: job.size, height: job.size },
      });
      results.push({ ...job, buffer });
      await context.close();
    }
    return results;
  } finally {
    await browser.close();
  }
}

/* ------------------------------ PNG plumbing ------------------------------ */
/* Small enough to inline: read the IHDR, and (for the iOS icon) drop the alpha
 * channel, because the App Store rejects icons that carry one. */

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
  for (let i = 0; i < buffer.length; i++) crc = table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function readPng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9] };
    if (type === "IDAT") idat.push(Buffer.from(data));
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return { header, data: inflateSync(Buffer.concat(idat)) };
}

/** Re-encode 8-bit RGBA (colour type 6) as RGB (colour type 2), asserting every
 *  pixel is already fully opaque — silently dropping real transparency would
 *  hide a rendering mistake. */
function stripAlpha(buffer) {
  const { header, data } = readPng(buffer);
  if (!header) throw new Error("missing IHDR");
  if (header.colorType === 2) return buffer;
  if (header.colorType !== 6 || header.bitDepth !== 8) {
    throw new Error(`unexpected PNG format (colorType ${header.colorType}, bitDepth ${header.bitDepth})`);
  }
  const { width, height } = header;
  const stride = width * 4;
  const rgbStride = width * 3;
  const raw = Buffer.alloc(rgbStride * height + height); // +1 filter byte per row
  const prior = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = data[pos++];
    const source = data.subarray(pos, pos + stride);
    pos += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? line[x - 4] : 0;
      const b = prior[x];
      const c = x >= 4 ? prior[x - 4] : 0;
      let value;
      switch (filter) {
        case 0: value = source[x]; break;
        case 1: value = source[x] + a; break;
        case 2: value = source[x] + b; break;
        case 3: value = source[x] + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = source[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad filter ${filter}`);
      }
      line[x] = value & 0xff;
    }
    line.copy(prior);
    const rowStart = y * (rgbStride + 1) + 1;
    raw[rowStart - 1] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const alpha = line[x * 4 + 3];
      if (alpha !== 0xff) throw new Error(`iOS icon pixel ${x},${y} is not opaque (alpha ${alpha})`);
      raw[rowStart + x * 3] = line[x * 4];
      raw[rowStart + x * 3 + 1] = line[x * 4 + 1];
      raw[rowStart + x * 3 + 2] = line[x * 4 + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolour, no alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* --------------------------------- targets -------------------------------- */

const IOS_ICON = join(root, "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png");
const ANDROID_RES = join(root, "android/app/src/main/res");
const DENSITIES = [
  { dir: "mipmap-mdpi", size: 48, adaptive: 108 },
  { dir: "mipmap-hdpi", size: 72, adaptive: 162 },
  { dir: "mipmap-xhdpi", size: 96, adaptive: 216 },
  { dir: "mipmap-xxhdpi", size: 144, adaptive: 324 },
  { dir: "mipmap-xxxhdpi", size: 192, adaptive: 432 },
];
/** Adaptive foreground: mark inside the 66/108 safe zone → the glyph spans
 *  ~0.56 of the VISIBLE area = 0.56 × (72/108) ≈ 0.37 of the canvas. */
const FOREGROUND_SPAN = 0.37;
/** Tile/round variants: the web icon draws the mark at 0.5625 of the tile, but
 *  a home-screen icon is seen at ~60px — a little more presence reads better
 *  there while staying clearly the same mark. */
const TILE_SPAN = 0.66;
const ROUND_SPAN = 0.56;

function jobs() {
  const list = [{ path: IOS_ICON, size: 1024, variant: "tile", span: TILE_SPAN, ios: true }];
  for (const density of DENSITIES) {
    const dir = join(ANDROID_RES, density.dir);
    list.push({ path: join(dir, "ic_launcher.png"), size: density.size, variant: "tile", span: TILE_SPAN });
    list.push({ path: join(dir, "ic_launcher_round.png"), size: density.size, variant: "round", span: ROUND_SPAN });
    list.push({ path: join(dir, "ic_launcher_foreground.png"), size: density.adaptive, variant: "foreground", span: FOREGROUND_SPAN });
  }
  return list;
}

function assertBackgroundColor() {
  const file = join(ANDROID_RES, "values/ic_launcher_background.xml");
  const xml = readFileSync(file, "utf8");
  const match = /<color name="ic_launcher_background">(#?[0-9A-Fa-f]{6,8})<\/color>/.exec(xml);
  if (!match) throw new Error(`no ic_launcher_background colour found in ${file}`);
  const value = match[1].toUpperCase();
  if (value !== TILE.toUpperCase()) {
    throw new Error(
      `adaptive icon background must be the brand tile ${TILE} but is ${value} — the launcher would draw a white badge behind the mark`,
    );
  }
  return value;
}

/* ----------------------------------- run ---------------------------------- */

const targets = jobs();

if (CHECK_ONLY) {
  let bad = 0;
  for (const target of targets) {
    if (!existsSync(target.path)) {
      console.error(`MISSING ${target.path}`);
      bad += 1;
      continue;
    }
    const { header } = readPng(readFileSync(target.path));
    if (header.width !== target.size || header.height !== target.size) {
      console.error(`WRONG SIZE ${target.path}: ${header.width}×${header.height}, want ${target.size}`);
      bad += 1;
    }
    if (target.ios && header.colorType !== 2) {
      console.error(`ALPHA CHANNEL in ${target.path} (colorType ${header.colorType}) — App Store rejects alpha`);
      bad += 1;
    }
  }
  try {
    assertBackgroundColor();
  } catch (error) {
    console.error(String(error.message));
    bad += 1;
  }
  if (bad > 0) {
    console.error(`gen-app-icons --check FAILED (${bad} problem(s))`);
    process.exit(1);
  }
  console.log(`gen-app-icons --check OK — ${targets.length} icons, iOS icon alpha-free, adaptive background ${TILE}`);
} else {
  const rendered = await renderAll(targets);
  let written = 0;
  for (const item of rendered) {
    mkdirSync(dirname(item.path), { recursive: true });
    const buffer = item.ios ? stripAlpha(item.buffer) : item.buffer;
    writeFileSync(item.path, buffer);
    const { header } = readPng(buffer);
    console.log(
      `${item.path.slice(root.length + 1)}  ${item.size}×${item.size}  ${item.variant}  colorType=${header.colorType}`,
    );
    written += 1;
  }
  const background = assertBackgroundColor();
  console.log(`\ngen-app-icons: wrote ${written} icons (adaptive background ${background})`);
}
