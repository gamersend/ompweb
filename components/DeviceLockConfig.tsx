"use client";

import { useCallback, useEffect, useState } from "react";
import { Fingerprint, Trash2 } from "lucide-react";
import { startRegistration } from "@simplewebauthn/browser";
import { useI18n } from "@/lib/i18n";
import { toast } from "./ui/toast";
import { ConfirmDialog } from "./ui/field";

// ============================================================================
// Settings → Safety section: device-local passkey lock (BUILD-PLAN-2 P12).
// Renders NOTHING unless GET /api/device-lock/status says the gate is enabled
// (OMP_WEB_DEVICE_LOCK=1) — the section must be invisible in the default app.
// - Credentials list (label, createdAt) with confirm-before-revoke.
// - Register-passkey flow: nickname input → startRegistration ceremony.
// - Recovery hint: losing every passkey is fixed by deleting web-authz.json
//   on disk and restarting; there is no in-app unlock without a passkey.
// ============================================================================

interface DeviceCredentialRow {
  id: string;
  label: string;
  createdAt: string;
}

interface DeviceLockStatus {
  enabled: boolean;
  hasCredentials: boolean;
  credentialCount: number;
  credentials: DeviceCredentialRow[];
  unlocked: boolean;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function DeviceLockConfig() {
  const { t } = useI18n();
  const [status, setStatus] = useState<DeviceLockStatus | null>(null);
  const [nickname, setNickname] = useState("");
  const [registering, setRegistering] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<DeviceCredentialRow | null>(null);
  const [revoking, setRevoking] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/device-lock/status");
      if (!response.ok) return;
      const payload = (await response.json()) as { success: boolean; data: DeviceLockStatus };
      if (payload?.success) setStatus(payload.data);
    } catch {
      // status is best-effort; the section simply stays hidden
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!status?.enabled) return null;

  async function registerPasskey() {
    setRegistering(true);
    try {
      const beginResponse = await fetch("/api/device-lock/register-begin", { method: "POST" });
      if (!beginResponse.ok) {
        const failure = (await beginResponse.json().catch(() => null)) as { code?: string } | null;
        toast.error(t(failure?.code === "device_lock_bootstrap_loopback_required" ? "lock.registerLoopbackRequired" : "lock.registerBeginFailed"));
        return;
      }
      const begin = (await beginResponse.json()) as { success: boolean; data: unknown };
      const attestation = await startRegistration({ optionsJSON: begin.data as never });
      const finishResponse = await fetch("/api/device-lock/register-finish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: nickname.trim() || t("lock.defaultNickname"), response: attestation }),
      });
      if (!finishResponse.ok) {
        toast.error(t("lock.registerFinishFailed"));
        return;
      }
      toast.success(t("lock.registered"));
      setNickname("");
      await refresh();
    } catch {
      toast.error(t("lock.registerError"));
    } finally {
      setRegistering(false);
    }
  }

  async function revokePasskey() {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      const response = await fetch("/api/device-lock/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: revokeTarget.id }),
      });
      if (!response.ok) {
        toast.error(t("lock.revokeFailed"));
        return;
      }
      const payload = (await response.json()) as { success: boolean; data: { remaining: number; lastCredentialRevoked: boolean } };
      toast.success(payload.data.lastCredentialRevoked ? t("lock.revokedLast") : t("lock.revoked"));
      setRevokeTarget(null);
      await refresh();
    } catch {
      toast.error(t("lock.revokeFailed"));
    } finally {
      setRevoking(false);
    }
  }

  return (
    <section aria-labelledby="device-lock-heading" style={{ padding: 14, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Fingerprint size={16} aria-hidden="true" style={{ color: "var(--accent)" }} />
        <h3 id="device-lock-heading" style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{t("lock.sectionTitle")}</h3>
        <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "var(--bg-subtle)", color: "var(--text-muted)", fontWeight: 500 }}>{t("lock.enabledBadge")}</span>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{t("lock.sectionDesc")}</p>

      {status.credentials.length > 0 ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {status.credentials.map((credential) => (
            <li key={credential.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{credential.label}</div>
                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{formatDate(credential.createdAt)}</div>
              </div>
              <button
                type="button"
                onClick={() => setRevokeTarget(credential)}
                aria-label={`${t("lock.revokeAriaPrefix")} ${credential.label}`}
                style={{ display: "grid", placeItems: "center", width: 28, height: 28, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "none", color: "var(--text-muted)", cursor: "pointer" }}
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{t("lock.noCredentials")}</p>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="text"
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          placeholder={t("lock.nicknamePlaceholder")}
          maxLength={64}
          aria-label={t("lock.nicknamePlaceholder")}
          style={{ flex: "1 1 180px", minWidth: 160, padding: "7px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none" }}
        />
        <button
          type="button"
          onClick={registerPasskey}
          disabled={registering}
          style={{ minHeight: 32, padding: "0 14px", border: 0, borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", fontWeight: 600, fontSize: 12, cursor: registering ? "wait" : "pointer", opacity: registering ? 0.7 : 1 }}
        >
          {registering ? t("lock.registering") : t("lock.registerButton")}
        </button>
      </div>

      <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>{t("lock.recoveryHint")}</p>

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title={t("lock.revokeTitle")}
        description={t("lock.revokeDesc").replace("{label}", revokeTarget?.label ?? "")}
        confirmLabel={t("lock.revokeConfirm")}
        danger
        busy={revoking}
        onConfirm={revokePasskey}
      />
    </section>
  );
}
