export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;
export const IMAGE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
export const DOCX_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

export type DocumentPreviewKind = "pdf" | "docx";

export const IMAGE_EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

export const AUDIO_EXT_TO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  weba: "audio/webm",
  webm: "audio/webm",
};

export const DOCUMENT_EXT_TO_MIME: Record<DocumentPreviewKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function getBaseName(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").pop() ?? "";
}

export function getFileExt(filePath: string): string {
  return getBaseName(filePath).toLowerCase().split(".").pop() ?? "";
}

export function getImageMime(filePath: string): string | null {
  return IMAGE_EXT_TO_MIME[getFileExt(filePath)] ?? null;
}

export function getAudioMime(filePath: string): string | null {
  return AUDIO_EXT_TO_MIME[getFileExt(filePath)] ?? null;
}

export function getDocumentMime(filePath: string): string | null {
  return DOCUMENT_EXT_TO_MIME[getFileExt(filePath) as DocumentPreviewKind] ?? null;
}

export function documentPreviewKind(filePath: string): DocumentPreviewKind | null {
  const ext = getFileExt(filePath);
  if (ext === "pdf" || ext === "docx") return ext;
  return null;
}

/**
 * SVG is the only streamed preview type a browser executes as a document.
 * Serving it without a restrictive Content-Security-Policy would let a
 * repo-controlled SVG, opened as a direct navigation, run script in the
 * omp-web origin where every /api route is reachable. These headers only
 * affect document rendering; <img> preview embedding ignores them. The
 * directives mirror the DOCX preview policy in app/api/files/[...path]/route.ts
 * so legit SVGs keep inline styles and data-URI images.
 */
export function getStreamSecurityHeaders(contentType: string): Record<string, string> {
  if (contentType !== "image/svg+xml") return {};
  return {
    "Content-Security-Policy":
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  };
}

/**
 * Extensions the file editor must never load or write. The list is a
 * denylist on purpose: text formats appear faster than anyone updates an
 * allowlist, and the route additionally refuses any body that is not valid
 * UTF-8, so a mislabeled binary still cannot be served or saved as text.
 * Mirrored by the editor's own load path — keep both on this one constant.
 */
const BINARY_EDIT_DENYLIST = new Set([
  // Images (includes svg+xml? no — svg is text and safe to edit as text)
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "tif", "tiff", "heic", "heif",
  // Audio / video
  "mp3", "wav", "ogg", "oga", "opus", "m4a", "aac", "flac", "weba", "webm",
  "mp4", "mov", "avi", "mkv", "wmv", "flv", "m4v", "mpg", "mpeg",
  // Documents / print
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  // Archives / packages / disk images
  "zip", "tar", "gz", "bz2", "xz", "zst", "7z", "rar", "jar", "war", "apk", "ipa", "dmg", "iso", "img",
  // Executables / libraries / object code
  "exe", "dll", "so", "dylib", "bin", "com", "msi", "elf", "o", "obj", "a", "lib", "class", "pyc", "pyo", "wasm",
  // Fonts
  "ttf", "otf", "woff", "woff2", "eot",
  // Databases / compiled stores
  "db", "sqlite", "sqlite3", "mdb", "accdb", "dat",
  // Certificates / key material and other opaque blobs
  "p12", "pfx", "keystore", "der", "crt",
]);

export function isEditableTextPath(filePath: string): boolean {
  return !BINARY_EDIT_DENYLIST.has(getFileExt(filePath));
}

export function isImagePath(filePath: string): boolean {
  return getImageMime(filePath) !== null;
}

export function isAudioPath(filePath: string): boolean {
  return getAudioMime(filePath) !== null;
}

export function isDocumentPreviewPath(filePath: string): boolean {
  return documentPreviewKind(filePath) !== null;
}

/** Hard size cap for the FileViewer editor load/save paths (2 MB). */
export const EDITOR_MAX_BYTES = 2 * 1024 * 1024;
