"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useSidebarHistory } from "@/hooks/useSidebarHistory";
import { SessionSidebar } from "./SessionSidebar";
import { ToastProvider } from "./ui/toast";
import { toast } from "./ui/toast";
import { ConfirmDialog } from "./ui/field";
import { ChatWindow } from "./ChatWindow";
import { type Tab } from "./TabBar";
import { type FileExplorerHandle } from "./FileExplorer";
import type { RightPanelView } from "./RightPanel";
import { BranchNavigator } from "./BranchNavigator";
import { SessionExportMenu } from "./SessionExportMenu";
import { SplitPane, type SplitPaneSide } from "./SplitPane";
import { useSplitSession } from "@/hooks/useSplitSession";
import { isEnabled } from "@/lib/feature-flags";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { Check, Columns2, Ellipsis, Folder, LayoutGrid, Menu, PanelLeft, Terminal, Wand2, Zap } from "lucide-react";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { translate, useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/i18n/api-error";
import { formatGenerationSpeed } from "@/lib/generation-speed";
import { useIsMobile } from "@/hooks/useIsMobile";
import { copyText } from "@/lib/clipboard";
import { encodeFilePathForApi, getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import {
  buildShareDraftMessage,
  getInitialNavigation,
  parseShareTarget,
  stripShareTargetParams,
  type InitialAnchor,
  type SharedTargetPayload,
} from "@/lib/initial-navigation";
import { launchCommandFields } from "@/lib/launch-profile";
import { comparableProjectPath } from "@/lib/comparable-path";
import { clearDraft, getDraft, setDraft } from "@/lib/draft-store";
import { insertIntoComposer } from "@/lib/composer-insert";
import { initClientStateSync } from "@/lib/client-state-sync";
import { showCompletionNotification } from "@/lib/browser-notifications";
import { openPalette } from "@/lib/palette-bus";
import type { SearchResultItem } from "./PaletteSearch";
import {
  APP_UPDATE_COMPLETED_RELOAD_MS,
  APP_UPDATE_POLL_MS,
  APP_UPDATE_PREPARING_MIN_MS,
  APP_UPDATE_STOPPING_POLL_MS,
  APP_UPDATE_TIMEOUT_MS,
  APP_UPDATE_VISIBLE_STAGE_MIN_MS,
  AppUpdateTransportError,
  COMPLETED_APP_UPDATE_KEY,
  DISMISSED_APP_UPDATE_KEY,
  DISMISSED_OMP_UPDATE_KEY,
  fetchAppUpdateJson,
  isExactLegacyTargetCompletion,
  readDismissedVersion,
  rememberDismissedVersion,
  sanitizeAppUpdateError,
  waitForAppUpdateDwell,
} from "./AppShell-app-update";
import {
  PanelLoadingFallback,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_WIDTH_STORAGE_KEY,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampRightPanelWidth,
  clampSidebarWidth,
  loadRightPanelWidth,
  loadSidebarWidth,
  projectLabel,
} from "./AppShell-layout";
import type { ManagedProject, SessionInfo, SessionTreeNode } from "@/lib/types";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionStatsInfo, GenerationSpeedInfo } from "@/lib/pi-types";
import type { SettingsTab } from "./SettingsTabs";
import { SettingsConfig } from "./SettingsConfig";
import {
  AppUpdateDialog,
  getAppUpdateStageIndex,
  getNextAppUpdateStage,
  getMonotonicAppUpdateStage,
  type AppUpdateInfo,
  type AppUpdatePhase,
  type AppUpdateStage,
} from "./AppUpdateDialog";
import { ArchiveBrowser } from "./ArchiveBrowser";
import { NotificationsBell } from "./NotificationsBell";
import { RunsBoard } from "./RunsBoard";
import { LiveCallChip } from "./LiveCallChip";
import { publishSessionsChanged } from "@/lib/session-change-bus";
// The settings shell is part of the app bundle so opening it does not fetch or compile a modal chunk. The right panel (viewer included) remains on demand.
const RightPanel = dynamic(() => import("./RightPanel").then((m) => m.RightPanel), {
  ssr: false,
  loading: () => <PanelLoadingFallback />,
});

const TOOL_CALLS_COLLAPSED_STORAGE_KEY = "omp-web:tool-calls-collapsed";
const PROVIDER_USAGE_VISIBLE_STORAGE_KEY = "omp-web:provider-usage-visible";
const NATIVE_SELECT_ALL_STORAGE_KEY = "omp-web:scope-native-select-all";

const CommandPalette = dynamic(() => import("./CommandPalette").then((m) => m.CommandPalette), {
  ssr: false,
});

type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };
type TimerHandle = NodeJS.Timeout;

export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialNavigation] = useState(() => getInitialNavigation(searchParams));
  // P20.3: a share-target launch arrives on "/" with ?share-text/share-url
  // (manifest share_target). Parsed once, consumed as a composer draft —
  // never auto-sent. `getInitialNavigation` keeps its original shape.
  const [initialShare] = useState(() => parseShareTarget(searchParams));
  const { t, locale } = useI18n();
  const isMobile = useIsMobile();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  // When user clicks +, we only store the cwd — no fake session id
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [workspaceOptions, setWorkspaceOptions] = useState<{ projects: ManagedProject[]; selectedProject: string | null; cwd: string | null }>({ projects: [], selectedProject: null, cwd: null });
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const handleWorkspaceOptionsChange = useCallback((projects: ManagedProject[], selectedProject: string | null, cwd: string | null) => {
    setWorkspaceOptions({ projects, selectedProject, cwd });
  }, []);
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [explorerRefreshing, setExplorerRefreshing] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [runsBoardOpen, setRunsBoardOpen] = useState(false);
  // Live running-session ids, fed by SessionSidebar's existing
  // /api/agent/running/events subscription (no second EventSource).
  const [runningIds, setRunningIds] = useState<string[]>([]);
  const [archiveBrowserOpen, setArchiveBrowserOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(SIDEBAR_DEFAULT_WIDTH);
  const [toolCallsDefaultCollapsed, setToolCallsDefaultCollapsed] = useState(true);
  const [providerUsageVisible, setProviderUsageVisible] = useState(true);
  const [scopeNativeSelectAll, setScopeNativeSelectAll] = useState(false);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  // Active drag handlers so an unmount mid-drag can detach them.
  const sidebarResizeHandlersRef = useRef<{ onMove: (ev: MouseEvent) => void; onUp: () => void } | null>(null);
  // DOM element + live width during a drag (see handleSidebarResizeStart).
  const sidebarContainerRef = useRef<HTMLDivElement>(null);
  const pendingSidebarWidthRef = useRef<number>(SIDEBAR_DEFAULT_WIDTH);
  useEffect(() => {
    setSidebarWidth(loadSidebarWidth());
    try {
      setToolCallsDefaultCollapsed(window.localStorage.getItem(TOOL_CALLS_COLLAPSED_STORAGE_KEY) !== "false");
      setProviderUsageVisible(window.localStorage.getItem(PROVIDER_USAGE_VISIBLE_STORAGE_KEY) !== "false");
      setScopeNativeSelectAll(window.localStorage.getItem(NATIVE_SELECT_ALL_STORAGE_KEY) === "true");
    } catch {
      // Keep the compact default when storage is unavailable.
    }
  }, []);
  // Wave 2 P1 client-state sync: bookmarks / prompt history / workspace
  // last-open / composer prefs across devices (Settings → general toggle).
  // Idempotent init; the dispose keeps Strict Mode's double-mount clean.
  useEffect(() => initClientStateSync(), []);
  const handleToolCallsDefaultCollapsedChange = useCallback((collapsed: boolean) => {
    setToolCallsDefaultCollapsed(collapsed);
    try {
      window.localStorage.setItem(TOOL_CALLS_COLLAPSED_STORAGE_KEY, String(collapsed));
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handleProviderUsageVisibleChange = useCallback((visible: boolean) => {
    setProviderUsageVisible(visible);
    try {
      window.localStorage.setItem(PROVIDER_USAGE_VISIBLE_STORAGE_KEY, String(visible));
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  const handleScopeNativeSelectAllChange = useCallback((enabled: boolean) => {
    setScopeNativeSelectAll(enabled);
    try {
      window.localStorage.setItem(NATIVE_SELECT_ALL_STORAGE_KEY, String(enabled));
    } catch {
      // The preference still applies for this page load.
    }
  }, []);
  // Persist the committed width (after each change; skipped mid-drag, then
  // written once the drag ends). The first run is skipped so the mount-time
  // default cannot overwrite the stored width before it is loaded.
  const sidebarWidthMountedRef = useRef(false);
  useEffect(() => {
    if (!sidebarWidthMountedRef.current) {
      sidebarWidthMountedRef.current = true;
      return;
    }
    if (sidebarResizing) return;
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch {
      // ignore storage quota / privacy-mode errors
    }
  }, [sidebarWidth, sidebarResizing]);
  const [appUpdate, setAppUpdate] = useState<AppUpdateInfo | null>(null);
  const [appUpdateDialogOpen, setAppUpdateDialogOpen] = useState(false);
  const [appUpdatePhase, setAppUpdatePhase] = useState<AppUpdatePhase>("idle");
  const [appUpdateError, setAppUpdateError] = useState<string | null>(null);
  const appUpdateAttemptRef = useRef<string | null>(null);
  const appUpdateStartInFlightRef = useRef(false);
  const appUpdateCompletingRef = useRef(false);
  const [appUpdateVisibleStage, setAppUpdateVisibleStage] = useState<AppUpdateStage | undefined>();
  const appUpdateVisibleStageRef = useRef<AppUpdateStage | undefined>(undefined);
  const appUpdateVisibleStageStartedAtRef = useRef<number | null>(null);
  const appUpdateCommittedAttemptRef = useRef<string | null>(null);
  const appUpdateRecoveryCommitAttemptRef = useRef<string | null>(null);
  const appUpdateStageFlowRef = useRef(0);
  const appUpdateAcknowledgementsRef = useRef<Map<string, Promise<boolean>>>(new Map());
  const advanceAppUpdateVisibleStage = useCallback((next: AppUpdateStage) => {
    const visible = getMonotonicAppUpdateStage(appUpdateVisibleStageRef.current, next);
    if (visible === appUpdateVisibleStageRef.current) return;
    appUpdateVisibleStageRef.current = visible;
    appUpdateVisibleStageStartedAtRef.current = Date.now();
    setAppUpdateVisibleStage(visible);
  }, []);
  const resetAppUpdateVisibleStage = useCallback(() => {
    appUpdateVisibleStageRef.current = undefined;
    appUpdateStageFlowRef.current += 1;
    appUpdateVisibleStageStartedAtRef.current = null;
    appUpdateCommittedAttemptRef.current = null;
    appUpdateRecoveryCommitAttemptRef.current = null;
    setAppUpdateVisibleStage(undefined);
    setAppUpdate((current) => current?.appUpdateDrain
      ? { ...current, appUpdateDrain: undefined }
      : current);
  }, []);
  const showAppUpdateStagesThrough = useCallback(async (target: AppUpdateStage) => {
    const stageFlow = appUpdateStageFlowRef.current;
    const targetIndex = getAppUpdateStageIndex(target);
    if (appUpdateVisibleStageRef.current === undefined) {
      advanceAppUpdateVisibleStage(target);
      return;
    }
    while (true) {
      const current = appUpdateVisibleStageRef.current;
      if (current === undefined || getAppUpdateStageIndex(current) >= targetIndex) return;
      await waitForAppUpdateDwell(
        appUpdateVisibleStageStartedAtRef.current,
        current === "preparing" ? APP_UPDATE_PREPARING_MIN_MS : APP_UPDATE_VISIBLE_STAGE_MIN_MS,
      );
      if (appUpdateStageFlowRef.current !== stageFlow) return;
      const latest = appUpdateVisibleStageRef.current;
      if (latest === undefined || getAppUpdateStageIndex(latest) >= targetIndex) return;
      const next = getNextAppUpdateStage(latest);
      if (next === undefined) return;
      advanceAppUpdateVisibleStage(next);
    }
  }, [advanceAppUpdateVisibleStage]);
  const [ompUpdateAvailable, setOmpUpdateAvailable] = useState(false);
  // Bumped on visibilitychange so the mount-time update checks re-run.
  const [updateCheckKey, setUpdateCheckKey] = useState(0);
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  // 6a PWA: register the service worker in production builds only. Dev must
  // never cache: the SW's cache-first /_next/static rule would pin in-place
  // dev chunks and corrupt HMR after every restart. When a waiting worker
  // finishes installing (a new deploy was fetched), offer the reload.
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    let cancelled = false;
    const swUrl = "/sw.js";
    navigator.serviceWorker.register(swUrl).then((registration) => {
      if (cancelled) return;
      const announce = (worker: ServiceWorker | null) => {
        if (!worker || worker.state === "activating" || worker.state === "activated") return;
        toast.info(
          translate("pwa.updateAvailable"),
          <button
            type="button"
            onClick={() => {
              toast.close("pwa-update-available");
              worker.addEventListener("statechange", () => {
                if (worker.state === "activated") window.location.reload();
              });
              worker.postMessage("SKIP_WAITING");
            }}
            style={{ marginTop: 6, padding: "4px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}
          >
            {translate("pwa.reload")}
          </button>,
          { id: "pwa-update-available", timeout: 0 },
        );
      };
      if (registration.waiting) announce(registration.waiting);
      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        installing?.addEventListener("statechange", () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) announce(installing);
        });
      });
    }).catch(() => {
      // SW registration failures (http:// LAN origins, disabled storage) are
      // non-fatal: the app keeps working as a normal web page.
    });
    return () => { cancelled = true; };
  }, []);
  // Chrome does not blur a focused descendant when a subtree becomes
  // aria-hidden + inert (e.g. tapping a session button closes the mobile
  // drawer), which leaves focus trapped where assistive tech cannot see it.
  // Blur synchronously in the same commit so the AX tree never observes a
  // focused element inside the hidden sidebar.
  useLayoutEffect(() => {
    if (sidebarOpen || !mobileSidebarReady) return;
    const container = sidebarContainerRef.current;
    const active = document.activeElement;
    if (container && active instanceof HTMLElement && container.contains(active)) {
      active.blur();
    }
  }, [sidebarOpen, mobileSidebarReady]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/omp-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "check" }),
      signal: controller.signal,
    })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { currentVersion?: string | null; availableVersion?: string | null; updateAvailable?: boolean; updateCommand?: string } | null) => {
        setOmpUpdateAvailable(Boolean(data?.updateAvailable));
        if (!data?.updateAvailable || !data.availableVersion) return;
        // This check re-runs on every visibilitychange back to the tab, so a
        // version the user already dismissed must not be re-announced.
        if (readDismissedVersion(DISMISSED_OMP_UPDATE_KEY) === data.availableVersion) return;
        const version = data.availableVersion;
        const cmd = data.updateCommand || "omp update";
        toast.info(
          translate("appShell.ompUpdateAvailable"),
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
            <div>{translate("appShell.updateVersion", { current: data.currentVersion ?? "?", available: data.availableVersion })}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <code style={{ background: "var(--bg-panel)", padding: "3px 7px", borderRadius: "var(--radius-control)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                {cmd}
              </code>
              <button
                type="button"
                onClick={() => {
                  void copyText(cmd)
                    .then(() => toast.success(translate("appShell.commandCopied")))
                    .catch(() => toast.error(translate("appShell.commandCopyFailed")));
                }}
                style={{ padding: "3px 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11 }}
              >
                {translate("appShell.copyCommand")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSettingsTab("system");
                  toast.close("omp-update-available");
                }}
                style={{ padding: "3px 7px", border: "1px solid var(--accent-strong)", borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}
              >
                {translate("settingsConfig.ompUpdateAction")}
              </button>
            </div>
          </div>,
          { id: "omp-update-available", timeout: 0, onClose: () => rememberDismissedVersion(DISMISSED_OMP_UPDATE_KEY, version) }
        );
      })
      .catch(() => {});
    return () => controller.abort();
  }, [updateCheckKey]);
  useEffect(() => {
    const recheck = () => {
      if (document.visibilityState !== "visible") return;
      // A transient failure on mount reads as "no update" forever otherwise;
      // re-running the checks below on re-focus gives them another chance.
      setUpdateCheckKey((key) => key + 1);
    };
    document.addEventListener("visibilitychange", recheck);
    return () => document.removeEventListener("visibilitychange", recheck);
  }, []);
  const refreshAppUpdate = useCallback(async (force = false, autoOpen = false): Promise<AppUpdateInfo | null> => {
    const data = await fetchAppUpdateJson<AppUpdateInfo>(
      force ? "/api/app-update?force=1" : "/api/app-update",
      { cache: "no-store" },
    );
    if (
      autoOpen
      && (appUpdateStartInFlightRef.current || appUpdateAttemptRef.current !== null || appUpdateCompletingRef.current)
    ) return null;

    setAppUpdate(data);

    if (autoOpen && !data.selfUpdateStatus && data.updateAvailable && data.availableVersion) {
      if (data.selfUpdateSupported === true) {
        if (readDismissedVersion(DISMISSED_APP_UPDATE_KEY) !== data.availableVersion) {
          setAppUpdatePhase("idle");
          setAppUpdateError(null);
          setAppUpdateDialogOpen(true);
        }
      } else {
        const cmd = data.updateCommand || "npm install -g @kahme247/ompweb";
        const version = data.availableVersion;
        if (readDismissedVersion(DISMISSED_APP_UPDATE_KEY) === version) return data;
        toast.info(
          translate("appShell.appUpdateAvailable"),
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
            <div>{translate("appShell.updateVersion", { current: data.currentVersion ?? "?", available: data.availableVersion })}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <code style={{ background: "var(--bg-panel)", padding: "3px 7px", borderRadius: "var(--radius-control)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                {cmd}
              </code>
              <button
                type="button"
                onClick={() => {
                  void copyText(cmd)
                    .then(() => toast.success(translate("appShell.commandCopied")))
                    .catch(() => toast.error(translate("appShell.commandCopyFailed")));
                }}
                style={{ padding: "3px 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 11 }}
              >
                {translate("appShell.copyCommand")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSettingsTab("system");
                  toast.close("app-update-available");
                }}
                style={{ padding: "3px 7px", border: "1px solid var(--accent-strong)", borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}
              >
                {translate("settingsConfig.appUpdateAction")}
              </button>
            </div>
          </div>,
          { id: "app-update-available", timeout: 0, onClose: () => rememberDismissedVersion(DISMISSED_APP_UPDATE_KEY, version) }
        );
      }
    }
    return data;
  }, []);

  const acknowledgeAppUpdate = useCallback((attemptId: string): Promise<boolean> => {
    const existing = appUpdateAcknowledgementsRef.current.get(attemptId);
    if (existing) return existing;
    const request = (async () => {
      try {
        const response = await fetch("/api/app-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "acknowledge", attemptId }),
        });
        return response.ok;
      } catch {
        return false;
      }
    })();
    appUpdateAcknowledgementsRef.current.set(attemptId, request);
    void request.then((acknowledged) => {
      if (!acknowledged && appUpdateAcknowledgementsRef.current.get(attemptId) === request) {
        appUpdateAcknowledgementsRef.current.delete(attemptId);
      }
    });
    return request;
  }, []);

  const showAppUpdateFailure = useCallback((error: unknown) => {
    appUpdateAttemptRef.current = null;
    appUpdateStartInFlightRef.current = false;
    appUpdateCommittedAttemptRef.current = null;
    setAppUpdateError(sanitizeAppUpdateError(error) || null);
    setAppUpdatePhase("failed");
    appUpdateStageFlowRef.current += 1;
    setAppUpdateDialogOpen(true);
  }, []);

  const submitAppUpdateCommit = useCallback((attemptId: string) => {
    void fetchAppUpdateJson<{ error?: string }>("/api/app-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "commit", attemptId }),
      keepalive: true,
    }, 202).then(() => {
      if (appUpdateAttemptRef.current === attemptId) {
        appUpdateCommittedAttemptRef.current = attemptId;
      }
    }).catch((error) => {
      if (error instanceof AppUpdateTransportError) {
        if (appUpdateRecoveryCommitAttemptRef.current === attemptId) {
          appUpdateRecoveryCommitAttemptRef.current = null;
        }
        return;
      }
      if (appUpdateAttemptRef.current !== attemptId) return;
      showAppUpdateFailure(error);
    });
  }, [showAppUpdateFailure]);

  const recoverPreparedAppUpdate = useCallback((data: AppUpdateInfo, attemptId: string) => {
    const status = data.selfUpdateStatus;
    if (
      status?.attemptId !== attemptId
      || status.state !== "prepared"
      || (status.stage !== "preparing" && status.stage !== "stopping")
    ) return;
    if (appUpdateRecoveryCommitAttemptRef.current === attemptId) return;
    appUpdateRecoveryCommitAttemptRef.current = attemptId;
    submitAppUpdateCommit(attemptId);
  }, [submitAppUpdateCommit]);

  const completeAppUpdate = useCallback(async (targetVersion: string) => {
    if (appUpdateCompletingRef.current) return;
    appUpdateCompletingRef.current = true;
    appUpdateAttemptRef.current = null;
    appUpdateCommittedAttemptRef.current = null;
    appUpdateStartInFlightRef.current = false;
    await showAppUpdateStagesThrough("finalizing");
    await waitForAppUpdateDwell(appUpdateVisibleStageStartedAtRef.current, APP_UPDATE_VISIBLE_STAGE_MIN_MS);
    setAppUpdateError(null);
    setAppUpdatePhase("completed");
    setAppUpdateDialogOpen(true);
    try {
      window.sessionStorage.setItem(COMPLETED_APP_UPDATE_KEY, JSON.stringify({ version: targetVersion }));
    } catch {}
    await new Promise<void>((resolve) => window.setTimeout(resolve, APP_UPDATE_COMPLETED_RELOAD_MS));
    appUpdateRecoveryCommitAttemptRef.current = null;
    window.location.reload();
  }, [showAppUpdateStagesThrough]);

  const handleTerminalAppUpdate = useCallback(async (
    data: AppUpdateInfo,
    attemptId: string,
    targetVersion: string,
  ): Promise<boolean> => {
    const status = data.selfUpdateStatus;
    if (status?.attemptId !== attemptId || status.cleanupReady !== true) return false;
    if (status.state === "failed") {
      if (!await acknowledgeAppUpdate(attemptId)) return false;
      showAppUpdateFailure(status.error);
      return true;
    }
    if (status.state === "succeeded" && data.currentVersion === targetVersion) {
      if (!await acknowledgeAppUpdate(attemptId)) return false;
      await completeAppUpdate(targetVersion);
      return true;
    }
    return false;
  }, [acknowledgeAppUpdate, completeAppUpdate, showAppUpdateFailure]);

  const monitorAppUpdate = useCallback(async (attemptId: string, targetVersion: string) => {
    if (appUpdateAttemptRef.current === attemptId) return;
    appUpdateAttemptRef.current = attemptId;
    const deadline = Date.now() + APP_UPDATE_TIMEOUT_MS;
    while (appUpdateAttemptRef.current === attemptId && Date.now() < deadline) {
      await new Promise<void>((resolve) => window.setTimeout(
        resolve,
        appUpdateVisibleStageRef.current === "stopping" ? APP_UPDATE_STOPPING_POLL_MS : APP_UPDATE_POLL_MS,
      ));
      try {
        const data = await refreshAppUpdate();
        if (!data) continue;
        const status = data.selfUpdateStatus;
        if (status?.attemptId === attemptId && status.stage !== undefined) {
          if (status.stage !== "preparing") appUpdateCommittedAttemptRef.current = attemptId;
          await showAppUpdateStagesThrough(status.stage);
        }
        recoverPreparedAppUpdate(data, attemptId);
        if (await handleTerminalAppUpdate(data, attemptId, targetVersion)) return;
        if (isExactLegacyTargetCompletion(data, targetVersion)) {
          // Legacy targets do not expose the status/acknowledge contract. Exact
          // version equality is the completion proof; updater artifacts expire
          // through the backend's terminal-status TTL instead of UI cleanup.
          await completeAppUpdate(targetVersion);
          return;
        }
      } catch (error) {
        if (error instanceof AppUpdateTransportError) {
          if (appUpdateCommittedAttemptRef.current === attemptId) {
            advanceAppUpdateVisibleStage("installing");
          }
          // Connection failures are expected after commit while the server is offline.
          continue;
        }
        showAppUpdateFailure(error);
        return;
      }
    }
    if (appUpdateAttemptRef.current === attemptId) {
      showAppUpdateFailure(t("appUpdateDialog.timeout"));
    }
  }, [advanceAppUpdateVisibleStage, completeAppUpdate, handleTerminalAppUpdate, recoverPreparedAppUpdate, refreshAppUpdate, showAppUpdateFailure, showAppUpdateStagesThrough, t]);

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(COMPLETED_APP_UPDATE_KEY);
      if (raw) {
        const completed = JSON.parse(raw) as { version?: unknown };
        window.sessionStorage.removeItem(COMPLETED_APP_UPDATE_KEY);
        if (typeof completed.version === "string") {
          toast.success(t("appUpdateDialog.completed", { version: completed.version }));
        }
      }
    } catch {}
    void refreshAppUpdate(false, true)
      .then(async (data) => {
        const status = data?.selfUpdateStatus;
        if (!data || !status) return;
        const recoveredStage = status.stage ?? "stopping";
        const initialStage = recoveredStage === "preparing" ? "preparing" : "stopping";
        if (initialStage === "stopping") appUpdateCommittedAttemptRef.current = status.attemptId;
        advanceAppUpdateVisibleStage(initialStage);
        setAppUpdatePhase(initialStage === "preparing" ? "preparing" : "restarting");
        setAppUpdateDialogOpen(true);
        await showAppUpdateStagesThrough(recoveredStage);
        if (await handleTerminalAppUpdate(data, status.attemptId, status.targetVersion)) return;
        void monitorAppUpdate(status.attemptId, status.targetVersion);
        recoverPreparedAppUpdate(data, status.attemptId);
      })
      .catch(() => {});
  }, [advanceAppUpdateVisibleStage, handleTerminalAppUpdate, monitorAppUpdate, recoverPreparedAppUpdate, refreshAppUpdate, showAppUpdateStagesThrough, t]);

  const proceedWithAppUpdate = useCallback(async () => {
    if (appUpdateStartInFlightRef.current) return;
    appUpdateStartInFlightRef.current = true;
    appUpdateCompletingRef.current = false;
    resetAppUpdateVisibleStage();
    advanceAppUpdateVisibleStage("preparing");
    setAppUpdatePhase("preparing");
    setAppUpdateError(null);
    try {
      const prepared = await fetchAppUpdateJson<{ attemptId?: string; targetVersion?: string }>("/api/app-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "prepare" }),
      });
      if (!prepared.attemptId || !prepared.targetVersion) {
        throw new Error("Invalid update response");
      }
      submitAppUpdateCommit(prepared.attemptId);
      void monitorAppUpdate(prepared.attemptId, prepared.targetVersion);
      await showAppUpdateStagesThrough("stopping");
      if (appUpdateAttemptRef.current !== prepared.attemptId) return;
      setAppUpdatePhase("restarting");
    } catch (error) {
      showAppUpdateFailure(error);
    }
  }, [advanceAppUpdateVisibleStage, monitorAppUpdate, resetAppUpdateVisibleStage, showAppUpdateFailure, showAppUpdateStagesThrough, submitAppUpdateCommit]);

  const dismissAppUpdate = useCallback(() => {
    if (appUpdatePhase === "idle" && appUpdate?.availableVersion) {
      rememberDismissedVersion(DISMISSED_APP_UPDATE_KEY, appUpdate.availableVersion);
      toast.info(t("appUpdateDialog.settingsLater"));
    }
    setAppUpdateDialogOpen(false);
    setAppUpdatePhase("idle");
    setAppUpdateError(null);
    appUpdateAttemptRef.current = null;
    resetAppUpdateVisibleStage();
  }, [appUpdate?.availableVersion, appUpdatePhase, resetAppUpdateVisibleStage, t]);

  const requestAppUpdateFromSettings = useCallback(() => {
    setSettingsTab(null);
    resetAppUpdateVisibleStage();
    setAppUpdateError(null);
    setAppUpdatePhase("idle");
    window.requestAnimationFrame(() => setAppUpdateDialogOpen(true));
  }, [resetAppUpdateVisibleStage]);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeFnRef.current = onLeafChange;
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  // ── P12 split view: &split=<sessionId>[&splitLeaf=<leafId>] ─────────────
  // Desktop-only (SplitPane falls back to single view on mobile anyway) and
  // flag-gated by `split`. The params mirror the main `session`/`anchor`
  // conventions so a split URL is shareable and restores on reload.
  const [splitSessionId, setSplitSessionId] = useState<string | null>(() => searchParams.get("split")?.trim() || null);
  const [splitLeafId, setSplitLeafId] = useState<string | null>(() => searchParams.get("splitLeaf")?.trim() || null);
  const [activePane, setActivePane] = useState<SplitPaneSide>("left");
  const splitEnabled = isEnabled("split") && !isMobile;

  /** Rewrite the split params in place, preserving everything else
   *  (session/anchor/cwd — same pattern as stripAnchorParams). */
  const syncSplitParams = useCallback((split: string | null, leaf: string | null) => {
    const params = new URLSearchParams(window.location.search);
    if (split) params.set("split", split);
    else params.delete("split");
    if (split && leaf) params.set("splitLeaf", leaf);
    else params.delete("splitLeaf");
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "/", { scroll: false });
  }, [router]);

  const openSplit = useCallback((sessionId: string, leafId?: string | null) => {
    if (!splitEnabled) return;
    setSplitSessionId(sessionId);
    setSplitLeafId(leafId ?? null);
    setActivePane("right");
    syncSplitParams(sessionId, leafId ?? null);
  }, [splitEnabled, syncSplitParams]);

  const closeSplit = useCallback(() => {
    setSplitSessionId(null);
    setSplitLeafId(null);
    setActivePane("left");
    syncSplitParams(null, null);
  }, [syncSplitParams]);

  const { session: splitSession, anchor: splitAnchor } = useSplitSession({
    sessionId: splitEnabled ? splitSessionId : null,
    leafId: splitEnabled ? splitLeafId : null,
    onClose: closeSplit,
  });
  const splitActive = splitEnabled && splitSessionId !== null;
  const splitTitle = splitSession?.name || splitSession?.firstMessage || t("appShell.newSession");

  /** Chat header button: toggle the split against the open session. */
  const handleToggleSplit = useCallback(() => {
    if (splitActive) {
      closeSplit();
      return;
    }
    if (!selectedSession) return;
    openSplit(selectedSession.id);
  }, [closeSplit, openSplit, selectedSession, splitActive]);

  /** Sidebar session row "Split right": open that session in the right pane. */
  const handleSplitSession = useCallback((session: SessionInfo) => {
    openSplit(session.id);
  }, [openSplit]);

  /** Branch navigator "compare": split this session on the picked leaf. */
  const handleCompareLeaf = useCallback((leafId: string) => {
    if (!selectedSession) return;
    openSplit(selectedSession.id, leafId);
  }, [openSplit, selectedSession]);


  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [systemPromptLoading, setSystemPromptLoading] = useState(false);
  const systemPromptLoaderRef = useRef<(() => Promise<void>) | null>(null);
  const systemPromptLoadIdRef = useRef(0);
  const systemBtnRef = useRef<HTMLButtonElement>(null);
  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
    setSystemPromptLoading(false);
  }, []);

  const handleSystemPromptLoaderChange = useCallback((loader: (() => Promise<void>) | null) => {
    systemPromptLoadIdRef.current += 1;
    systemPromptLoaderRef.current = loader;
    setSystemPromptLoading(false);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: "idle" });
  const autoNameTimerRef = useRef<TimerHandle | undefined>(undefined);
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  const archiveRetryTimerRef = useRef<TimerHandle | undefined>(undefined);
  useEffect(() => () => clearTimeout(archiveRetryTimerRef.current), []);
  useLayoutEffect(() => {
    activeSessionIdRef.current = selectedSession?.id ?? null;
  }, [selectedSession?.id]);
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);

  useEffect(() => {
    return () => {
      clearTimeout(autoNameTimerRef.current);
    };
  }, []);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | "system" | null>(null);
  const mobileToolsRef = useRef<HTMLDetailsElement>(null);
  const mobileToolsContentRef = useRef<HTMLDivElement>(null);
  const restoreToolsFocusRef = useRef(false);
  const [compactTopbar, setCompactTopbar] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    if (compactTopbar && restoreToolsFocusRef.current) {
      mobileToolsRef.current?.querySelector("summary")?.focus();
      restoreToolsFocusRef.current = false;
    }
  }, [compactTopbar]);
  useEffect(() => {
    if (!compactTopbar) return;
    const closeOnOutside = (event: PointerEvent) => {
      const tools = mobileToolsRef.current;
      if (tools?.open && !tools.contains(event.target as Node)) {
        tools.open = false;
        setActiveTopPanel(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      const tools = mobileToolsRef.current;
      // Nested pickers and session panels handle their own Escape first.
      if (event.key !== "Escape" || event.defaultPrevented || activeTopPanel || !tools?.open) return;
      event.stopPropagation();
      tools.open = false;
      tools.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [compactTopbar, activeTopPanel]);
  const toggleTopPanel = useCallback((panel: "branches" | "system") => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel((cur) => cur === panel ? null : panel);
  }, [isMobile]);

  // Generation speed — current live t/s and the session average.
  const [generationSpeed, setGenerationSpeed] = useState<GenerationSpeedInfo | null>(null);
  const handleGenerationSpeedChange = useCallback((speed: GenerationSpeedInfo | null) => {
    setGenerationSpeed(speed);
  }, []);
  const handleSystemPromptToggle = useCallback(() => {
    const opening = activeTopPanel !== "system";
    toggleTopPanel("system");
    if (!opening || systemPromptLoading || systemPrompt !== null) return;

    const load = systemPromptLoaderRef.current;
    if (!load) return;
    const loadId = ++systemPromptLoadIdRef.current;
    setSystemPromptLoading(true);
    void load().catch((error) => {
      console.error("Failed to load system prompt:", error);
    }).finally(() => {
      if (systemPromptLoadIdRef.current === loadId) setSystemPromptLoading(false);
    });
  }, [activeTopPanel, systemPrompt, systemPromptLoading, toggleTopPanel]);

  // The topbar session panel is gone (its content lives in the composer ring
  // popover), so /session opens that instead.
  const openSessionStatsPanel = useCallback(() => {
    chatInputRef.current?.openContextPanel();
  }, []);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) setActiveTopPanel(null);
    setSidebarOpen((open) => !open);
  }, [isMobile]);

  const resetSidebarWidth = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  }, []);

  const changeSidebarWidth = useCallback((delta: number) => {
    setSidebarWidth((prev) => clampSidebarWidth(prev + delta));
  }, []);

  const handleSidebarResizeKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      changeSidebarWidth(-10);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      changeSidebarWidth(10);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      resetSidebarWidth();
    }
  }, [changeSidebarWidth, resetSidebarWidth]);

  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    if (isMobile) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    // Interface Scale (html[data-ui-scale] zoom) leaves clientX in viewport
    // pixels while the sidebar width is zoomed layout pixels: scale the drag
    // delta so the edge tracks the pointer at any zoom (same --ui-scale
    // ground truth as the zoom-aware menus in SessionSidebar-chrome).
    let uiScale = 1;
    try {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--ui-scale");
      const value = parseFloat(raw);
      if (Number.isFinite(value) && value > 0) uiScale = value;
    } catch {
      // SSR/unavailable: fall back to unscaled math.
    }
    setSidebarResizing(true);
    const onMove = (ev: MouseEvent) => {
      const next = clampSidebarWidth(startWidth + (ev.clientX - startX) / uiScale);
      // Write the CSS variable straight to the DOM: the flex row follows the
      // pointer without re-rendering the whole AppShell on every mousemove.
      sidebarContainerRef.current?.style.setProperty("--sidebar-width", `${next}px`);
      pendingSidebarWidthRef.current = next;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      sidebarResizeHandlersRef.current = null;
      setSidebarResizing(false);
      // Commit the final width so state and the persisted value agree with
      // what the user actually dragged to.
      setSidebarWidth(pendingSidebarWidthRef.current);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    pendingSidebarWidthRef.current = startWidth;
    sidebarResizeHandlersRef.current = { onMove, onUp };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [isMobile, sidebarWidth]);

  // If the app unmounts mid-drag, remove the window listeners and restore the
  // body cursor; otherwise the handlers leak and body stays cursor:col-resize.
  useEffect(() => () => {
    const handlers = sidebarResizeHandlersRef.current;
    if (!handlers) return;
    window.removeEventListener("mousemove", handlers.onMove);
    window.removeEventListener("mouseup", handlers.onUp);
    sidebarResizeHandlersRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  const resetRightPanelWidth = useCallback(() => {
    rightPanelRef.current?.style.removeProperty("--right-panel-width");
    setRightPanelWidth(null);
  }, []);

  const changeRightPanelWidth = useCallback((delta: number) => {
    setRightPanelWidth((prev) => {
      // Keyboard steps from the fluid default start at the panel's live
      // width so the first press doesn't jump to the clamp minimum.
      const base = prev ?? rightPanelRef.current?.getBoundingClientRect().width ?? RIGHT_PANEL_MIN_WIDTH;
      const next = clampRightPanelWidth(base + delta);
      rightPanelRef.current?.style.setProperty("--right-panel-width", `${next}px`);
      return next;
    });
  }, []);

  const handleRightPanelResizeKey = useCallback((e: React.KeyboardEvent) => {
    // The handle sits on the panel's left edge: left widens, right narrows.
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      changeRightPanelWidth(10);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      changeRightPanelWidth(-10);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      resetRightPanelWidth();
    }
  }, [changeRightPanelWidth, resetRightPanelWidth]);

  const handleRightPanelResizeStart = useCallback((e: React.MouseEvent) => {
    if (isMobile) return;
    e.preventDefault();
    const startX = e.clientX;
    // Live rect, not state: it always reflects the committed width (custom or
    // fluid default), and keeps this callback above the state declarations
    // without a TDZ cycle. The handle only exists while the panel is open.
    const startWidth = rightPanelRef.current?.getBoundingClientRect().width
      ?? RIGHT_PANEL_MIN_WIDTH;
    // Same --ui-scale ground truth as the left sidebar handle: clientX is in
    // viewport pixels while the panel width is zoomed layout pixels.
    let uiScale = 1;
    try {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--ui-scale");
      const value = parseFloat(raw);
      if (Number.isFinite(value) && value > 0) uiScale = value;
    } catch {
      // SSR/unavailable: fall back to unscaled math.
    }
    setRightPanelResizing(true);
    const onMove = (ev: MouseEvent) => {
      // Dragging the left edge left grows the panel: inverse of the sidebar.
      const next = clampRightPanelWidth(startWidth - (ev.clientX - startX) / uiScale);
      // Write the CSS variable straight to the DOM: the flex row follows the
      // pointer without re-rendering the whole AppShell on every mousemove.
      rightPanelRef.current?.style.setProperty("--right-panel-width", `${next}px`);
      pendingRightPanelWidthRef.current = next;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      rightResizeHandlersRef.current = null;
      setRightPanelResizing(false);
      // Commit the final width so state and the persisted value agree with
      // what the user actually dragged to.
      setRightPanelWidth(pendingRightPanelWidthRef.current);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    pendingRightPanelWidthRef.current = startWidth;
    rightResizeHandlersRef.current = { onMove, onUp };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [isMobile]);

  // If the app unmounts mid-drag, remove the window listeners and restore the
  // body cursor; otherwise the handlers leak and body stays cursor:col-resize.
  useEffect(() => () => {
    const handlers = rightResizeHandlersRef.current;
    if (!handlers) return;
    window.removeEventListener("mousemove", handlers.onMove);
    window.removeEventListener("mouseup", handlers.onUp);
    rightResizeHandlersRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);


  // Dismiss the topbar dropdowns on outside click or Escape. The Escape
  // handler stops propagation so the global Esc (abort agent) does not fire
  // while a panel is open.
  useEffect(() => {
    // The branch panel manages its own outside-click and Escape dismissal.
    if (!activeTopPanel || activeTopPanel === "branches") return;
    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-top-panel]")) return;
      setActiveTopPanel(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setActiveTopPanel(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [activeTopPanel]);

  // Right panel tabs: Explorer | Git changes | open files (Tauri parity).
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  // Tab ids whose FileViewer reports unsaved edits (Phase 10): drives the
  // TabBar dirty dot + close confirmation.
  const [dirtyFileTabIds, setDirtyFileTabIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  // Right panel tabs: Explorer | Git changes | Terminal | open files. The
  // state type is the shared RightPanelView so the P13 terminal view plugs in
  // without a parallel union.
  const [rightView, setRightView] = useState<RightPanelView>("explorer");
  // User-chosen pixel width (null = fluid 42% default), persisted.
  const [rightPanelWidth, setRightPanelWidth] = useState<number | null>(null);
  const [rightPanelResizing, setRightPanelResizing] = useState(false);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const pendingRightPanelWidthRef = useRef<number | null>(null);
  const rightResizeHandlersRef = useRef<{ onMove: (ev: MouseEvent) => void; onUp: () => void } | null>(null);
  useEffect(() => {
    setRightPanelWidth(loadRightPanelWidth());
  }, []);
  // One-shot request asking the explorer tab to expand + scroll to a file.
  const [revealPath, setRevealPath] = useState<string | null>(null);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [explorerGitCount, setExplorerGitCount] = useState(0);
  const [explorerIsRepo, setExplorerIsRepo] = useState(false);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);
  const handleExplorerGitStatus = useCallback((changedCount: number, isRepo: boolean) => {
    setExplorerGitCount(changedCount);
    setExplorerIsRepo(isRepo);
  }, []);
  // Same guard as the left sidebar: skip the mount run and mid-drag writes. A
  // reset (null) removes the key so the fluid default returns.
  const rightPanelWidthMountedRef = useRef(false);
  useEffect(() => {
    if (!rightPanelWidthMountedRef.current) {
      rightPanelWidthMountedRef.current = true;
      return;
    }
    if (rightPanelResizing) return;
    try {
      if (rightPanelWidth === null) window.localStorage.removeItem(RIGHT_PANEL_WIDTH_STORAGE_KEY);
      else window.localStorage.setItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, String(rightPanelWidth));
    } catch {
      // ignore storage quota / privacy-mode errors
    }
  }, [rightPanelWidth, rightPanelResizing]);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
  }, []);

  const handleAtMentions = useCallback((relativePaths: string[]) => {
    const mentions = buildFileAtMentionsText(relativePaths);
    if (mentions) chatInputRef.current?.insertText(mentions);
  }, []);

  const handleFileLineMention = useCallback((relativePath: string, startLine: number, endLine: number) => {
    chatInputRef.current?.insertText(buildFileLineMentionText(relativePath, startLine, endLine));
  }, []);

  const initialSessionId = initialNavigation.sessionId;
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  // P1 deep links: a pending anchor (palette search result or &anchor= URL
  // param) forwarded to ChatWindow → useAgentSession once the session opens.
  const anchorSeqRef = useRef(initialNavigation.anchor ? 1 : 0);
  const [pendingAnchor, setPendingAnchor] = useState<(InitialAnchor & { seq: number }) | null>(
    () => initialNavigation.anchor ? { ...initialNavigation.anchor, seq: anchorSeqRef.current } : null,
  );
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !initialSessionId);
  // During the initial URL restore the sidebar adopts the restored cwd and
  // notifies us; that first onCwdChange must not bump sessionKey. We store the
  // expected cwd string and only skip when it matches, so a failure to fire
  // can't leave the suppression armed for the user's next genuine switch.
  const suppressCwdRef = useRef<string | null>(null);

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string; code?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error || data.code ? formatApiError(data) : `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        suppressCwdRef.current = data.cwd;
        setInitialCwdStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
      });

    return () => controller.abort();
  }, [initialNavigation]);

  const handleCwdChange = useCallback((cwd: string | null, projectRoot?: string | null) => {
    setActiveCwd(cwd);
    // Skip if cwd is null (initial mount) or during the initial URL restore.
    if (!cwd) return;
    // Skip only when the notification matches the cwd we're suppressing for.
    if (suppressCwdRef.current !== null && suppressCwdRef.current === cwd) {
      suppressCwdRef.current = null;
      return;
    }
    // Worktrees of one repo share a project root. Moving the effective cwd
    // within the same project (e.g. switching worktree, or clicking a session
    // that lives in another worktree) must not close the open session.
    // Compare case-folded: the same folder can be spelled with different
    // casing (Windows/NTFS) between the session's projectRoot and the
    // sidebar's resolved project root.
    const newProject = projectRoot ?? cwd;
    const sessionProject = selectedSession ? (selectedSession.projectRoot ?? selectedSession.cwd) : null;
    if (sessionProject && comparableProjectPath(sessionProject) === comparableProjectPath(newProject)) {
      return;
    }
    // Close any session that belongs to a different project — it no longer
    // matches the selected project directory.
    setSelectedSession(null);
    setNewSessionCwd((prev) => {
      if (prev && prev !== cwd) return null;
      return prev;
    });
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setSystemPromptLoading(false);
    setActiveTopPanel(null);
    router.replace("/", { scroll: false });
  }, [router, selectedSession]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    // Re-picking the already-open session (sidebar double-click, palette
    // re-select, notification click) must not bump sessionKey: that remounts
    // ChatWindow, reconnects SSE, and drops the mid-run streaming view.
    setSettingsTab(null);
    // Re-picking the current conversation still closes/rearms the drawer,
    // without remounting the chat or disturbing its draft.
    if (isMobile && !isRestore) setSidebarOpen(false);
    if (!isRestore && session.id === selectedSession?.id) return;
    setNewSessionCwd(null);
    setSelectedSession(session);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setSystemPromptLoading(false);
    setInitialSessionRestored(true);
    if (isRestore) {
      // Suppress the redundant sessionKey bump that would come from the
      // onCwdChange effect firing after setSelectedCwd in the sidebar. We
      // arm the expected cwd (compared in handleCwdChange) rather than a
      // sticky flag so a missed notification can't suppress the next
      // genuine project switch.
      suppressCwdRef.current = session.cwd;
    }
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [router, isMobile, selectedSession?.id]);

  // ── P1 anchors: deep-link plumbing ──────────────────────────────────────

  /** Strip anchor/hl params once an anchor has been applied (or given up). */
  const stripAnchorParams = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("anchor") && !params.has("hl")) return;
    params.delete("anchor");
    params.delete("hl");
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "/", { scroll: false });
  }, [router]);

  const handleAnchorApplied = useCallback(() => {
    setPendingAnchor(null);
    stripAnchorParams();
  }, [stripAnchorParams]);

  /** Palette search result click: open the session, then anchor+highlight. */
  const handleOpenSearchResult = useCallback((result: SearchResultItem) => {
    anchorSeqRef.current += 1;
    setPendingAnchor({ entryId: result.entryId, seq: anchorSeqRef.current });
    // Reflect in the URL for shareability. hl is text-range data the palette
    // does not carry; the find bar supplies hl through the anchor API directly.
    router.replace(`?session=${encodeURIComponent(result.sessionId)}&anchor=${encodeURIComponent(result.entryId)}`, { scroll: false });
    void fetch("/api/sessions")
      .then((response) => response.ok ? response.json() as Promise<{ sessions?: SessionInfo[] }> : Promise.reject(new Error("request failed")))
      .then((data) => {
        const target = (data.sessions ?? []).find((candidate) => candidate.id === result.sessionId);
        if (target) handleSelectSession(target);
      })
      .catch(() => toast.error(translate("errors.generic")));
  }, [handleSelectSession, router]);

  // P2 notifications: open a feed row's session by id (same fetch-and-select
  // hand-off the palette search results use).
  const handleOpenSessionFromBell = useCallback((sessionId: string) => {
    void fetch("/api/sessions")
      .then((response) => (response.ok ? response.json() as Promise<{ sessions?: SessionInfo[] }> : Promise.reject(new Error("request failed"))))
      .then((data) => {
        const target = (data.sessions ?? []).find((candidate) => candidate.id === sessionId);
        if (target) handleSelectSession(target);
        else router.replace(`?session=${encodeURIComponent(sessionId)}`, { scroll: false });
      })
      .catch(() => router.replace(`?session=${encodeURIComponent(sessionId)}`, { scroll: false }));
  }, [handleSelectSession, router]);

  const handleOpenNotifySettings = useCallback(() => {
    setSettingsTab("notifications");
  }, []);

  const handleNewSession = useCallback((_sessionId: string, cwd: string) => {
    setSettingsTab(null);
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setSystemPromptLoading(false);
    setActiveTopPanel(null);
    if (isMobile) setSidebarOpen(false);
    router.replace("/", { scroll: false });
  }, [router, isMobile]);

  // Runs board (P3): toggled from the header button or Ctrl/Cmd+Shift+U.
  const handleToggleRunsBoard = useCallback(() => {
    setRunsBoardOpen((open) => !open);
    setSettingsTab(null);
  }, []);
  const handleOpenSessionFromBoard = useCallback((sessionId: string) => {
    setRunsBoardOpen(false);
    handleOpenSessionFromBell(sessionId);
  }, [handleOpenSessionFromBell]);
  const handleNewSessionFromBoard = useCallback((cwd: string) => {
    setRunsBoardOpen(false);
    handleNewSession(`board-${Date.now()}`, cwd);
  }, [handleNewSession]);
  const handleRunningIdsChange = useCallback((ids: string[]) => {
    setRunningIds(ids);
  }, []);

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N, Ctrl/Cmd+Shift+U etc.)
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd,
    scopeNativeSelectAll,
    onToggleRunsBoard: handleToggleRunsBoard,
    onToggleSplit: splitEnabled && selectedSession ? handleToggleSplit : undefined,
  });

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectRoot, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void fetch("/api/sessions")
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        setSelectedSession((prev) => (prev && prev.id === sessionId && !prev.projectRoot ? full : prev));
      })
      .catch(() => {});
  }, []);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback((session: SessionInfo) => {
    setNewSessionCwd(null);
    setSelectedSession(session);
    setRefreshKey((k) => k + 1);
    hydrateSelectedSession(session.id);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [router, hydrateSelectedSession]);

  // Phase 3 quick-launch: spawn a session from a project's launch profile and
  // adopt it as the active chat. Goes through POST /api/agent/new (the thin
  // adapter over lib/spawn-session — never raw RPC), with the profile mapped
  // onto the existing wire fields (message/provider/modelId/thinkingLevel/
  // toolNames) by launchCommandFields. An empty/absent profile prompt spawns
  // without a first message (ensure_session). The profile prompt is NOT a
  // snippet — it is sent verbatim, no placeholder expansion. Failures toast;
  // the promise still resolves so the sidebar chip's busy state clears.
  const handleLaunchProject = useCallback(async (project: ManagedProject) => {
    const config = project.launchConfig;
    if (!config) return;
    const fields = launchCommandFields(config);
    const label = project.alias ?? projectLabel(project.path);
    try {
      const response = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: project.path, ...fields }),
      });
      const payload = await response.json().catch(() => null) as { sessionId?: string; error?: string; code?: string } | null;
      if (!response.ok || !payload?.sessionId) throw new Error(formatApiError(payload));
      handleSessionCreated({
        id: payload.sessionId,
        path: "",
        cwd: project.path,
        name: undefined,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        messageCount: 0,
        firstMessage: fields.message ?? translate("agentSession.noMessages"),
      });
    } catch {
      toast.error(translate("launch.failed", { project: label }));
    }
  }, [handleSessionCreated]);

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
    if (document.visibilityState !== "hidden" || !("Notification" in window)) return;

    const targetSession = selectedSession;
    const notify = () => {
      showCompletionNotification(
        targetSession?.name ?? translate("appShell.sessionComplete"),
        translate("appShell.taskFinished"),
        () => {
          window.focus();
          if (targetSession) handleSelectSession(targetSession);
        },
      );
    };
    if (Notification.permission === "granted") notify();
    else if (Notification.permission === "default") {
      void Notification.requestPermission().then((permission) => { if (permission === "granted") notify(); });
    } else {
      // "denied": the OS blocks notifications, so surface the completion as an
      // in-app toast instead of leaving background completions silent.
      toast.info(targetSession?.name ?? translate("appShell.sessionComplete"), translate("appShell.taskFinished"));
    }
  }, [handleSelectSession, selectedSession]);

  const handleAutoName = useCallback(async () => {
    const sessionId = selectedSession?.id;
    if (!sessionId || autoNameStatus.kind === "naming") return;
    clearTimeout(autoNameTimerRef.current);
    setActiveTopPanel(null);
    setAutoNameStatus({ kind: "naming" });

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string; code?: string };
      if (!response.ok || !body.title) {
        throw new Error(body.error || body.code ? formatApiError(body) : `HTTP ${response.status}`);
      }

      const title = body.title.trim();
      if (activeSessionIdRef.current !== sessionId) return;
      setRefreshKey((key) => key + 1);
      setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
      setSessionStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
      setAutoNameStatus({ kind: "success" });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 1800);
    } catch (error) {
      if (activeSessionIdRef.current !== sessionId) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutoNameStatus({ kind: "error", message });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 5000);
    }
  }, [autoNameStatus.kind, selectedSession?.id]);

  useEffect(() => {
    clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [selectedSession?.id]);

  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshing(true);
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleExplorerRefreshDone = useCallback(() => {
    setExplorerRefreshing(false);
  }, []);

  const handleSessionForked = useCallback((newSessionId: string) => {
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
      // path === "" is the sidebar's optimistic-row marker; keep it so the
      // fork shows up immediately instead of waiting for a refresh.
      path: "",
    }));
    hydrateSelectedSession(newSessionId);
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [router, hydrateSelectedSession]);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    // The composer for this session can never be reopened, so its draft would
    // otherwise keep the exit guard armed for unreachable content.
    clearDraft(sessionId);
    setRefreshKey((k) => k + 1);
    // A deleted split target must not leave a dead pane behind.
    if (splitSessionId === sessionId) closeSplit();
    if (selectedSession?.id === sessionId) {
      const cwd = selectedSession.cwd;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    }
  }, [selectedSession, router, splitSessionId, closeSplit]);
  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleArchiveRestored = useCallback(async (sessionId: string) => {
    setArchiveBrowserOpen(false);
    publishSessionsChanged([sessionId]);
    setRefreshKey((k) => k + 1);

    // The poll must not yank the UI back to the restored session if the user
    // picks another one while we wait, and an untracked setTimeout chain would
    // keep retrying after unmount — so freeze the selection at start, bail out
    // of every attempt + the fallback when it changed, and track the timer.
    const sessionAtRestoreStart = activeSessionIdRef.current;
    const selectRestoredSession = async (attemptsLeft = 5): Promise<void> => {
      if (activeSessionIdRef.current !== sessionAtRestoreStart) return;
      try {
        const res = await fetch("/api/sessions");
        if (res.ok) {
          const data = (await res.json()) as { sessions?: SessionInfo[] };
          const found = data.sessions?.find((s) => s.id === sessionId);
          if (found) {
            if (activeSessionIdRef.current !== sessionAtRestoreStart) return;
            handleSelectSession(found, false);
            return;
          }
        }
      } catch {
        // network error / abort
      }

      if (attemptsLeft > 0) {
        archiveRetryTimerRef.current = setTimeout(() => void selectRestoredSession(attemptsLeft - 1), 300);
      } else if (activeSessionIdRef.current === sessionAtRestoreStart) {
        router.replace(`?session=${encodeURIComponent(sessionId)}`, { scroll: false });
      }
    };

    void selectRestoredSession();
  }, [handleSelectSession, router]);

  const handleCloseFileTab = useCallback((tabId: string) => {
    // Compute everything from the current list outside the updaters: no side
    // effect inside a state updater, and no stale-closure read (the callback
    // is recreated whenever fileTabs changes, but a batched double-close
    // would still have read the pre-close list from the closure).
    const next = fileTabs.filter((t) => t.id !== tabId);
    setFileTabs(next);
    setDirtyFileTabIds((prev) => {
      if (!prev.has(tabId)) return prev;
      const nextDirty = new Set(prev);
      nextDirty.delete(tabId);
      return nextDirty;
    });
    // The panel now hosts the Explorer tab, so it stays open: closing the
    // last file falls back to the explorer instead of hiding the panel.
    if (next.length === 0) setRightView("explorer");
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      return next.length > 0 ? next[next.length - 1].id : null;
    });
  }, [fileTabs]);

  const handleFileTabDirtyChange = useCallback((tabId: string, dirty: boolean) => {
    setDirtyFileTabIds((prev) => {
      if (prev.has(tabId) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(tabId);
      else next.delete(tabId);
      return next;
    });
  }, []);

  const handleOpenFile = useCallback((filePath: string, fileName: string, sourceSessionId?: string | null) => {
    const tabId = `file:${filePath}`;
    setFileTabs((prev) => {
      const existing = prev.find((t) => t.id === tabId);
      if (!existing) return [...prev, { id: tabId, label: fileName, filePath, sourceSessionId }];
      if (!sourceSessionId || existing.sourceSessionId === sourceSessionId) return prev;
      return prev.map((t) => t.id === tabId ? { ...t, sourceSessionId } : t);
    });
    setActiveFileTabId(tabId);
    setRightView("file");
    setRightPanelOpen(true);
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  const activeFileTab = fileTabs.find((tab) => tab.id === activeFileTabId) ?? null;
  // Explorer tab browses the active workspace: live cwd first, then the
  // selected / new-session cwd (mirrors what the sidebar used to pass down).
  const explorerCwd = activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? null;
  const handleOpenLinkedFile = useCallback((filePath: string) => {
    handleOpenFile(filePath, getFileName(filePath), selectedSession?.id ?? null);
  }, [handleOpenFile, selectedSession?.id]);

  // File-panel integrations: every action works on the active tab so the right
  // panel behaves like an editor toolbar, not just a tab strip.
  const handleMentionActiveFile = useCallback(() => {
    if (!activeFileTab) return;
    handleAtMention(getRelativeFilePath(activeFileTab.filePath, activeCwd ?? undefined), false);
  }, [activeFileTab, activeCwd, handleAtMention]);

  const handleCopyActiveFilePath = useCallback(() => {
    if (!activeFileTab) return;
    const relative = getRelativeFilePath(activeFileTab.filePath, activeCwd ?? undefined);
    copyText(relative).then(
      () => toast.success(t("appShell.copied")),
      () => toast.error(t("appShell.commandCopyFailed")),
    );
  }, [activeFileTab, activeCwd, t]);

  const handleDownloadActiveFile = useCallback(() => {
    if (!activeFileTab) return;
    const link = document.createElement("a");
    link.href = `/api/files/${encodeFilePathForApi(activeFileTab.filePath)}?type=download`;
    link.download = activeFileTab.label;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, [activeFileTab]);
  const handleRevealActiveFile = useCallback(() => {
    if (!activeFileTab) return;
    setRevealPath(activeFileTab.filePath);
    setRightView("explorer");
    setRightPanelOpen(true);
  }, [activeFileTab]);

  const handleSelectFileTab = useCallback((tabId: string) => {
    setActiveFileTabId(tabId);
    setRightView("file");
  }, []);
  // Stable selectors for the memoized RightPanel: inline arrows here would be
  // new identities every render and defeat the memo boundary.
  const handleSelectRightView = useCallback((view: RightPanelView) => {
    setRightView(view);
  }, []);

  const handleRevealDone = useCallback(() => {
    setRevealPath(null);
  }, []);

  const handleToggleFileSearch = useCallback(() => {
    setFileSearchOpen((open) => !open);
  }, []);

  const handleCloseOtherFileTabs = useCallback(() => {
    if (!activeFileTab) return;
    setFileTabs([activeFileTab]);
    setDirtyFileTabIds((prev) => (prev.has(activeFileTab.id) ? new Set([activeFileTab.id]) : new Set<string>()));
  }, [activeFileTab]);

  const handleCloseAllFileTabs = useCallback(() => {
    setFileTabs([]);
    setDirtyFileTabIds(new Set<string>());
    setActiveFileTabId(null);
    setRightView("explorer");
  }, []);

  const handleViewFullHistory = useCallback(() => {
    if (!selectedSession) return;
    window.open(
      `/api/sessions/${encodeURIComponent(selectedSession.id)}/export?inline=1`,
      "_blank",
      "noopener,noreferrer",
    );
  }, [selectedSession]);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  // P8: draft key of the ACTIVE session composer — the same formula ChatWindow
  // uses for ChatInput's draftKey — so right-panel "insert into composer"
  // targets exactly the active draft, never a split pane's other session.
  const composerDraftKey = useMemo(
    () => selectedSession?.id ?? (effectiveNewSessionCwd ? `new:${effectiveNewSessionCwd}` : null),
    [selectedSession?.id, effectiveNewSessionCwd],
  );
  // P20.3 share-target intake: as soon as the active composer's draft key is
  // known, the shared payload becomes a COMPOSER DRAFT via the draft-store
  // seam — never auto-sent — prefixed with the P20.4 provenance header so the
  // user reviews and sends manually. The insert bus gives the already-mounted
  // composer a live pickup (its persistence effect re-writes the same draft);
  // share params are stripped with history.replaceState, never router
  // navigation. Known edge: if the sidebar switches the active composer right
  // after this lands, the draft stays under the key it was written to.
  const [pendingShare, setPendingShare] = useState<SharedTargetPayload | null>(initialShare);
  useEffect(() => {
    if (!pendingShare || !composerDraftKey) return;
    const message = buildShareDraftMessage(pendingShare);
    if (message) {
      const existing = getDraft(composerDraftKey);
      setDraft(composerDraftKey, {
        value: existing?.value ? `${message}\n\n${existing.value}` : message,
        images: existing?.images ?? [],
        files: existing?.files ?? [],
      });
      insertIntoComposer({ text: message, draftKey: composerDraftKey, source: "share-target" });
    }
    setPendingShare(null);
    stripShareTargetParams(
      searchParams.toString(),
      window.location.pathname + window.location.hash,
      (url) => {
        window.history.replaceState(window.history.state, "", url);
      },
    );
  }, [pendingShare, composerDraftKey, searchParams]);
  const newSessionProject = (workspaceOptions.cwd === effectiveNewSessionCwd ? workspaceOptions.selectedProject : null) ?? effectiveNewSessionCwd ?? "";
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  const currentRate = generationSpeed?.current;
  const rate = currentRate ?? generationSpeed?.average;
  const speed = showChat ? formatGenerationSpeed(rate) : null;
  const hasGenerationSpeed = speed !== null;
  useLayoutEffect(() => {
    const header = topBarRef.current;
    const details = mobileToolsRef.current;
    const content = mobileToolsContentRef.current;
    const right = header?.querySelector<HTMLElement>("[data-topbar-right-group]");
    const tools = header?.querySelector<HTMLElement>(".shell-topbar-tools");
    if (!header || !details || !content || !right || !tools) return;
    const update = () => {
      const hadControlsFocus = content.contains(document.activeElement);
      // Measure the real controls even while their disclosure is closed.
      const closed = !details.open;
      const display = content.style.display;
      const visibility = content.style.visibility;
      content.style.visibility = "hidden";
      content.style.display = "flex";
      details.open = true;
      const children = Array.from(content.children).filter((child) =>
        !["absolute", "fixed"].includes(getComputedStyle(child).position));
      const contentStyle = getComputedStyle(content);
      const headerStyle = getComputedStyle(header);
      const rightStyle = getComputedStyle(right);
      const controlsWidth = children.reduce((width, child) => {
        const style = getComputedStyle(child);
        return width + child.getBoundingClientRect().width
          + parseFloat(style.marginLeft) + parseFloat(style.marginRight);
      }, 0) + Math.max(0, children.length - 1) * parseFloat(contentStyle.columnGap);
      const required = controlsWidth
        + (tools.firstElementChild?.getBoundingClientRect().width ?? 0)
        + parseFloat(getComputedStyle(tools).columnGap)
        + parseFloat(headerStyle.paddingLeft) + parseFloat(headerStyle.paddingRight)
        + parseFloat(headerStyle.columnGap)
        + parseFloat(rightStyle.minWidth)
        + parseFloat(rightStyle.paddingLeft) + parseFloat(rightStyle.paddingRight);
      if (closed) details.open = false;
      content.style.display = display;
      content.style.visibility = visibility;
      const compact = required > header.clientWidth;
      if (compact && details.dataset.compact !== "true" && hadControlsFocus) {
        restoreToolsFocusRef.current = true;
      }
      setCompactTopbar(compact);
    };
    const observer = new ResizeObserver(update);
    observer.observe(header);
    observer.observe(content);
    for (const child of content.children) observer.observe(child);
    document.fonts.addEventListener("loadingdone", update);
    update();
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", update);
    };
  }, [hasGenerationSpeed, isMobile, locale, rightPanelOpen, showChat]);
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  const sidebarHistory = useSidebarHistory({
    active: isMobile && (showChat || Boolean(initialSessionId)),
    ready: mobileSidebarReady,
    sidebarOpen,
    setSidebarOpen,
    url: searchParams.toString(),
  });
  useEffect(() => {
    if (sidebarHistory.exitNeedsNativeBack) {
      toast.info(t("appShell.exitNativeBackTitle"), t("appShell.exitNativeBackDescription"));
    }
  }, [sidebarHistory.exitNeedsNativeBack, t]);

  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const windowTitle = activeCwdName ? `${activeCwdName} - omp web` : "omp web";

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  const sidebarContent = (
    <SessionSidebar
      selectedSessionId={selectedSession?.id ?? null}
      optimisticSession={selectedSession?.path === "" ? selectedSession : null}
      onSelectSession={handleSelectSession}
      onNewSession={handleNewSession}
      initialSessionId={initialSessionId}
      skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
      onInitialRestoreDone={handleInitialRestoreDone}
      refreshKey={refreshKey}
      onSessionDeleted={handleSessionDeleted}
      selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
      onCwdChange={handleCwdChange}
      onWorkspaceOptionsChange={handleWorkspaceOptionsChange}
      addProjectOpen={addProjectOpen}
      setAddProjectOpen={setAddProjectOpen}
      usageVisible={providerUsageVisible}
      settingsOpen={Boolean(settingsTab)}
      onOpenSettings={() => setSettingsTab((prev) => prev ? null : "general")}
      onOpenArchive={() => setArchiveBrowserOpen(true)}
      updateAvailable={Boolean(appUpdate?.updateAvailable) || ompUpdateAvailable}
      onRunningIdsChange={handleRunningIdsChange}
      onSplitSession={splitEnabled ? handleSplitSession : undefined}
      onLaunchProject={handleLaunchProject}
    />
  );

  // The main chat node is hoisted so the split layout can drop it into
  // SplitPane's left pane without duplicating the (long) prop list.
  const mainChatNode = (
    <ChatWindow
      key={sessionKey}
      session={selectedSession}
      newSessionCwd={effectiveNewSessionCwd}
      newSessionWorkspace={effectiveNewSessionCwd && (
        <div className="mb-4 flex min-w-0 flex-col gap-2">
          <label htmlFor="new-session-workspace" style={{ fontSize: 13, fontWeight: 500, color: "var(--text-muted)" }}>
            {t("settingsConfig.chipWorkspace")}
          </label>
          <select
            id="new-session-workspace"
            aria-describedby="new-session-workspace-path"
            value={effectiveNewSessionCwd}
            onChange={(event) => {
              const cwd = event.target.value;
              if (!cwd) {
                setAddProjectOpen(true);
                return;
              }
              if (cwd === effectiveNewSessionCwd) return;
              suppressCwdRef.current = cwd;
              setActiveCwd(cwd);
              handleNewSession("", cwd);
            }}
            style={{ width: "100%", minWidth: 0, minHeight: 44, padding: "8px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", fontSize: 16 }}
          >
            {!workspaceOptions.projects.some((project) => comparableProjectPath(project.path) === comparableProjectPath(newSessionProject)) && (
              <option key={effectiveNewSessionCwd} value={effectiveNewSessionCwd}>{projectLabel(effectiveNewSessionCwd)}</option>
            )}
            {workspaceOptions.projects.map((project) => {
              const current = comparableProjectPath(project.path) === comparableProjectPath(newSessionProject);
              const label = project.alias ?? projectLabel(project.path);
              const duplicate = workspaceOptions.projects.some((other) => other.path !== project.path && (other.alias ?? projectLabel(other.path)) === label);
              return (
                <option key={project.path} value={current ? effectiveNewSessionCwd : project.path}>
                  {duplicate ? `${label} — ${project.path}` : label}
                </option>
              );
            })}
            <option value="">+ {t("projects.add")}</option>
          </select>
          <div id="new-session-workspace-path" style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
            {effectiveNewSessionCwd}
          </div>
        </div>
      )}
      onAgentEnd={handleAgentEnd}
      onSessionCreated={handleSessionCreated}
      onSessionForked={handleSessionForked}
      modelsRefreshKey={modelsRefreshKey}
      chatInputRef={chatInputRef}
      onOpenFile={handleOpenLinkedFile}
      onBranchDataChange={handleBranchDataChange}
      onSystemPromptChange={handleSystemPromptChange}
      onSystemPromptLoaderChange={handleSystemPromptLoaderChange}
      onSessionStatsChange={handleSessionStatsChange}
      onSessionStatsPanelOpen={openSessionStatsPanel}
      onGenerationSpeedChange={handleGenerationSpeedChange}
      onOpenProviders={() => setSettingsTab("providers")}
      anchorRequest={pendingAnchor}
      onAnchorApplied={handleAnchorApplied}
      onOpenSearchPalette={(query) => openPalette({ mode: "search", query })}
      toolCallsDefaultCollapsed={toolCallsDefaultCollapsed}
    />
  );

  return (
    <>
    <ToastProvider>
      <ConfirmDialog
        open={sidebarHistory.exitConfirmationOpen}
        onOpenChange={(open) => { if (!open) sidebarHistory.cancelExit(); }}
        title={t("appShell.exitTitle")}
        description={t("appShell.exitDescription")}
        confirmLabel={t("appShell.exitLeave")}
        cancelLabel={t("appShell.exitStay")}
        danger
        onConfirm={sidebarHistory.leave}
      />
      <CommandPalette
        onSelectSession={handleSelectSession}
        onOpenSearchResult={handleOpenSearchResult}
        launchProjects={workspaceOptions.projects}
        onLaunchProject={handleLaunchProject}
        onNewSession={() => {
          // An empty cwd is truthy, so showChat would render the shell while
          // useAgentSession refuses to start — every send a silent no-op.
          // Fall back to the server's default cwd (~/omp-cwd-<date>) instead.
          if (activeCwd) {
            handleNewSession(`palette-${Date.now()}`, activeCwd);
            return;
          }
          void fetch("/api/default-cwd", { method: "POST" })
            .then(async (response) => {
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              const data = (await response.json()) as { cwd?: string };
              if (!data.cwd) throw new Error("Empty cwd returned");
              return data;
            })
            .then((data) => {
              if (!data.cwd) throw new Error("Empty cwd returned");
              handleNewSession(`palette-${Date.now()}`, data.cwd);
            })
            .catch(() => toast.error(translate("errors.generic")));
        }}
        currentModel={null}
      />
    <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: visible;
        transform-origin: top right;
        animation: session-info-pop var(--dur-slow) var(--ease-out-warm) both;
        will-change: transform, opacity;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash var(--dur-slow) var(--ease-out-warm) both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(-100%);
          box-shadow: none;
        }
      }
    `}</style>
    <div style={{
      display: "flex",
      height: "100%",
      flex: 1,
      overflow: "hidden",
      background: "var(--bg)",
      // iOS shell/PWA: `viewport-fit: cover` runs the web view edge-to-edge,
      // so the shell must inset itself — without this the topbar, session
      // header and mobile drawer render under the notch/Dynamic Island.
      // Bottom is deliberately NOT padded here: the composer and chat already
      // apply `env(safe-area-inset-bottom)` themselves.
      paddingTop: "env(safe-area-inset-top, 0px)",
      paddingLeft: "env(safe-area-inset-left, 0px)",
      paddingRight: "env(safe-area-inset-right, 0px)",
    }}>
      {/* Left sidebar: hidden on full-page Settings and the runs board */}
      {!settingsTab && !runsBoardOpen && (
        <>
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "color-mix(in srgb, var(--text) 28%, transparent)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity var(--dur-slow) var(--ease-out-warm)",
        }}
      />

      {/* Left sidebar */}
      <div
        ref={sidebarContainerRef}
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}${sidebarResizing ? " sidebar-resizing" : ""}`}
        aria-hidden={mobileSidebarReady && !sidebarOpen ? true : undefined}
        inert={mobileSidebarReady && !sidebarOpen ? true : undefined}
        style={{
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          zIndex: 200,
          // Desktop-only: the width is user-adjustable via the resize handle.
          ...(!isMobile ? { "--sidebar-width": `${sidebarWidth}px` } : {}),
        }}
      >
        {sidebarContent}
      </div>

      {/* Resize handle — desktop only, hidden while the sidebar is closed */}
      {!isMobile && sidebarOpen && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("appShell.resizeSidebar")}
          tabIndex={0}
          onMouseDown={handleSidebarResizeStart}
          onDoubleClick={resetSidebarWidth}
          onKeyDown={handleSidebarResizeKey}
          title={t("appShell.resizeSidebarTitle")}
          style={{
            width: 5,
            flexShrink: 0,
            marginLeft: -5,
            cursor: "col-resize",
            background: "transparent",
            zIndex: 205,
            outline: "none",
            transition: "background var(--dur-fast) var(--ease-out-warm)",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 35%, transparent)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          onFocus={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 35%, transparent)"; }}
          onBlur={(e) => { e.currentTarget.style.background = "transparent"; }}
        />
      )}
        </>
      )}

      {/* Center: chat */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {settingsTab ? (
          <SettingsConfig
            activeTab={settingsTab}
            toolCallsDefaultCollapsed={toolCallsDefaultCollapsed}
            onToolCallsDefaultCollapsedChange={handleToolCallsDefaultCollapsedChange}
            providerUsageVisible={providerUsageVisible}
            onProviderUsageVisibleChange={handleProviderUsageVisibleChange}
            scopeNativeSelectAll={scopeNativeSelectAll}
            onScopeNativeSelectAllChange={handleScopeNativeSelectAllChange}
            cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd}
            sessionId={selectedSession?.id ?? null}
            onModelsSaved={() => setModelsRefreshKey((k) => k + 1)}
            onPluginsReloaded={() => setSessionKey((k) => k + 1)}
            appUpdate={appUpdate}
            onRefreshAppUpdate={refreshAppUpdate}
            onOmpUpdateAvailabilityChange={setOmpUpdateAvailable}
            onRequestAppUpdate={requestAppUpdateFromSettings}
            onSelectTab={setSettingsTab}
            onClose={() => setSettingsTab(null)}
          />
        ) : runsBoardOpen ? (
          <RunsBoard
            onClose={() => setRunsBoardOpen(false)}
            onOpenSession={handleOpenSessionFromBoard}
            onNewSession={handleNewSessionFromBoard}
            projects={workspaceOptions.projects}
            activeCwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? null}
          />
        ) : (
          <>
        {/* Top bar: 3-zone segmented control bar */}
        <div ref={topBarRef} className="shell-topbar" style={{
          position: "relative",
          alignItems: "center",
          flexShrink: 0,
          borderBottom: "1px solid var(--border)",
          minHeight: isMobile ? 44 : 36,
          background: "var(--bg-panel)",
          padding: isMobile ? "0 4px" : "0 8px",
          // Reserve the fixed show-file-panel toggle's corner (mobile pads via
          // the ≤640px CSS rule; desktop must too, so no topbar control can
          // end up underneath the toggle's click area).
          paddingRight: 44,
          gap: "0 8px",
          minWidth: 0,
        }}>
          {/* Left Zone: Utility group (sidebar, theme, language) & session controls (history, branches, system) */}
          <div className="shell-topbar-tools" style={{ display: "flex", alignItems: "center", gap: 4, height: isMobile ? 43 : 35, minWidth: 0, flexShrink: 0 }}>
            <button
              onClick={handleSidebarToggle}
              title={sidebarOpen ? t("appShell.hideSidebar") : t("appShell.showSidebar")}
              aria-label={sidebarOpen ? t("appShell.hideSidebar") : t("appShell.showSidebar")}
              className="shell-toolbar-btn ui-focus-ring"
            >
              {sidebarOpen ? <PanelLeft size={16} strokeWidth={1.8} aria-hidden="true" /> : <Menu size={16} strokeWidth={1.8} aria-hidden="true" />}
            </button>
            <details
              ref={mobileToolsRef}
              className="shell-topbar-overflow"
              data-compact={compactTopbar === null ? "pending" : compactTopbar}
              open={compactTopbar ? undefined : true}
              onToggle={(event) => {
                if (!event.currentTarget.open) setActiveTopPanel(null);
              }}
            >
              <summary
                className="shell-toolbar-btn ui-focus-ring"
                title={t("chatInput.moreControls")}
                aria-label={t("chatInput.moreControls")}
              >
                <Ellipsis size={16} strokeWidth={1.8} aria-hidden="true" />
              </summary>
              <div ref={mobileToolsContentRef} className="shell-topbar-overflow-content">
            <ThemeSwitcher />
            <LanguageSwitcher />
            {showChat && (
              <>
                <div className="shell-toolbar-divider" aria-hidden="true" />
                <SessionExportMenu
                  sessionId={selectedSession?.id ?? null}
                  onViewHtml={handleViewFullHistory}
                  disabled={!selectedSession}
                />
                <BranchNavigator
                  tree={branchTree}
                  activeLeafId={branchActiveLeafId}
                  onLeafChange={handleBranchLeafChange}
                  inline
                  containerRef={compactTopbar ? mobileToolsContentRef : topBarRef}
                  open={activeTopPanel === "branches"}
                  onToggle={() => toggleTopPanel("branches")}
                  hasSession
                  sessionId={selectedSession?.id ?? null}
                  onCompareLeaf={splitEnabled && selectedSession ? handleCompareLeaf : undefined}
                />
                {splitEnabled && (
                  <button
                    type="button"
                    onClick={handleToggleSplit}
                    disabled={!selectedSession}
                    title={t("splitView.splitRight")}
                    aria-label={t("splitView.splitRight")}
                    aria-pressed={splitActive}
                    className="shell-toolbar-btn ui-focus-ring"
                  >
                    <Columns2 size={16} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                )}
                <button
                  ref={systemBtnRef}
                  onClick={handleSystemPromptToggle}
                  title={t("appShell.system")}
                  aria-label={t("appShell.system")}
                  aria-pressed={activeTopPanel === "system"}
                  className="shell-toolbar-btn ui-focus-ring"
                >
                  <Terminal size={16} strokeWidth={1.8} aria-hidden="true" style={{ color: systemPrompt ? "var(--accent)" : undefined }} />
                </button>
              </>
            )}
          {activeTopPanel === "system" && (
            <div data-top-panel className="dropdown-surface" style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: isMobile ? 4 : 8,
              right: "auto",
              width: "auto",
              minWidth: isMobile ? undefined : 420,
              maxWidth: "min(680px, calc(100vw - 24px))",
              maxHeight: "min(70vh, calc(100dvh - 56px))",
              overflowY: "auto",
              overflowX: "hidden",
              zIndex: 500,
            }}>
              {activeTopPanel === "system" && (
                <div className="session-info-popover" style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                  boxShadow: "var(--shadow-pop)",
                  minWidth: isMobile ? undefined : 420,
                }}>
                  {systemPrompt ? (
                    <div style={{
                      maxHeight: "min(600px, 75vh)",
                      overflowY: "auto",
                      padding: "12px 16px",
                      color: "var(--text-muted)",
                      fontSize: 12,
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      fontFamily: "var(--font-mono)",
                    }}>
                      {systemPrompt}
                    </div>
                  ) : systemPrompt === "" ? (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      {t("appShell.systemPromptEmpty")}
                    </div>
                  ) : (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      {systemPromptLoading ? t("appShell.systemPromptLoading") : t("appShell.systemPromptLoadHint")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
              </div>
            </details>
          </div>

          {/* Notifications bell: always visible (never folded into the
              overflow menu) so background run completions stay reachable.
              Runs board button: same treatment (P3) — a live badge from the
              sidebar's running-events subscription. LiveCallChip (⑦): the
              pulsing mic shown while a /live call is hot, via the
              lib/live/live-indicator.ts window bus. */}
          <div style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
            <LiveCallChip />
            <NotificationsBell
              onOpenSession={handleOpenSessionFromBell}
              onOpenSettings={handleOpenNotifySettings}
            />
            <button
              type="button"
              onClick={handleToggleRunsBoard}
              aria-label={t("runsBoard.button.ariaLabel", { count: runningIds.length })}
              title={t("runsBoard.button.ariaLabel", { count: runningIds.length })}
              aria-pressed={runsBoardOpen}
              className="shell-toolbar-btn ui-focus-ring"
              style={{ position: "relative" }}
            >
              <LayoutGrid size={16} strokeWidth={1.8} aria-hidden="true" />
              {runningIds.length > 0 && (
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    top: 2,
                    right: 1,
                    minWidth: 14,
                    height: 14,
                    padding: "0 3px",
                    borderRadius: 999,
                    background: "var(--accent-strong)",
                    color: "var(--on-accent)",
                    fontSize: 9,
                    fontWeight: 700,
                    lineHeight: "14px",
                    textAlign: "center",
                    pointerEvents: "none",
                  }}
                >
                  {runningIds.length > 9 ? "9+" : runningIds.length}
                </span>
              )}
            </button>
          </div>

          {/* Center Zone: Workspace & Session Breadcrumb + Auto-name action */}
          {showChat && (() => {
            const effectiveProject = selectedSession?.projectRoot ?? selectedSession?.cwd ?? activeCwd ?? "";
            const sessionTitle = selectedSession?.name || selectedSession?.firstMessage || t("appShell.newSession");
            const hasMessages = Boolean(
              selectedSession
              && (sessionStats?.userMessages ?? selectedSession.messageCount) > 0,
            );
            const wandDisabled = !selectedSession || !hasMessages || autoNameStatus.kind === "naming";
            const wandIsSuccess = autoNameStatus.kind === "success";
            const wandIsError = autoNameStatus.kind === "error";
            const wandLabel = autoNameStatus.kind === "naming"
              ? t("appShell.generating")
              : wandIsSuccess
                ? t("appShell.titleUpdated")
                : wandIsError
                  ? t("appShell.generationFailed")
                  : t("appShell.generateTitle");
            const wandTooltip = !selectedSession
              ? t("appShell.titleGenUnavailable")
              : !hasMessages
                ? t("appShell.titleGenNeedsMessage")
                : wandIsError
                  ? autoNameStatus.message
                  : t("appShell.generateSessionTitle");

            return (
              <div
                className="shell-topbar-center"
                style={{
                  minWidth: 0,
                  containerType: "inline-size",
                  containerName: "breadcrumb",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <div
                  className="shell-topbar-breadcrumb"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    height: 26,
                    padding: "0 8px",
                    borderRadius: "var(--radius-control)",
                    background: "var(--bg-subtle)",
                    border: "1px solid var(--border)",
                    fontSize: 11,
                    color: "var(--text-muted)",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                    maxWidth: "min(400px, 30vw)",
                    flexShrink: 1,
                  }}
                >
                  {effectiveProject ? (
                    <>
                      <Folder size={12} strokeWidth={1.8} style={{ opacity: 0.6, flexShrink: 0 }} aria-hidden="true" />
                      <span
                        style={{
                          fontWeight: 600,
                          color: "var(--text)",
                          flexShrink: 0,
                          maxWidth: 120,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={effectiveProject}
                      >
                        {projectLabel(effectiveProject)}
                      </span>
                      <span style={{ color: "var(--text-dim)", flexShrink: 0, opacity: 0.5 }}>/</span>
                    </>
                  ) : null}
                  <span
                    style={{
                      color: "var(--text)",
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                    }}
                    title={sessionTitle}
                  >
                    {sessionTitle}
                  </span>
                  {selectedSession && (
                    <button
                      type="button"
                      onClick={() => void handleAutoName()}
                      disabled={wandDisabled}
                      title={wandTooltip}
                      aria-label={wandLabel}
                      className="ui-focus-ring"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 18,
                        height: 18,
                        padding: 0,
                        marginLeft: 2,
                        border: "none",
                        borderRadius: 4,
                        background: "transparent",
                        color: wandIsSuccess ? "var(--accent)" : wandIsError ? "var(--status-error)" : "var(--text-dim)",
                        cursor: wandDisabled ? "default" : "pointer",
                        flexShrink: 0,
                        opacity: autoNameStatus.kind === "naming" ? 1 : wandDisabled ? 0.35 : 0.75,
                        transition: "color var(--dur-fast), opacity var(--dur-fast)",
                      }}
                    >
                      {autoNameStatus.kind === "naming" ? (
                        <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      ) : wandIsSuccess ? (
                        <Check size={12} strokeWidth={2} aria-hidden="true" />
                      ) : (
                        <Wand2 size={12} strokeWidth={1.8} aria-hidden="true" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Right Zone: Segmented metric pills (Provider limits, Session Stats/Usage, Speed) */}
          <div
            data-topbar-right-group
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: 6,
              paddingRight: rightPanelOpen ? 8 : 44,
              minWidth: hasGenerationSpeed ? "calc(10ch + 33px)" : 0,
              width: hasGenerationSpeed ? 200 : 0,
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              containerType: "inline-size",
              containerName: "topbar-speed",
              flexShrink: 1,
            }}
          >

            {/* Generation speed pill */}
            {showChat && (() => {
              if (!speed || rate == null) return null;
              const isLive = currentRate != null;
              const speedTitle = t(isLive ? "appShell.tooltipCurrentSpeed" : "appShell.tooltipAverageSpeed", {
                value: `${rate.toFixed(1)} t/s`,
              });

              return (
                <div
                  title={speedTitle}
                  role="img"
                  aria-label={speedTitle}
                  className="shell-metric-pill shell-pill-extra"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    height: 26,
                    padding: "0 8px",
                    borderRadius: "var(--radius-control)",
                    border: "1px solid var(--border)",
                    background: "var(--bg-subtle)",
                    color: isLive ? "var(--accent)" : "var(--text-muted)",
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    fontVariantNumeric: "tabular-nums",
                    whiteSpace: "nowrap",
                    cursor: "default",
                    width: "calc(10ch + 33px)",
                    flexShrink: 0,
                  }}
                >
                  {isLive ? (
                    <Zap size={11} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0, color: "var(--accent)" }} />
                  ) : (
                    <span aria-hidden="true" style={{ width: 11, lineHeight: "11px", textAlign: "center", flexShrink: 0, color: "var(--text-dim)" }}>~</span>
                  )}
                  <span style={{ display: "inline-flex", gap: "1ch", fontWeight: isLive ? 600 : 400 }}>
                    <span style={{ width: "5ch", textAlign: "right" }}>{speed.value}</span>
                    <span style={{ width: "4ch" }}>{speed.unit}</span>
                  </span>
                </div>
              );
            })()}
          </div>

        </div>

        {/* Chat content (P12: when the split is active the main chat moves
            into SplitPane's left pane and the split session renders right) */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {showChat ? (
            splitActive ? (
              <SplitPane
                activePane={activePane}
                onActivePaneChange={setActivePane}
                rightTitle={splitTitle}
                onCloseRight={closeSplit}
                left={mainChatNode}
                right={
                  <ChatWindow
                    key={`split:${splitSessionId ?? ""}`}
                    session={splitSession}
                    newSessionCwd={null}
                    modelsRefreshKey={modelsRefreshKey}
                    toolCallsDefaultCollapsed={toolCallsDefaultCollapsed}
                    anchorRequest={splitAnchor}
                    onOpenFile={handleOpenLinkedFile}
                  />
                }
              />
            ) : mainChatNode
          ) : initialCwdStatus === "validating" ? (
            <div
              role="status"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
              <div style={{ fontSize: 14, color: "var(--text)" }}>{t("appShell.openingWorkspace")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
            </div>
          ) : initialCwdStatus === "error" ? (
            <div
              role="alert"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
              <div style={{ fontSize: 14, color: "var(--status-error)" }}>{t("appShell.unableToOpenWorkspace")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
              <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwdError}</div>
            </div>
          ) : !showPlaceholder ? (
            <PanelLoadingFallback />
          ) : (
            activeCwd ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 16 }}>
                <span className="display-serif">{t("appShell.selectSessionHint")}</span>
              </div>
            ) : (
              <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                </svg>
                <div>
                  <div className="display-serif" style={{ fontSize: 20, color: "var(--text)", marginBottom: 8 }}>{t("appShell.getStarted")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{t("appShell.getStartedStep1")}<br />
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>
                    {(() => {
                      // One translatable sentence; the {models} slot is rendered
                      // as the emphasized button name so word order stays free.
                      const [before, after] = t("appShell.getStartedStep2").split("{models}");
                      return (
                        <>
                          {before}
                          <strong style={{ color: "var(--text)" }}>{t("appShell.models")}</strong>
                          {after}
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            )
          )}
        </div>
          </>
        )}
      </main>
      {!settingsTab && (
        <RightPanel
        fileTabs={fileTabs}
        dirtyFileTabIds={dirtyFileTabIds}
        activeFileTabId={activeFileTabId}
        rightView={rightView}
        onSelectView={handleSelectRightView}
        rightPanelOpen={rightPanelOpen}
        rightPanelWidth={rightPanelWidth}
        rightPanelResizing={rightPanelResizing}
        rightPanelRef={rightPanelRef}
        fileExplorerRef={fileExplorerRef}
        revealPath={revealPath}
        onRevealDone={handleRevealDone}
        explorerCwd={explorerCwd}
        activeCwd={activeCwd}
        composerDraftKey={composerDraftKey}
        explorerRefreshKey={explorerRefreshKey}
        fileSearchOpen={fileSearchOpen}
        onToggleFileSearch={handleToggleFileSearch}
        onFileSearchOpenChange={setFileSearchOpen}
        explorerUploadBusy={explorerUploadBusy}
        onUploadBusyChange={setExplorerUploadBusy}
        explorerGitCount={explorerGitCount}
        explorerIsRepo={explorerIsRepo}
        explorerRefreshing={explorerRefreshing}
        isMobile={isMobile}
        onOpenFile={handleOpenFile}
        onSelectFileTab={handleSelectFileTab}
        onCloseFileTab={handleCloseFileTab}
        onCloseOtherFileTabs={handleCloseOtherFileTabs}
        onCloseAllFileTabs={handleCloseAllFileTabs}
        onMentionActiveFile={handleMentionActiveFile}
        onCopyActiveFilePath={handleCopyActiveFilePath}
        onDownloadActiveFile={handleDownloadActiveFile}
        onRevealActiveFile={handleRevealActiveFile}
        onExplorerRefresh={handleExplorerRefresh}
        onExplorerRefreshDone={handleExplorerRefreshDone}
        onAtMention={handleAtMention}
        onAtMentions={handleAtMentions}
        onMentionLines={handleFileLineMention}
        onFileTabDirtyChange={handleFileTabDirtyChange}
        onExplorerGitStatus={handleExplorerGitStatus}
        onResetRightPanelWidth={resetRightPanelWidth}
        onRightPanelResizeStart={handleRightPanelResizeStart}
        onRightPanelResizeKey={handleRightPanelResizeKey}
      />
      )}

    </div>
    {!settingsTab && (
      <button
      onClick={() => setRightPanelOpen((v) => !v)}
      title={rightPanelOpen ? t("appShell.hideFilePanel") : t("appShell.showFilePanel")}
      aria-label={rightPanelOpen ? t("appShell.hideFilePanel") : t("appShell.showFilePanel")}
      style={{
        // Floating chrome: `fixed`, so it must inset itself past the iOS
        // notch/Dynamic Island and rounded corners.
        position: "fixed",
        top: "env(safe-area-inset-top, 0px)",
        right: "env(safe-area-inset-right, 0px)",
        zIndex: 300,
        display: "flex", alignItems: "center", justifyContent: "center",
        width: isMobile ? 44 : 36, height: isMobile ? 44 : 36, padding: 0,
        background: "var(--bg-panel)", border: "none", borderLeft: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
        color: rightPanelOpen ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer", transition: "color var(--dur-fast) var(--ease-out-warm)",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = rightPanelOpen ? "var(--text)" : "var(--text-muted)"; }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
      </svg>
    </button>
    )}
    <AppUpdateDialog open={appUpdateDialogOpen} update={appUpdate} phase={appUpdatePhase} visibleStage={appUpdateVisibleStage} error={appUpdateError} onProceed={() => void proceedWithAppUpdate()} onNotNow={dismissAppUpdate} />
    {archiveBrowserOpen && (
      <ArchiveBrowser
        open={archiveBrowserOpen}
        onClose={() => setArchiveBrowserOpen(false)}
        onRestored={handleArchiveRestored}
      />
    )}
    </ToastProvider>
    </>
  );
}
