"use client";

// ============================================================================
// Terminal tab (Phase 13; P11 adds opt-in PTY + select→composer) — the Right
// panel's pinned Terminal view.
//
// Plain mode (default): one shell child (allow-root spawned server-side) per
// tab, fed over SSE + the input route. No PTY — the banner documents the TUI
// limitation; herdr attach mode (env-gated, default OFF) is the escape hatch
// for full-screen apps: pane picker → watch (read-only) or attach (input +
// resize) with the 800 ms read poll diffed through planPaneRender().
//
// PTY mode (opt-in server-side via OMP_WEB_TERMINAL_PTY=1 + a passing
// node-pty probe): the create response reports mode:"pty"; the tab then
// forwards xterm resize (fit addon drives term.resize → onResize) to the
// input route as {type:"resize",cols,rows}, and the banner says full TUI
// apps work. Resize frames from the server are acks; pipe mode never sends.
//
// Select→composer: with a selection, a floating toolbar offers Copy
// selection and Insert into composer — the copy goes through lib/clipboard
// .ts, the insert through the lib/composer-insert.ts bus targeting the
// ACTIVE draft (same draftKey semantics as MemoryPanel), capped at 8 KB,
// never a send.
//
// Key encoding: special keys/chords go through lib/terminal-input.ts's
// toTerminalKeyData (its full-terminal home); printable text + IME flow
// through xterm's own onData. Paste is always wrapped with asBracketedPaste
// (a plain pipe cannot negotiate bracketed paste mode itself).
//
// This module is lazy-mounted (next/dynamic, ssr:false) by RightPanel —
// xterm.js never enters the initial bundle (BUILD-PLAN risk #4).
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ClipboardCopy, MessageSquarePlus, Radio, RefreshCw, RotateCw, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useI18n } from "@/lib/i18n";
import { useFontSize } from "@/hooks/useFontSize";
import { useTheme } from "@/hooks/useTheme";
import { copyText } from "@/lib/clipboard";
import { insertIntoComposer } from "@/lib/composer-insert";
import { TERMINAL_INSERT_MAX_BYTES, truncateToByteCap } from "@/lib/terminal/select-insert";
import { asBracketedPaste, toTerminalKeyData, type TerminalKeyEventLike } from "@/lib/terminal-input";
import { planPaneRender, type HerdrPaneMeta } from "@/lib/terminal/herdr-plan";
import type { CollabPeerRow, JobRow, ProcessRow } from "@/lib/omp/native-jobs";
import { Dialog, DialogContent, DialogTitle } from "./ui/primitives";
import { toast } from "./ui/toast";

type TerminalStatus = "creating" | "ready" | "exited" | "disabled" | "error";
type TerminalMode = { kind: "local" } | { kind: "herdr-watch"; pane: string; title: string } | { kind: "herdr-owner"; pane: string; title: string };

interface Props {
  /** Session cwd used to spawn the shell (captured at spawn time). */
  cwd: string | null;
  /** True while the terminal is the visible right-panel view — drives refit
   * + focus so a hidden panel never grabs keyboard input. */
  active: boolean;
  /** Draft key of the ACTIVE session composer (`<id>` or `new:<cwd>`) —
   * "Insert into composer" targets exactly that draft, never a split pane's
   * other draft (same semantics as MemoryPanel). */
  composerDraftKey: string | null;
}

const HERDR_POLL_MS = 800;

function readToken(name: string, computed: CSSStyleDeclaration): string {
  return computed.getPropertyValue(name).trim() || "#888888";
}

/** Build the xterm palette from the design tokens (no hardcoded colors —
 * every value is read out of the live stylesheet). */
function buildTerminalTheme(): import("@xterm/xterm").ITheme {
  const computed = getComputedStyle(document.documentElement);
  const v = (name: string) => readToken(name, computed);
  return {
    foreground: v("--text"),
    background: v("--bg-panel"),
    cursor: v("--accent"),
    cursorAccent: v("--bg-panel"),
    selectionBackground: v("--accent"),
    selectionForeground: v("--bg-panel"),
    black: v("--text-dim"),
    red: v("--accent-hover"),
    green: v("--status-success"),
    yellow: v("--status-modified"),
    blue: v("--accent"),
    magenta: v("--accent-strong"),
    cyan: v("--accent"),
    white: v("--text-muted"),
    brightBlack: v("--text-dim"),
    brightRed: v("--accent"),
    brightGreen: v("--status-success"),
    brightYellow: v("--status-modified"),
    brightBlue: v("--accent-strong"),
    brightMagenta: v("--accent"),
    brightCyan: v("--text-muted"),
    brightWhite: v("--text"),
  };
}

async function readJson(response: Response): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  let body: Record<string, unknown> = {};
  try {
    body = await response.json() as Record<string, unknown>;
  } catch {
    // Non-JSON error body.
  }
  return { ok: response.ok, status: response.status, body };
}

// ---------------------------------------------------------------------------
// P14: read-only native jobs/processes/peers section (above the terminal).
// Pure display helpers — the section renders whatever /api/jobs returned and
// offers NO action buttons; a pid is shown only as a tooltip and only when
// the source confirmed it.
// ---------------------------------------------------------------------------

/** Max rows rendered per group; the rest collapse into a "+N more" line. */
const PROCESSES_ROW_CAP = 20;

/** Group id → i18n key for the three compact lists. */
const PROCESSES_GROUP_LABEL_KEYS = {
  jobs: "processes.jobsGroup",
  processes: "processes.processesGroup",
  collab: "processes.collabGroup",
} as const;

type NativeJobsUnsupported = { unsupported: true; reason: string };

function isUnsupportedSection(value: unknown): value is NativeJobsUnsupported {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as { unsupported?: unknown }).unsupported === true;
}

/** One flattened display row for the section lists. */
interface ProcessDisplayRow {
  key: string;
  /** The stable identity shown first (always present — rows without ids were
   * already dropped server-side). */
  primary: string;
  /** Owner / kind / name detail, dimmed after the id. */
  secondary?: string;
  /** Status chip text, verbatim from the source. */
  status?: string;
  /** Trailing cell: formatted age, or the peer's lastSeen. */
  trailing?: string;
  /** Tooltip-only pid — displayed nowhere else, and only when confirmed. */
  pid?: number | null;
}

/** Compact human age for a source-provided ageMs (never computed from
 * anything else — absent means absent). */
function formatAge(ageMs: number | null | undefined): string | undefined {
  if (typeof ageMs !== "number" || !Number.isFinite(ageMs) || ageMs < 0) return undefined;
  if (ageMs < 1000) return "<1s";
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Chip color by status keyword — whitelist over the source's own text,
 * neutral when unrecognized. */
function statusColor(status: string | undefined): string {
  const s = status?.toLowerCase() ?? "";
  if (/running|active|ok|healthy|ready|online|up/.test(s)) return "var(--status-success)";
  if (/stop|kill|error|fail|dead|crash|down|exited|disabled/.test(s)) return "var(--accent-hover)";
  return "var(--text-dim)";
}

function jobDisplayRows(jobs: JobRow[]): ProcessDisplayRow[] {
  return jobs.map((job) => ({
    key: job.id,
    primary: job.id,
    secondary: job.owner ?? job.summary,
    status: job.status,
    trailing: formatAge(job.ageMs),
  }));
}

function processDisplayRows(processes: ProcessRow[]): ProcessDisplayRow[] {
  return processes.map((proc) => ({
    key: proc.id,
    primary: proc.id,
    secondary: proc.kind,
    status: proc.status,
    trailing: formatAge(proc.ageMs),
    pid: proc.pid,
  }));
}

function peerDisplayRows(peers: CollabPeerRow[]): ProcessDisplayRow[] {
  return peers.map((peer) => ({
    key: peer.id,
    primary: peer.id,
    secondary: peer.name ?? peer.role,
    status: peer.role,
    trailing: typeof peer.lastSeen === "string" ? peer.lastSeen : formatAge(peer.lastSeen),
  }));
}

export default function TerminalTab({ cwd, active, composerDraftKey }: Props) {
  const { t } = useI18n();
  const { fontSizePx } = useFontSize();
  const { isDark } = useTheme();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Terminal input queued while the create request is still in flight. */
  const pendingInputRef = useRef<string[]>([]);
  const paneContentRef = useRef<string | null>(null);
  const paneSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const disposedRef = useRef(false);
  /** P11: the live backend mode, set once the create response reports it —
   * resize forwarding and the banner branch on it. */
  const ptyModeRef = useRef(false);
  /** Last forwarded pty size (dedupes onResize bursts from fit()). */
  const sentSizeRef = useRef<{ cols: number; rows: number } | null>(null);

  const [spawnCwd, setSpawnCwd] = useState<string | null>(cwd);
  const [sessionSeq, setSessionSeq] = useState(0);
  const [status, setStatus] = useState<TerminalStatus>("creating");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [mode, setMode] = useState<TerminalMode>({ kind: "local" });
  const [ptyMode, setPtyMode] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [herdrEnabled, setHerdrEnabled] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [panes, setPanes] = useState<HerdrPaneMeta[]>([]);
  const terminalIdRef = useRef<string | null>(null);

  // P14: read-only native jobs/processes section — fetched ONLY while the
  // section is expanded, manual Refresh only (never polled). No action
  // buttons anywhere in it: this slice is observation only.
  const [processesOpen, setProcessesOpen] = useState(false);
  const [jobsData, setJobsData] = useState<{
    jobs: JobRow[] | NativeJobsUnsupported;
    processes: ProcessRow[] | NativeJobsUnsupported;
    collabPeers: CollabPeerRow[] | NativeJobsUnsupported;
  } | null>(null);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState(false);
  const jobsInFlightRef = useRef(false);

  const fetchJobsData = useCallback(async () => {
    if (jobsInFlightRef.current) return;
    jobsInFlightRef.current = true;
    setJobsLoading(true);
    setJobsError(false);
    try {
      const { ok, body } = await readJson(await fetch("/api/jobs"));
      if (!ok) {
        setJobsError(true);
        return;
      }
      const data = body.data as {
        jobs: JobRow[] | NativeJobsUnsupported;
        processes: ProcessRow[] | NativeJobsUnsupported;
        collabPeers: CollabPeerRow[] | NativeJobsUnsupported;
      } | undefined;
      if (data) {
        setJobsData({
          jobs: data.jobs ?? { unsupported: true, reason: "missing section" },
          processes: data.processes ?? { unsupported: true, reason: "missing section" },
          collabPeers: data.collabPeers ?? { unsupported: true, reason: "missing section" },
        });
      } else {
        setJobsError(true);
      }
    } catch {
      setJobsError(true);
    } finally {
      jobsInFlightRef.current = false;
      setJobsLoading(false);
    }
  }, []);

  // First expansion fetches once; a failed fetch stays failed until the
  // manual Refresh (or close+reopen) retries it.
  useEffect(() => {
    if (processesOpen && !jobsData) void fetchJobsData();
  }, [processesOpen, jobsData, fetchJobsData]);

  const jobsGroups = useMemo(() => {
    if (!jobsData) return null;
    const cap = <T,>(rows: T[]): T[] => rows.slice(0, PROCESSES_ROW_CAP);
    return [
      {
        id: "jobs" as const,
        unsupported: isUnsupportedSection(jobsData.jobs) ? jobsData.jobs : null,
        rows: Array.isArray(jobsData.jobs) ? cap(jobDisplayRows(jobsData.jobs)) : [],
        total: Array.isArray(jobsData.jobs) ? jobsData.jobs.length : 0,
      },
      {
        id: "processes" as const,
        unsupported: isUnsupportedSection(jobsData.processes) ? jobsData.processes : null,
        rows: Array.isArray(jobsData.processes) ? cap(processDisplayRows(jobsData.processes)) : [],
        total: Array.isArray(jobsData.processes) ? jobsData.processes.length : 0,
      },
      {
        id: "collab" as const,
        unsupported: isUnsupportedSection(jobsData.collabPeers) ? jobsData.collabPeers : null,
        rows: Array.isArray(jobsData.collabPeers) ? cap(peerDisplayRows(jobsData.collabPeers)) : [],
        total: Array.isArray(jobsData.collabPeers) ? jobsData.collabPeers.length : 0,
      },
    ];
  }, [jobsData]);

  const sendResize = useCallback(async (cols: number, rows: number) => {
    if (mode.kind !== "local") return;
    const id = terminalIdRef.current;
    if (!id) return;
    try {
      await fetch(`/api/terminal/${encodeURIComponent(id)}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "resize", cols, rows }),
      });
    } catch {
      // A dropped resize is corrected by the next fit-driven one.
    }
  }, [mode]);

  const forwardResizeIfPty = useCallback((cols: number, rows: number) => {
    if (!ptyModeRef.current) return; // pipe mode: resize is a no-op server-side
    const last = sentSizeRef.current;
    if (last && last.cols === cols && last.rows === rows) return;
    sentSizeRef.current = { cols, rows };
    void sendResize(cols, rows);
  }, [sendResize]);

  const sendInput = useCallback(async (data: string) => {
    const current = mode;
    if (current.kind === "herdr-watch") return;
    if (current.kind === "herdr-owner") {
      try {
        const response = await fetch("/api/terminal/herdr", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "send-text", paneId: current.pane, text: data }),
        });
        if (!response.ok) console.warn("herdr send failed", response.status);
      } catch {
        // Transient network errors surface on the next keystroke.
      }
      return;
    }
    const id = terminalIdRef.current;
    if (!id) {
      pendingInputRef.current.push(data);
      return;
    }
    try {
      const response = await fetch(`/api/terminal/${encodeURIComponent(id)}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      });
      if (response.status === 404 || response.status === 410) {
        setStatus("exited");
        setExitCode(null);
      }
    } catch {
      // Dropped keystrokes are unavoidable on a dead connection; the SSE
      // reconnect (or the exited state) tells the user what happened.
    }
  }, [mode]);

  // --------------------------------------------------------------------------
  // Terminal lifecycle (create → SSE → dispose), one per sessionSeq.
  // --------------------------------------------------------------------------
  useEffect(() => {
    disposedRef.current = false;
    let cancelled = false;
    setStatus("creating");
    setExitCode(null);
    setHasSelection(false);
    setPtyMode(false);
    ptyModeRef.current = false;
    sentSizeRef.current = null;
    terminalIdRef.current = null;
    pendingInputRef.current = [];
    paneContentRef.current = null;
    paneSizeRef.current = null;

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      fontSize: fontSizePx,
      fontFamily: "var(--font-mono, monospace)",
      theme: buildTerminalTheme(),
      disableStdin: false,
    });
    termRef.current = term;
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    if (containerRef.current) term.open(containerRef.current);
    try { fit.fit(); } catch { /* zero-size container pre-layout */ }

    // Key encoding: lib/terminal-input.ts owns every chord/special key
    // (its full-terminal home); xterm's onData handles printable text + IME.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === "paste") {
        return false; // paste flows through the textarea paste listener below
      }
      if (event.type !== "keydown") return true;
      const keyEvent = event as KeyboardEvent;
      const selection = term.hasSelection();
      if (selection && keyEvent.ctrlKey && keyEvent.shiftKey && keyEvent.key.toLowerCase() === "c") {
        void copyText(term.getSelection());
        return false;
      }
      if (selection && keyEvent.metaKey && keyEvent.key.toLowerCase() === "c") {
        void copyText(term.getSelection());
        return false;
      }
      if ((keyEvent.metaKey || (keyEvent.ctrlKey && !keyEvent.altKey)) && keyEvent.key.toLowerCase() === "v") {
        void (async () => {
          try {
            const text = await navigator.clipboard.readText();
            if (text) void sendInput(asBracketedPaste(text));
          } catch {
            toast.error(t("terminal.pasteFailed"));
          }
        })();
        return false;
      }
      const encoded = toTerminalKeyData(keyEvent as unknown as TerminalKeyEventLike);
      if (encoded !== null) {
        void sendInput(encoded);
        return false;
      }
      return true;
    });

    term.onData((data) => {
      if (data) void sendInput(data);
    });

    // P11: pty mode only — the fit addon's fit() drives term.resize, which
    // fires onResize; forward the new size to the input route. Pipe mode
    // never sends (the server no-ops resize anyway).
    term.onResize(({ cols, rows }) => {
      forwardResizeIfPty(cols, rows);
    });

    // P11: selection toolbar visibility (Copy / Insert into composer).
    term.onSelectionChange(() => {
      setHasSelection(term.hasSelection());
    });

    const openStream = (terminalId: string) => {
      const source = new EventSource(`/api/terminal/${encodeURIComponent(terminalId)}/events`);
      eventSourceRef.current = source;
      source.onmessage = (event) => {
        try {
          const frame = JSON.parse(event.data) as { t: string; b?: string; code?: number | null; cols?: number; rows?: number };
          if (frame.t === "d" && typeof frame.b === "string") {
            const bytes = Uint8Array.from(atob(frame.b), (c) => c.charCodeAt(0));
            term.write(bytes);
          } else if (frame.t === "resize") {
            // Resize ack (pty mode only) — the size is already applied
            // client-side; nothing to do.
          } else if (frame.t === "exit") {
            setExitCode(typeof frame.code === "number" ? frame.code : null);
            setStatus("exited");
            source.close();
          }
        } catch {
          // Malformed frame — skip.
        }
      };
      source.onerror = () => {
        // EventSource retries on its own; a purged terminal surfaces as an
        // exit via the reconciliation below.
      };
    };

    const drainPending = () => {
      const queued = pendingInputRef.current;
      pendingInputRef.current = [];
      for (const chunk of queued) void sendInput(chunk);
    };

    const startLocal = async () => {
      if (!spawnCwd) {
        setStatus("error");
        return;
      }
      try {
        const response = await fetch("/api/terminal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: spawnCwd }),
        });
        const { ok, body } = await readJson(response);
        if (cancelled) return;
        if (!ok) {
          if (body.code === "terminal_disabled") setStatus("disabled");
          else setStatus("error");
          return;
        }
        const data = body.data as { terminalId?: string; mode?: string } | undefined;
        if (!data?.terminalId) {
          setStatus("error");
          return;
        }
        terminalIdRef.current = data.terminalId;
        // P11: the backend mode decides resize forwarding + which banner.
        if (data.mode === "pty") {
          ptyModeRef.current = true;
          setPtyMode(true);
          // onResize may have fired before create resolved; push the current
          // size once so the pty starts at the real pane geometry.
          forwardResizeIfPty(term.cols, term.rows);
        }
        setStatus("ready");
        openStream(data.terminalId);
        drainPending();
      } catch {
        if (!cancelled) setStatus("error");
      }
    };

    const startHerdr = (watchMode: Extract<TerminalMode, { kind: "herdr-watch" | "herdr-owner" }>) => {
      term.options.disableStdin = watchMode.kind === "herdr-watch";
      setStatus("ready");
      const readOnce = async () => {
        if (disposedRef.current || cancelled) return;
        try {
          const response = await fetch(`/api/terminal/herdr?paneId=${encodeURIComponent(watchMode.pane)}`);
          const { ok, body } = await readJson(response);
          if (cancelled || disposedRef.current) return;
          if (!ok) return;
          const content = typeof body.content === "string" ? body.content : null;
          if (content === null) return;
          const previous = paneContentRef.current;
          const plan = previous === null ? { kind: "reset", text: content } : planPaneRender(previous, content);
          if (plan.kind === "reset") {
            term.reset();
            term.write(plan.text);
          } else if (plan.kind === "append") {
            term.write(plan.text);
          }
          paneContentRef.current = content;
          if (watchMode.kind === "herdr-owner") {
            const size = { cols: term.cols, rows: term.rows };
            const last = paneSizeRef.current;
            if (!last || last.cols !== size.cols || last.rows !== size.rows) {
              paneSizeRef.current = size;
              void fetch("/api/terminal/herdr", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "resize", paneId: watchMode.pane, cols: size.cols, rows: size.rows }),
              });
            }
          }
        } catch {
          // Transient poll errors wait for the next tick.
        }
      };
      void readOnce();
      pollTimerRef.current = setInterval(() => void readOnce(), HERDR_POLL_MS);
    };

    if (mode.kind === "local") {
      void startLocal();
    } else {
      startHerdr(mode);
    }

    return () => {
      cancelled = true;
      disposedRef.current = true;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      // Dispose-on-close: a local shell child is killed server-side when the
      // tab goes away (unmount, session switch, new shell). Fire-and-forget —
      // the manager's idle dispose is the backstop.
      const id = terminalIdRef.current;
      if (id) {
        void fetch(`/api/terminal?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
        terminalIdRef.current = null;
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // sessionSeq + mode drive (re)creation; fontSizePx/theme changes mutate
    // options instead of respawning; sendInput is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionSeq, mode.kind, mode.kind === "local" ? "" : mode.pane]);

  // --------------------------------------------------------------------------
  // Fit + focus
  // --------------------------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (!fitRef.current || !termRef.current) return;
      try { fitRef.current.fit(); } catch { /* unmeasurable */ }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      try { fitRef.current?.fit(); } catch { /* unmeasurable */ }
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  // Font size follows the chat font-size setting.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSizePx;
    try { fitRef.current?.fit(); } catch { /* unmeasurable */ }
  }, [fontSizePx]);

  // Theme tokens → xterm palette, recomputed when the app theme flips.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = buildTerminalTheme();
    // isDark participates so the effect re-runs on theme switches.
  }, [isDark, sessionSeq]);

  // --------------------------------------------------------------------------
  // herdr pane picker
  // --------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/terminal/herdr");
        const { ok, body } = await readJson(response);
        if (!cancelled && ok) setHerdrEnabled(body.enabled === true);
      } catch {
        // herdr stays hidden when the probe fails.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const openPicker = useCallback(async () => {
    setPickerOpen(true);
    setPickerLoading(true);
    try {
      const response = await fetch("/api/terminal/herdr");
      const { ok, body } = await readJson(response);
      if (ok) {
        setHerdrEnabled(body.enabled === true);
        setPanes(Array.isArray(body.panes) ? body.panes as HerdrPaneMeta[] : []);
      } else {
        toast.error(t("terminal.pickerLoadFailed"));
      }
    } catch {
      toast.error(t("terminal.pickerLoadFailed"));
    } finally {
      setPickerLoading(false);
    }
  }, [t]);

  const watchPane = useCallback((pane: HerdrPaneMeta) => {
    setPickerOpen(false);
    setBannerDismissed(false);
    setMode({ kind: "herdr-watch", pane: pane.id, title: pane.title ?? pane.id });
  }, []);

  const attachPane = useCallback(async (pane: HerdrPaneMeta) => {
    try {
      const { ok, body } = await readJson(await fetch("/api/terminal/herdr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "claim", paneId: pane.id }),
      }));
      if (!ok) {
        toast.error(String(body.error ?? "herdr attach failed"));
        return;
      }
      setPickerOpen(false);
      setBannerDismissed(false);
      setMode({ kind: "herdr-owner", pane: pane.id, title: pane.title ?? pane.id });
    } catch {
      toast.error(t("terminal.pickerLoadFailed"));
    }
  }, [t]);

  const detachHerdr = useCallback(() => {
    const current = mode;
    if (current.kind === "herdr-owner") {
      void fetch("/api/terminal/herdr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "release", paneId: current.pane }),
      }).catch(() => {});
    }
    setMode({ kind: "local" });
    setSessionSeq((seq) => seq + 1);
  }, [mode]);

  const startNewShell = useCallback(() => {
    if (mode.kind !== "local") {
      detachHerdr();
      return;
    }
    setSpawnCwd(cwd);
    setSessionSeq((seq) => seq + 1);
  }, [cwd, detachHerdr, mode.kind]);

  const statusLine = useMemo(() => {
    if (status === "creating") return t("terminal.loading");
    if (status === "disabled") return t("terminal.disabled");
    if (status === "error") return t("terminal.spawnFailed", { detail: "" });
    if (status === "exited") return exitCode !== null ? t("terminal.exited", { code: exitCode }) : t("terminal.exitNoCode");
    return mode.kind === "herdr-watch"
      ? t("terminal.watchBanner", { pane: mode.title })
      : mode.kind === "herdr-owner"
        ? t("terminal.ownerBanner", { pane: mode.title })
        : spawnCwd ?? "";
  }, [status, exitCode, mode, spawnCwd, t]);

  const showBanner = !bannerDismissed && mode.kind === "local" && (status === "ready" || status === "creating");

  // --------------------------------------------------------------------------
  // P11: selection → copy / insert into composer (never a send)
  // --------------------------------------------------------------------------
  const currentSelection = useCallback((): string => termRef.current?.getSelection() ?? "", []);

  const handleCopySelection = useCallback(async () => {
    const selection = currentSelection();
    if (!selection) return;
    try {
      await copyText(selection);
    } catch {
      toast.error(t("terminal.copyFailed"));
    }
  }, [currentSelection, t]);

  const handleInsertSelection = useCallback(() => {
    const selection = currentSelection();
    if (!selection) return;
    const { text, truncated } = truncateToByteCap(selection, TERMINAL_INSERT_MAX_BYTES);
    insertIntoComposer({ text, draftKey: composerDraftKey ?? undefined, source: "terminal" });
    if (truncated) toast.error(t("terminal.insertTruncated"));
    else toast.info(t("terminal.inserted"));
  }, [composerDraftKey, currentSelection, t]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg-panel)" }}>
      {/* Toolbar */}
      <div
        role="toolbar"
        aria-label={t("terminal.tab")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          flexShrink: 0,
          padding: "3px 6px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
        }}
      >
        <span
          title={statusLine}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--text-dim)",
          }}
        >
          {statusLine}
        </span>
        {herdrEnabled && (
          <button
            onClick={() => void openPicker()}
            title={t("terminal.pickPane")}
            aria-label={t("terminal.pickPane")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 24, padding: 0, background: "none", border: "none",
              borderRadius: "var(--radius-control)", color: mode.kind === "local" ? "var(--text-dim)" : "var(--accent)", cursor: "pointer",
            }}
          >
            <Radio size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
        {mode.kind !== "local" && (
          <button
            onClick={detachHerdr}
            title={t("terminal.detach")}
            aria-label={t("terminal.detach")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 24, padding: 0, background: "none", border: "none",
              borderRadius: "var(--radius-control)", color: "var(--text-dim)", cursor: "pointer",
            }}
          >
            <X size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
        <button
          onClick={startNewShell}
          disabled={status === "creating"}
          title={t("terminal.newShell")}
          aria-label={t("terminal.newShell")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 26, height: 24, padding: 0, background: "none", border: "none",
            borderRadius: "var(--radius-control)", color: "var(--text-dim)", cursor: status === "creating" ? "default" : "pointer",
            opacity: status === "creating" ? 0.5 : 1,
          }}
        >
          <RotateCw size={13} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {/* Mode banner (P11): states the ACTUAL backend. Pipe = the no-PTY
          limitation + herdr escape hatch; PTY = full TUI apps work. */}
      {showBanner && (
        <div
          role="status"
          style={{
            flexShrink: 0,
            margin: "6px 8px 0",
            padding: "7px 10px",
            background: "var(--bg-subtle)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            fontSize: 11,
            lineHeight: 1.55,
            color: "var(--text-muted)",
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong style={{ color: "var(--text)", display: "block", marginBottom: 2 }}>
              {ptyMode ? t("terminal.bannerTitlePty") : t("terminal.bannerTitle")}
            </strong>
            <span>{ptyMode ? t("terminal.bannerBodyPty") : t("terminal.bannerBody")}</span>
            {!ptyMode && !herdrEnabled && (
              <span style={{ display: "block", marginTop: 2, color: "var(--text-dim)" }}>{t("terminal.bannerHerdrHint")}</span>
            )}
          </div>
          <button
            onClick={() => setBannerDismissed(true)}
            aria-label={t("terminal.bannerDismiss")}
            title={t("terminal.bannerDismiss")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
              width: 22, height: 22, padding: 0, background: "none", border: "none",
              borderRadius: "var(--radius-control)", color: "var(--text-dim)", cursor: "pointer",
            }}
          >
            <X size={12} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* P14: read-only native jobs/processes/peers — collapsed by default,
          fetched only while expanded, manual refresh only. NO action buttons:
          this slice is observation only (safe controls are a later phase). */}
      <div
        role="region"
        aria-label={t("processes.section")}
        style={{ flexShrink: 0, borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "1px 8px", minHeight: 24 }}>
          <button
            onClick={() => setProcessesOpen((open) => !open)}
            aria-expanded={processesOpen}
            title={t("processes.section")}
            style={{
              display: "flex", alignItems: "center", gap: 5, flex: 1, minWidth: 0,
              padding: "3px 0", background: "none", border: "none",
              color: "var(--text-dim)", fontSize: 11, cursor: "pointer", textAlign: "left",
            }}
          >
            {processesOpen
              ? <ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
              : <ChevronRight size={13} strokeWidth={2} aria-hidden="true" />}
            <span>{t("processes.section")}</span>
          </button>
          {processesOpen && (
            <button
              onClick={() => void fetchJobsData()}
              disabled={jobsLoading}
              title={t("processes.refresh")}
              aria-label={t("processes.refresh")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                width: 24, height: 22, padding: 0, background: "none", border: "none",
                borderRadius: "var(--radius-control)", color: "var(--text-dim)",
                cursor: jobsLoading ? "default" : "pointer", opacity: jobsLoading ? 0.5 : 1,
              }}
            >
              <RefreshCw size={12} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </div>
        {processesOpen && (
          <div style={{ maxHeight: 220, overflowY: "auto", padding: "0 10px 8px", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("processes.readOnlyHint")}</div>
            {jobsError && (
              <div style={{ fontSize: 11, color: "var(--accent-hover)" }}>{t("processes.loadFailed")}</div>
            )}
            {jobsLoading && !jobsData && (
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("processes.loading")}</div>
            )}
            {jobsGroups?.map((group) => (
              <div key={group.id}>
                <div style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 600, marginBottom: 2 }}>
                  {t(PROCESSES_GROUP_LABEL_KEYS[group.id])}
                </div>
                {group.unsupported ? (
                  <div style={{ fontSize: 11, color: "var(--text-dim)", overflowWrap: "anywhere" }}>
                    {t("processes.unsupported", { reason: group.unsupported.reason })}
                  </div>
                ) : group.rows.length === 0 ? (
                  <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("processes.empty")}</div>
                ) : (
                  <ul role="list" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                    {group.rows.map((row) => (
                      <li key={row.key} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "wrap", fontSize: 11, lineHeight: 1.5 }}>
                        <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: statusColor(row.status) }} />
                        <span
                          title={row.pid != null ? t("processes.pidTooltip", { pid: row.pid }) : row.primary}
                          style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flexShrink: 1, color: "var(--text)", fontFamily: "var(--font-mono)" }}
                        >
                          {row.primary}
                        </span>
                        {row.secondary && (
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0, color: "var(--text-dim)", fontSize: 10 }}>
                            {row.secondary}
                          </span>
                        )}
                        {row.status && (
                          <span style={{
                            flexShrink: 0, color: statusColor(row.status), fontSize: 10,
                            border: "1px solid var(--border)", borderRadius: 999, padding: "0 6px",
                            maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          }}>
                            {row.status}
                          </span>
                        )}
                        {row.trailing && (
                          <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)" }}>
                            {row.trailing}
                          </span>
                        )}
                      </li>
                    ))}
                    {group.total > group.rows.length && (
                      <li style={{ fontSize: 10, color: "var(--text-dim)", padding: "2px 0" }}>
                        {t("processes.more", { count: group.total - group.rows.length })}
                      </li>
                    )}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Terminal surface (wrapped so the selection toolbar can float without
          reflowing the xterm grid mid-drag) */}
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <div
          ref={containerRef}
          role="region"
          aria-label={t("terminal.a11yRegion")}
          aria-live={status === "ready" ? "off" : "polite"}
          tabIndex={-1}
          style={{ position: "absolute", inset: 0, padding: "4px 6px", overflow: "hidden", outline: "none" }}
        />
        {hasSelection && status === "ready" && mode.kind === "local" && (
          <div
            role="toolbar"
            aria-label={t("terminal.selectionToolbar")}
            style={{
              position: "absolute",
              right: 12,
              bottom: 12,
              display: "flex",
              gap: 6,
              padding: 5,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              boxShadow: "var(--shadow-pop)",
              zIndex: 2,
            }}
          >
            <button
              onClick={handleInsertSelection}
              title={t("terminal.insertIntoComposer")}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "4px 9px", background: "var(--bg-subtle)",
                border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
                color: "var(--text)", fontSize: 11, cursor: "pointer",
              }}
            >
              <MessageSquarePlus size={13} strokeWidth={2} aria-hidden="true" />
              {t("terminal.insertIntoComposer")}
            </button>
            <button
              onClick={() => void handleCopySelection()}
              title={t("terminal.copySelection")}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "4px 9px", background: "var(--bg-subtle)",
                border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
                color: "var(--text)", fontSize: 11, cursor: "pointer",
              }}
            >
              <ClipboardCopy size={13} strokeWidth={2} aria-hidden="true" />
              {t("terminal.copySelection")}
            </button>
          </div>
        )}
      </div>

      {/* Non-ready overlays keep the region informative for screen readers */}
      {(status === "disabled" || status === "error" || status === "exited") && (
        <div style={{ padding: "0 8px 8px", flexShrink: 0 }}>
          <button
            onClick={startNewShell}
            style={{
              width: "100%",
              padding: "6px 10px",
              background: "var(--bg-subtle)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              color: "var(--text)",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {t("terminal.restart")}
          </button>
        </div>
      )}

      {/* herdr pane picker */}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent ariaLabel={t("terminal.pickerTitle")}>
          <DialogTitle>{t("terminal.pickerTitle")}</DialogTitle>
          {pickerLoading ? (
            <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{t("terminal.loading")}</div>
          ) : panes.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{t("terminal.pickerEmpty")}</div>
          ) : (
            <ul role="listbox" aria-label={t("terminal.pickerTitle")} style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {panes.map((pane) => (
                <li
                  key={pane.id}
                  role="option"
                  aria-selected={false}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void watchPane(pane);
                    }
                  }}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
                    background: "var(--bg-subtle)", border: "1px solid var(--border)",
                    borderRadius: "var(--radius-control)", cursor: "pointer", fontSize: 12,
                  }}
                  onClick={() => void watchPane(pane)}
                >
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
                    {pane.title ?? pane.id}
                    {pane.cwd ? <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginLeft: 6 }}>{pane.cwd}</span> : null}
                    {pane.owner ? <span style={{ display: "block", color: "var(--text-dim)", fontSize: 10 }}>{t("terminal.attachedBy", { owner: pane.owner })}</span> : null}
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); void attachPane(pane); }}
                    disabled={pane.owner !== null}
                    title={pane.owner !== null ? t("terminal.attachedBy", { owner: pane.owner }) : t("terminal.attach")}
                    style={{
                      padding: "3px 8px", background: "var(--bg-panel)", border: "1px solid var(--border)",
                      borderRadius: "var(--radius-control)", color: pane.owner !== null ? "var(--text-dim)" : "var(--accent)",
                      fontSize: 11, cursor: pane.owner !== null ? "default" : "pointer", flexShrink: 0, opacity: pane.owner !== null ? 0.6 : 1,
                    }}
                  >
                    {t("terminal.attach")}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); void watchPane(pane); }}
                    title={t("terminal.watch")}
                    style={{
                      padding: "3px 8px", background: "var(--bg-panel)", border: "1px solid var(--border)",
                      borderRadius: "var(--radius-control)", color: "var(--text)", fontSize: 11, cursor: "pointer", flexShrink: 0,
                    }}
                  >
                    {t("terminal.watch")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
