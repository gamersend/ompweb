"use client";

import { Fingerprint } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { useI18n } from "@/lib/i18n";

// Unlock screen for the OPTIONAL device lock (OMP_WEB_DEVICE_LOCK=1 only —
// the proxy redirects here; the route 404s into normal behavior otherwise).
// Passwordless by design: one WebAuthn ceremony against the device's own
// biometric/PIN authenticator mints the short-lived unlock cookie.
export function DeviceLockGateForm() {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unsupported, setUnsupported] = useState(false);

  const unlock = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const beginResponse = await fetch("/api/device-lock/verify-begin", { method: "POST" });
      if (!beginResponse.ok) {
        setError(t("lock.verifyBeginFailed"));
        return;
      }
      const begin = (await beginResponse.json()) as { success: boolean; data: unknown };
      const assertion = await startAuthentication({ optionsJSON: begin.data as never });
      const finishResponse = await fetch("/api/device-lock/verify-finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: assertion }),
      });
      if (!finishResponse.ok) {
        setError(t("lock.verifyFailed"));
        return;
      }
      // Full reload so the new unlock cookie is picked up by the proxy and
      // server components — SPA navigation alone may keep stale state.
      window.location.replace("/");
    } catch {
      setError(t("lock.verifyError"));
    } finally {
      setBusy(false);
    }
  }, [t]);

  useEffect(() => {
    // Surface unsupported browsers instead of a dead button (WebAuthn missing).
    if (typeof window !== "undefined" && !window.PublicKeyCredential) setUnsupported(true);
  }, []);

  return (
    <main style={{ flex: 1, display: "grid", placeItems: "center", padding: 20, background: "var(--bg)" }}>
      <section
        aria-labelledby="device-lock-title"
        style={{ width: "min(100%, 380px)", padding: 32, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius-modal)", boxShadow: "var(--shadow-modal)" }}
      >
        <div style={{ width: 40, height: 40, display: "grid", placeItems: "center", borderRadius: "50%", background: "var(--user-bg)", color: "var(--accent)", marginBottom: 20 }}>
          <Fingerprint size={20} aria-hidden="true" />
        </div>
        <h1 id="device-lock-title" className="display-serif" style={{ margin: 0, fontSize: 28, lineHeight: 1.1, color: "var(--text)" }}>{t("lock.gateTitle")}</h1>
        <p style={{ margin: "10px 0 24px", color: "var(--text-muted)", fontSize: 13, lineHeight: 1.5 }}>{t("lock.gateDesc")}</p>
        <button
          type="button"
          onClick={unlock}
          disabled={busy || unsupported}
          style={{ width: "100%", minHeight: 36, border: 0, borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", fontWeight: 600, cursor: busy ? "wait" : "pointer", opacity: busy ? 0.7 : 1 }}
        >
          {unsupported ? t("lock.unsupported") : busy ? t("lock.busy") : t("lock.unlockButton")}
        </button>
        {error && <p role="alert" style={{ marginTop: 14, marginBottom: 0, color: "var(--status-error)", fontSize: 12 }}>{error}</p>}
        <p style={{ marginTop: 18, marginBottom: 0, color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5 }}>{t("lock.gateRecoveryHint")}</p>
      </section>
    </main>
  );
}
