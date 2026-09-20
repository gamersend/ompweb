import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));

const manifest = JSON.parse(readFileSync(`${publicDir}manifest.webmanifest`, "utf8"));

test("manifest is standalone with a root-scoped start URL", () => {
  assert.equal(manifest.name, "omp web");
  assert.equal(manifest.short_name, "omp web");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
});

test("manifest declares light+dark theme entries via prefers-color-scheme media", () => {
  // Standard fallback color plus the media-qualified pair the plan asks for.
  assert.match(manifest.theme_color, /^#[0-9a-fA-F]{6}$/);
  const entries = manifest.theme_color_media;
  assert.ok(Array.isArray(entries) && entries.length === 2, "expected one entry per scheme");
  const media = entries.map((entry) => entry.media);
  assert.ok(media.some((m) => m.includes("prefers-color-scheme: light")));
  assert.ok(media.some((m) => m.includes("prefers-color-scheme: dark")));
  for (const entry of entries) {
    assert.match(entry.color, /^#[0-9a-fA-F]{6}$/);
  }
});

test("manifest icons: 192 + 512 PNG, maskable pair, and an any-size SVG fallback", () => {
  const bySrc = new Map(manifest.icons.map((icon) => [icon.src, icon]));
  const required = [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icon-maskable-192.png", sizes: "192x192", purpose: "maskable" },
    { src: "/icon-maskable-512.png", sizes: "512x512", purpose: "maskable" },
  ];
  for (const { src, sizes, purpose } of required) {
    const icon = bySrc.get(src);
    assert.ok(icon, `missing icon ${src}`);
    assert.equal(icon.sizes, sizes, src);
    assert.equal(icon.purpose ?? "any", purpose, src);
    assert.ok(existsSync(`${publicDir}${src.slice(1)}`), `icon file missing: ${src}`);
  }
  const svg = manifest.icons.find((icon) => icon.type === "image/svg+xml");
  assert.ok(svg, "an any-size SVG icon must be present");
  assert.equal(svg.sizes, "any");
  assert.ok(existsSync(`${publicDir}${svg.src.slice(1)}`), `icon file missing: ${svg.src}`);
});

test("committed PNG icon dimensions match the manifest declarations", () => {
  for (const icon of manifest.icons) {
    if (icon.type !== "image/png") continue;
    const buffer = readFileSync(`${publicDir}${icon.src.slice(1)}`);
    assert.ok(buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${icon.src} is not a PNG`);
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    const [declaredW, declaredH] = icon.sizes.split("x").map(Number);
    assert.equal(width, declaredW, icon.src);
    assert.equal(height, declaredH, icon.src);
  }
});

test("layout links the static manifest", () => {
  const layout = readFileSync(fileURLToPath(new URL("../app/layout.tsx", import.meta.url)), "utf8");
  assert.match(layout, /manifest:\s*"\/manifest\.webmanifest"/);
  assert.ok(!existsSync(fileURLToPath(new URL("../app/manifest.ts", import.meta.url))),
    "app/manifest.ts must not compete with public/manifest.webmanifest for /manifest.webmanifest");
});
