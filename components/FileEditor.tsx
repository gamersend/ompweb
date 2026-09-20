"use client";

/**
 * Plain textarea file editor behind the FileViewer's edit toggle (BUILD-PLAN
 * Phase 10). Owns: caret line/col status, Ctrl/Cmd+S save, Ctrl/Cmd+G
 * go-to-line, dirty tracking (bubbled to the tab strip), a saved-content
 * syntax preview toggle, and the >1MB read-only / >512KB preview caps.
 *
 * The actual PUT lives in the FileViewer (single owner of the on-disk
 * baseline); this component calls back through `onSave`.
 *
 * EOL note: HTML textareas normalize the API value to LF, so a CRLF file
 * round-tripped through the textarea getter would silently lose its CRs.
 * The loaded EOL style is detected once, the textarea only ever sees LF,
 * and the exact original EOL is restored when the content is handed back
 * for saving — mixed-EOL files converge to their dominant style.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { Eye, EyeOff, Lock, Save } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { getFileName } from "@/lib/file-paths";
import { Tooltip } from "./ui/primitives";
import { SyntaxHighlightedCode } from "./SyntaxHighlightedCode";

/** Files larger than this load read-only (BUILD-PLAN: editor budget). */
export const EDITOR_READONLY_MAX_BYTES = 1024 * 1024;
/** Above this the syntax-preview toggle is disabled — no Prism parse. */
export const EDITOR_PREVIEW_MAX_BYTES = 512 * 1024;

export type EditorEol = "\r\n" | "\n" | "\r";

/** Dominant EOL style of the loaded file: CRLF wins, then lone CR, else LF. */
export function detectEol(text: string): EditorEol {
  if (text.includes("\r\n")) return "\r\n";
  if (text.includes("\r")) return "\r";
  return "\n";
}

/** Textarea-facing form: every CR variant normalized to LF. */
export function normalizeToLf(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

/** Undo normalizeToLf for the save path: LF joined back with `eol`. */
export function restoreEol(text: string, eol: EditorEol): string {
  if (eol === "\n") return text;
  return text.replace(/\n/g, eol);
}

const UTF8_ENCODER = new TextEncoder();

function utf8Bytes(text: string): number {
  return UTF8_ENCODER.encode(text).length;
}

export interface FileEditorHandle {
  /** Persist the current value. Resolves false when nothing was written. */
  save: () => Promise<boolean>;
  /** Current value in the textarea (LF-normalized). */
  getValue: () => string;
  focus: () => void;
}

interface Props {
  filePath: string;
  language: string;
  /** On-disk baseline this editor was opened with (LF vs EOL agnostic). */
  content: string;
  /** Persist `content`; resolve with the written stat or null on failure. */
  onSave: (content: string) => Promise<{ mtime: string; size: number } | null>;
  /** Dirty flips bubble to the tab strip through the FileViewer. */
  onDirtyChange?: (dirty: boolean) => void;
}

type SaveState = "idle" | "saving" | "saved" | "error";

const TEXTAREA_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  width: "100%",
  boxSizing: "border-box",
  margin: 0,
  padding: "10px 12px",
  border: "none",
  outline: "none",
  resize: "none",
  background: "var(--bg)",
  color: "var(--text)",
  fontFamily: "var(--font-mono)",
  fontSize: 12.5,
  lineHeight: 1.62,
  tabSize: 2,
  whiteSpace: "pre",
  overflowWrap: "normal",
};

export const FileEditor = forwardRef<FileEditorHandle, Props>(function FileEditor(
  { filePath, language, content, onSave, onDirtyChange },
  ref,
) {
  const { t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gotoInputRef = useRef<HTMLInputElement | null>(null);
  const savingRef = useRef(false);

  const [value, setValue] = useState(() => normalizeToLf(content));
  const [savedValue, setSavedValue] = useState(() => normalizeToLf(content));
  const [caret, setCaret] = useState({ line: 1, col: 1 });
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [showPreview, setShowPreview] = useState(false);
  const [gotoOpen, setGotoOpen] = useState(false);
  const [gotoValue, setGotoValue] = useState("");

  const eol = useMemo(() => detectEol(content), [content]);
  const baselineBytes = useMemo(() => utf8Bytes(content), [content]);
  const readOnly = baselineBytes > EDITOR_READONLY_MAX_BYTES;
  const previewAvailable = baselineBytes <= EDITOR_PREVIEW_MAX_BYTES;
  const dirty = value !== savedValue;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // External reloads (disk changed while not dirty) arrive as a new `content`
  // prop; adopt it only while the user has no local edits so a swap can never
  // clobber typing. While dirty the FileViewer routes the change to the
  // reload/overwrite dialog instead of silently swapping the baseline.
  useEffect(() => {
    const next = normalizeToLf(content);
    if (!dirtyRef.current) setValue(next);
    setSavedValue(next);
  }, [content]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const updateCaret = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const upToCaret = ta.value.slice(0, ta.selectionStart);
    const lastBreak = upToCaret.lastIndexOf("\n");
    setCaret({
      line: lastBreak === -1 ? 1 : upToCaret.slice(0, lastBreak).split("\n").length + 1,
      col: ta.selectionStart - lastBreak,
    });
  }, []);

  const jumpToLine = useCallback((line: number) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const lines = value.split("\n");
    const target = Math.min(Math.max(1, Math.trunc(line)), lines.length);
    let offset = 0;
    for (let i = 1; i < target; i++) offset = value.indexOf("\n", offset) + 1;
    const lineEnd = value.indexOf("\n", offset);
    ta.focus();
    // Select the target line so it is visibly anchored, not just a caret.
    ta.setSelectionRange(offset, lineEnd === -1 ? value.length : lineEnd);
    updateCaret();
  }, [updateCaret, value]);

  const save = useCallback(async (): Promise<boolean> => {
    if (savingRef.current || readOnly) return false;
    savingRef.current = true;
    setSaveState("saving");
    try {
      const written = await onSave(restoreEol(value, eol));
      if (!written) {
        setSaveState("error");
        return false;
      }
      // saveValue is EOL-restored on purpose: dirty compares against the
      // normalized form of exactly what was persisted.
      setSavedValue(value);
      setSaveState("saved");
      return true;
    } finally {
      savingRef.current = false;
    }
  }, [eol, onSave, readOnly, value]);

  useImperativeHandle(ref, () => ({
    save,
    getValue: () => value,
    focus: () => textareaRef.current?.focus(),
  }), [save, value]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement | HTMLTextAreaElement>) => {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || event.altKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      void save();
      return;
    }
    if (key === "g" && !readOnly) {
      event.preventDefault();
      setGotoValue("");
      setGotoOpen(true);
    }
  }, [readOnly, save]);

  // The go-to-line input mounts on open; pull focus without a rAF dance.
  useEffect(() => {
    if (gotoOpen) gotoInputRef.current?.focus();
  }, [gotoOpen]);

  const submitGoto = useCallback(() => {
    const parsed = Number.parseInt(gotoValue.trim(), 10);
    setGotoOpen(false);
    if (!Number.isFinite(parsed)) {
      textareaRef.current?.focus();
      return;
    }
    jumpToLine(parsed);
  }, [gotoValue, jumpToLine]);

  const saveStatusLabel = saveState === "saving"
    ? t("fileEditor.saving")
    : saveState === "saved"
      ? t("fileEditor.saved")
      : saveState === "error"
        ? t("fileEditor.saveFailed")
        : dirty
          ? t("fileEditor.unsavedHint")
          : "";

  return (
    <div
      className="file-editor"
      onKeyDown={handleKeyDown}
      style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: "var(--bg)" }}
    >
      {showPreview && previewAvailable ? (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "var(--bg)" }}>
          <SyntaxHighlightedCode code={savedValue} lang={language === "text" ? "plaintext" : language} />
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          className="file-editor-textarea"
          value={value}
          readOnly={readOnly}
          spellCheck={false}
          wrap="off"
          aria-label={t("fileEditor.editorAriaLabel", { name: getFileName(filePath) })}
          onChange={(event) => {
            setValue(event.target.value);
            setSaveState("idle");
          }}
          onKeyUp={updateCaret}
          onClick={updateCaret}
          onSelect={updateCaret}
          style={TEXTAREA_STYLE}
        />
      )}

      <div
        className="file-editor-statusbar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexShrink: 0,
          padding: "3px 12px",
          borderTop: "1px solid var(--border)",
          background: "var(--bg-panel)",
          color: "var(--text-dim)",
          fontSize: 11,
          fontFamily: "var(--font-mono)",
        }}
      >
        <span>{t("fileEditor.lineCol", { line: caret.line, col: caret.col })}</span>
        {readOnly && (
          <span style={{ color: "var(--status-warning)", display: "inline-flex", alignItems: "center", gap: 4 }}>
            <Lock size={11} aria-hidden="true" />
            {t("fileEditor.readOnly")}
          </span>
        )}
        {dirty && !readOnly && (
          <span
            aria-hidden="true"
            title={t("fileEditor.unsavedHint")}
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "var(--status-modified)",
              display: "inline-block",
            }}
          />
        )}
        <span role="status" aria-live="polite" style={{ color: saveState === "error" ? "var(--status-error)" : undefined }}>
          {saveStatusLabel}
        </span>

        {gotoOpen && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <input
              ref={gotoInputRef}
              className="file-editor-goto-input"
              value={gotoValue}
              onChange={(event) => setGotoValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitGoto();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setGotoOpen(false);
                  textareaRef.current?.focus();
                }
              }}
              onBlur={() => setGotoOpen(false)}
              placeholder={t("fileEditor.goToLine")}
              aria-label={t("fileEditor.goToLine")}
              inputMode="numeric"
              size={6}
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                color: "var(--text)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                padding: "1px 6px",
                outline: "none",
              }}
            />
          </span>
        )}

        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 2 }}>
          {eol !== "\n" && <span title={t("fileEditor.eolLabel", { eol: eol === "\r\n" ? "CRLF" : "CR" })}>{eol === "\r\n" ? "CRLF" : "CR"}</span>}
          <Tooltip content={previewAvailable ? t("fileEditor.syntaxPreview") : t("fileEditor.syntaxPreviewUnavailable")}>
            <button
              type="button"
              disabled={!previewAvailable}
              onClick={() => setShowPreview((v) => !v)}
              aria-pressed={showPreview}
              aria-label={previewAvailable ? t("fileEditor.syntaxPreview") : t("fileEditor.syntaxPreviewUnavailable")}
              className="file-editor-preview-toggle"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 22,
                height: 22,
                padding: 0,
                border: "none",
                borderRadius: "var(--radius-control)",
                background: showPreview ? "var(--bg-selected)" : "transparent",
                color: showPreview ? "var(--text)" : "var(--text-muted)",
                cursor: previewAvailable ? "pointer" : "default",
                opacity: previewAvailable ? 1 : 0.45,
              }}
            >
              {showPreview
                ? <EyeOff size={13} strokeWidth={2} aria-hidden="true" />
                : <Eye size={13} strokeWidth={2} aria-hidden="true" />}
            </button>
          </Tooltip>
          {!readOnly && (
            <Tooltip content={t("fileEditor.saveNow")}>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saveState === "saving"}
                aria-label={t("fileEditor.saveNow")}
                className="file-editor-save-button"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 22,
                  height: 22,
                  padding: 0,
                  border: "none",
                  borderRadius: "var(--radius-control)",
                  background: dirty ? "var(--bg-selected)" : "transparent",
                  color: dirty ? "var(--text)" : "var(--text-muted)",
                  cursor: saveState === "saving" ? "wait" : "pointer",
                  opacity: dirty ? 1 : 0.55,
                }}
              >
                <Save size={13} strokeWidth={2} aria-hidden="true" />
              </button>
            </Tooltip>
          )}
        </span>
      </div>
    </div>
  );
});
