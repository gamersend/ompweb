import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "../omp/paths";
import {
  applyNotifyConfigUpdate,
  defaultNotifyConfig,
  parseNotifyConfig,
  type NotifyConfig,
  type NotifyConfigUpdate,
} from "./notify-shared";

// ============================================================================
// ~/.omp/agent/web-notify-config.json — the user-owned notification settings
// (browser toggle, webhook provider/URL/events, quiet hours).
//
// Store pattern (BUILD-PLAN cross-cutting): atomic temp+rename writes, migrate
// on read, corrupt file quarantined to *.bak-<ts> and rebuilt from defaults.
// The webhook URL is a credential, so the file is written mode 0600 (best
// effort on Windows — NTFS has no POSIX mode bits; POSIX hosts enforce it).
// ============================================================================

export const NOTIFY_CONFIG_FILE = "web-notify-config.json";

export function getNotifyConfigPath(): string {
  return join(getAgentDir(), NOTIFY_CONFIG_FILE);
}

function writeConfigFile(config: NotifyConfig): void {
  const path = getNotifyConfigPath();
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    // 0600-equivalent: the URL may embed provider tokens (telegram bot token,
    // ntfy topic path) — treat the file like omp's other local secrets.
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
}

export function loadNotifyConfig(): NotifyConfig {
  const path = getNotifyConfigPath();
  if (!existsSync(path)) return defaultNotifyConfig();
  let parsed: NotifyConfig | null;
  try {
    parsed = parseNotifyConfig(readFileSync(path, "utf8"));
  } catch {
    parsed = null;
  }
  if (!parsed) {
    try {
      renameSync(path, `${path}.bak-${Date.now()}`);
    } catch {
      // ignore
    }
    return defaultNotifyConfig();
  }
  return parsed;
}

export function saveNotifyConfig(config: NotifyConfig): void {
  writeConfigFile(config);
}

/** Load + validate + apply a PUT payload + persist. Throws nothing: errors
 * come back structured for the route to map onto 400. */
export function updateNotifyConfig(update: NotifyConfigUpdate): { ok: true; config: NotifyConfig } | { ok: false; errors: string[] } {
  const result = applyNotifyConfigUpdate(loadNotifyConfig(), update);
  if (result.ok) saveNotifyConfig(result.config);
  return result;
}
