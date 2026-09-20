// ============================================================================
// Client device identity (wave 3 P2): a random UUID persisted once in
// localStorage. Presentation metadata ONLY — it labels which device deleted
// a synced item (tombstones) or performed a restore (checkpoint ledger).
// It is never an auth credential, and the server never derives trust from it.
// ============================================================================

const DEVICE_ID_STORAGE_KEY = "omp-web:device-id";

/** Read (creating on first use) this device's sync identity. All failures
 *  are silent — an unavailable storage returns a session-scoped id. */
export function getDeviceId(): string {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
      if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
      const fresh = (crypto.randomUUID?.() ?? `dev-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`)
        .replace(/[^A-Za-z0-9_-]/g, "");
      window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, fresh);
      return fresh;
    }
  } catch {
    // storage unavailable (private mode) — fall through
  }
  return "ephemeral";
}

/** Short label for UI surfaces ("a1b2c3d4"). */
export function shortDeviceId(deviceId: string): string {
  return deviceId.length <= 8 ? deviceId : deviceId.slice(0, 8);
}
