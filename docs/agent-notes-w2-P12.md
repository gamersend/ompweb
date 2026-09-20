# Phase 12 (wave 2) — Device-local lock · agent notes

**Status:** complete. Gates on this tree at time of writing:
`tsc --noEmit` — **0 errors in every P12 file**; the only remaining error is
`lib/digest.ts(4,45)` (untracked, in-flight from the concurrent P10 agent —
their lane, not P12's). `npm run lint` — **0 errors, 0 warnings**.
`npm test` — **1638 tests, 1636 pass / 0 fail / 2 skipped** (skips are the
POSIX-only 0600-mode test plus a pre-existing Windows skip). All 27 new P12
tests pass (18 in `lib/device-lock.test.mjs`, 9 in
`lib/device-lock-store.test.mjs`).

## What landed

| File | Purpose |
|---|---|
| `package.json` + `package-lock.json` | `@simplewebauthn/server ^13.3.3` + `@simplewebauthn/browser ^13.3.0` under **dependencies** (the wave's remaining new deps — pure JS, dual CJS/ESM, no build step). Lockfile synced via `npm install`. Nothing else changed. |
| `lib/device-lock-store.ts` (new) | `~/.omp/agent/web-authz.json` store: `{version:1, unlockKey, credentials:[{id, publicKey, label, createdAt, counter}]}`. Store pattern (version field + `migrateDeviceAuthz()` parser that returns **null** for foreign shapes, skipping malformed rows individually; atomic temp+rename writes; corrupt file quarantined to `web-authz.json.bak-<ts>` — never silent). Written **mode 0600** (best-effort on NTFS) because `unlockKey` — the random secret the unlock-cookie HMAC is keyed on — must not leak. `MAX_DEVICE_CREDENTIALS = 20`; re-adding an id replaces. This file is created ONLY by an explicit registration in lock mode; the default app never touches it. |
| `lib/web-auth.ts` | Unlocked-cookie addition, same HMAC shape as the password session: `OMP_WEB_UNLOCK_COOKIE = "omp_web_unlock"`, `OMP_WEB_UNLOCK_MAX_AGE_SECONDS` = **12 h** (short-lived — re-verify with the passkey after that), `createDeviceUnlockCookie(unlockKey)` / `isValidDeviceUnlockCookie(cookie, unlockKey)`. Keyed on the **store's unlockKey, never a password**. The cookie only exists in device-lock mode; nothing else sets or reads it. Existing password-session code untouched. |
| `lib/device-lock.ts` (new) | Core. `isDeviceLockEnabled()` — **exactly `OMP_WEB_DEVICE_LOCK === "1"`**; unset/`0`/`true` are all off. `evaluateDeviceLockGate()` — pure gate matrix (below). Cached store read on `globalThis` (`__ompDeviceLockAuthz`, key = `mtimeMs:size`, one `stat` per request in lock mode, re-read only on change; nothing at all when disabled — the "cheap proxy check"). `deriveRpContext(hostHeader, forwardedProto, protocol)` — **rpID = hostname (port stripped, IPv6-bracket aware), origin = scheme + host[:port] from the request host header**, so 127.0.0.1, LAN names, and reverse-proxied hosts all work; a passkey is bound to the origin it was registered on (per-device, by design). `isLoopbackLikeRequest()` — bootstrap check: ANY proxy-forwarding header (`x-forwarded-for`/`x-real-ip`/`forwarded`) disqualifies; direct requests pass. Challenge store on `globalThis` (`__ompDeviceLockChallenges`): **one pending per ceremony kind, 2-minute TTL, single-use** — a matching challenge is deleted before verification; a non-matching guess leaves the pending one intact; restart clears. Ceremonies wrap `@simplewebauthn/server` (v13): registration (`excludeCredentials` from existing, `residentKey:"preferred"`, **`userVerification:"required"`**), authentication (`allowCredentials`, UV required), both verifiers enforce `requireUserVerification:true` (the "unlocks with biometric/PIN" promise) and counter monotonicity (replay defense; the bumped counter is persisted). `revokeCredential()` + stable `DeviceLockErrorCode`s. |
| `lib/device-lock-route.ts` (new) | Route helpers: HTTP status map for the stable codes, `{error, code}` error responses, `rpContextForRequest()`, `setUnlockCookie()` (httpOnly/lax/secure-on-https, mirrors the session route), `isUnlockedRequest()` (parses the Cookie header so plain `Request` works). |
| `app/api/device-lock/status/route.ts` (new) | `GET` → `{success:true, data:{enabled, hasCredentials, credentialCount, credentials:[{id,label,createdAt}], unlocked}}`. Public-key blobs never leave the server; `enabled` mirrors the env gate (the settings section renders nothing when false). nodejs runtime, force-dynamic. |
| `app/api/device-lock/register-begin/route.ts` (new) | `POST` → WebAuthn creation options. **Bootstrap-once:** with zero credentials this is loopback-like only; afterwards it requires a verified unlock cookie (`device_lock_bootstrap_loopback_required` / `device_lock_verified_required`). Cap at 20 → `device_lock_credential_limit`. |
| `app/api/device-lock/register-finish/route.ts` (new) | `POST {label, response}` (bounded 64 KB via `parseJsonWithinLimit`). Verifies the attestation against the pending single-use challenge, persists the credential, and mints the unlock cookie — the registering device is unlocked immediately. First registration creates the store (with its random `unlockKey`). |
| `app/api/device-lock/verify-begin/route.ts` (new) | `POST` → assertion options; needs ≥1 credential (`device_lock_no_credentials`). |
| `app/api/device-lock/verify-finish/route.ts` (new) | `POST {response}` (bounded 32 KB). Verifies the assertion, persists the counter, mints the unlock cookie. This is the ONLY in-app unlock path. |
| `app/api/device-lock/revoke/route.ts` (new) | `POST {id}` (bounded 4 KB) — **requires a verified unlock cookie** (re-checked here even though the proxy normally enforces it). Revoking the LAST credential is allowed; the response carries `{remaining:0, lastCredentialRevoked:true, recovery:"delete-web-authz-json"}` so the UI can warn that recovery from full lock-out is file deletion. |
| `proxy.ts` | One additive block, **entirely inside `if (isDeviceLockEnabled())`**, placed after the cross-origin check and before the password logic: evaluates `evaluateDeviceLockGate` and either passes through, redirects pages to `/device-lock`, or 401s APIs with `{code:"device_locked"}`. Unset env → the block short-circuits (`evaluateDeviceLockGate` returns `next` for `enabled:false`) and every line below runs exactly as before. Order: device gate first, then the untouched password path — with both enabled, a device unlocks with its passkey, then signs in with the password as usual; `/api/web-auth/session` is exempt from the device gate while password auth is on so that path keeps its current behavior (documented below). Proxy-check cost in lock mode: one stat-cached store read + one HMAC verify; zero when disabled. |
| `app/device-lock/page.tsx` + `components/DeviceLockGateForm.tsx` (new) | The unlock screen the proxy redirects to. One button → `startAuthentication` (`@simplewebauthn/browser`) → `/api/device-lock/verify-begin|verify-finish` → full reload on success so the cookie is picked up. Unsupported browsers (no `PublicKeyCredential`) get a disabled button; recovery hint (delete web-authz.json) is on the card. |
| `components/DeviceLockConfig.tsx` (new) + `components/SettingsConfig.tsx` | Settings → Safety section. **Renders `null` unless `GET /api/device-lock/status` says `enabled`** (dynamic import mounted at the end of the safety tabpanel — invisible in the default app). Credentials list (label + createdAt + confirm-before-revoke `ConfirmDialog`), register-passkey flow (nickname input → `startRegistration` → finish), toasts on success/failure, recovery hint text. |
| `lib/i18n/locales/{en,zh-CN,ja}.json` | **29 `lock.*` keys, identical set in all three** (script-verified parity), appended after `live.autoResumed` via anchored edits. No other namespaces touched. |

## Security note

- **Gate exists ONLY under `OMP_WEB_DEVICE_LOCK=1`.** Tests pin the env matrix
  (`undefined`/`""`/`"0"`/`"true"` → off) and assert the proxy source keeps
  every new line inside the `isDeviceLockEnabled()` block, plus that the pure
  gate function short-circuits to `next` when disabled. Default behavior is
  unchanged.
- **No passwords, no typed secrets.** Both ceremonies require user verification
  (biometric/PIN) and bind to the request-derived rpID/origin. Challenges are
  memory-only (restart invalidates), 2-min TTL, single-use. The unlock cookie
  is HMAC-signed with a per-store random secret (mode-0600 file), 12 h max age,
  and never exists when the lock is off.
- **Replay defenses:** authenticator sign counters are persisted and checked
  (monotonicity enforced by `@simplewebauthn/server`); registration
  `excludeCredentials` prevents double-registering one authenticator.
- **Known tradeoffs, deliberate:** (1) rpID/origin follow the request host, so
  any device that can REACH the server can register its own passkey AFTER
  bootstrap — that is the point (per-device biometrics), and it also means a
  passkey registered on `127.0.0.1` is not offered on the LAN name (different
  WebAuthn origins). (2) The "loopback" bootstrap check is HTTP-level: a
  request through ANY proxy (forwarding headers) is refused, but a DIRECT
  request from a LAN device is indistinguishable from loopback (route handlers
  do not expose the socket address). Accepting that is consistent with the
  model above; proxied remote bootstrap is blocked. (3) With password auth AND
  the lock both enabled, `/api/web-auth/session` stays reachable pre-unlock so
  the documented password sign-in path keeps its exact current behavior — the
  password layer is preserved, not weakened; the device gate still fronts
  every other route.

## Recovery documentation

Losing every passkey is recoverable exactly one way, mirrored in the settings
copy, the gate screen, and `lib/device-lock-store.ts`:

> Delete `~/.omp/agent/web-authz.json` from the server's disk and restart
> omp-web. The server drops back to bootstrap mode (gate unarmed, zero
> credentials) and a fresh passkey can be registered from the server machine.

Revoking the last credential in-app triggers the same state, and the revoke
response explicitly says `recovery: "delete-web-authz-json"`.

## Tests

- `lib/device-lock-store.test.mjs` (9): path/agent-dir, default store +
  random unlockKey, migrate matrix (corrupt/foreign/bad rows skipped/unknown
  fields dropped), save+load with `version` on disk, quarantine to
  `.bak-<ts>` preserving the corrupt bytes, 0600 on POSIX (skipped on
  Windows), add-dedupe + cap pruning, remove.
- `lib/device-lock.test.mjs` (18): env gate strictness; runtime gate matrix
  (env on: unlocked / locked / cookie-valid / cookie-expired / bootstrap /
  exemptions; **env off: always `next`**); **source-level proxy gating
  assertions** (regex on `proxy.ts` + `lib/device-lock.ts`); rpID/origin
  derivation (loopback, LAN name, https-forwarded, IPv6, bare host);
  loopback-like check; unlock cookie round trip/expiry/wrong-key/tamper;
  **full ceremony round trips against a MOCKED software ES256 authenticator**
  (hand-rolled CBOR for the COSE key + `"none"` attestation, DER ECDSA
  signatures — the `@simplewebauthn/server` test pattern): registration
  persists + arms the gate, assertion verifies + bumps the persisted counter,
  replay is rejected (single-use), TTL expiry burns the challenge, a
  wrong-challenge guess does NOT burn the pending one, bad signature /
  wrong origin rejected, unknown credential refused, env-off ceremonies
  refuse to run, bootstrap-once (unauthorized begin refused before and after
  bootstrap with the two distinct codes), revoke (unknown id 404, partial +
  last-revoke behavior, gate disarms at zero).

## Deviations & judgment calls

- **Unlock cookie age = 12 h.** Spec said "short-lived" without a number; half
  a working day keeps the passkey meaningful while not nagging on every
  reload. Documented in `lib/web-auth.ts`.
- **Section placed in the Safety tab**, not a new settings tab — avoids the
  `SettingsTabs.tsx` conflict hot-spot entirely (it is untouched) and the
  section self-hides via the status route.
- **Challenge burn semantics:** a MATCHING challenge is consumed before
  verification (a failed verify still burns it — the client restarts the
  ceremony); a non-matching guess leaves the pending challenge intact. Tests
  pin both directions.
- **UV is required** (both options and verify), whereas "preferred" would
  accept presence-only taps. The feature's promise is biometric/PIN unlock.
- **`/device-lock` page** (not in the written spec, implied by "page requests
  require a registered passkey gate"): locked pages need somewhere to run the
  assertion; the proxy exempts exactly that path plus `/api/device-lock/*`.
- Static assets + manifest exceptions untouched (matcher unchanged, plus a
  comment noting /device-lock rides the same shell assets).

## AGENTS.md-ready section (for Phase 13's final docs pass)

### Device-local lock (`lib/device-lock*.ts`, `/api/device-lock/*`, `proxy.ts`, `/device-lock`)
- **Off by default and off unless `OMP_WEB_DEVICE_LOCK === "1"`** — every
  route, the proxy block, and the settings section are gated on it; the unset
  env app is byte-identical (tests pin the matrix + source-level gating).
- The gate is an additional passkey layer in FRONT of password auth: pages
  redirect to `/device-lock`, APIs 401 `device_locked`; exemptions are
  `/device-lock`, `/api/device-lock/*` (self-authorizing: bootstrap-once
  loopback-only first credential, then verified-unlock) and
  `/api/web-auth/session` while `OMP_WEB_PASSWORD` is set.
- Credentials live in `~/.omp/agent/web-authz.json` (0600, atomic, `version`
  field, corrupt files quarantined to `.bak-<ts>`, cap 20). It also holds the
  `unlockKey` random secret that HMAC-signs the short-lived (12 h)
  `omp_web_unlock` cookie minted after a successful WebAuthn verify — never a
  password. Challenges: memory only, 2-min TTL, single-use. UV required on
  both ceremonies; counters persisted (replay defense).
- rpID/origin derive from the request host — per-device passkeys per origin;
  any reachable device may register AFTER bootstrap (the point), proxied
  bootstrap is blocked. Recovery from lock-out: delete web-authz.json on the
  server and restart (documented in the UI, the revoke response, and the
  store header).
- Settings → Safety renders `components/DeviceLockConfig.tsx`, which fetches
  `/api/device-lock/status` and renders NOTHING unless `enabled` — in the
  default app it is invisible. `@simplewebauthn/server` + `/browser` are the
  wave's only new runtime deps (pure JS).
