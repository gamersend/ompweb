# Phase 13 — Terminal · agent notes

**Status:** complete. `npm run typecheck` / `npm test` / `npm run lint` green on this tree at time of writing (gate counts in the phase report).

## What landed

| File | Purpose |
|---|---|
| `lib/terminal/terminal-manager.ts` | globalThis registry (`__ompTerminals`) of plain-pipe shell children: spawn (`OMP_WEB_SHELL` → Windows pwsh.exe→powershell.exe→cmd.exe, POSIX `$SHELL`→/bin/bash→/bin/sh), allow-root cwd validation (same `getAllowedFileRoots()` as /api/files), merged stdout+stderr, NO PTY, 10k-line server scrollback, ≥16 KB/100 ms output coalescing, 10-min idle dispose, 5-min linger for exited entries, `OMP_WEB_DISABLE_TERMINAL=1` kill switch. Pure exports (`capScrollback`, `resolveShellCandidates`, `firstSpawnableCandidate`, `createOutputCoalescer`) are unit-tested. |
| `lib/terminal/herdr-plan.ts` | Pure, DOM-free render-plan ported from firedeck: `planPaneRender` (append→suffix write / reset→rewrite / fingerprint skip), `paneFingerprint`, `createPaneDiffState`, defensive `parsePaneList`, `isValidPaneId` (argv-safe pane ids), `isPaneAttachable`. Client-safe — TerminalTab imports it. |
| `lib/terminal/herdr-attach.ts` | Server runner, env-gated by `OMP_WEB_HERDR_BIN` (default OFF): fixed-argv `pane list --json` / `pane read <id>` / `pane send-text` / `send-keys` / `pane resize`; omp-web-side owner claims on globalThis (`claimHerdrPane`/`releaseHerdrPane`/`isHerdrPaneOwner`). |
| `lib/terminal/audit.ts` | Terminal input audit JSONL at `~/.omp/agent/web-terminal-audit.jsonl`, 1 MB rotate to `.1`, metadata-only rows (ts, terminalId, cwd, bytes, 16-hex content hash — never the keystrokes; typed passwords must not land in a file). |
| `app/api/terminal/route.ts` | `POST {cwd}` → `{success,data:{terminalId,cwd,shell}}` (allow-root + kill-switch + `terminal` flag enforced); `GET ?id=` info; `DELETE ?id=` dispose. |
| `app/api/terminal/[id]/events/route.ts` | SSE per contract: frames `{t:"d",b:<base64>}` (scrollback replay first, then live) and `{t:"exit",code}`; 30 s heartbeat; `req.signal` abort + stream cancel both clean up exactly once; unknown id → 404 JSON. |
| `app/api/terminal/[id]/input/route.ts` | `POST {data}` (≤64 KB, bounded body read); audit row appended BEFORE delivery; `terminal_not_found` 404 / `terminal_exited` 410 codes. |
| `app/api/terminal/herdr/route.ts` | herdr surface (addition beyond the 3 contract routes — the picker needs list/read/send/resize): GET list or `?paneId=` read; POST `claim`/`release`/`send-text`/`send-keys`/`resize`; writes 403 `herdr_not_owner` without an omp-web owner claim; everything 403 `herdr_disabled` without the env var. |
| `components/TerminalTab.tsx` | xterm.js tab (lazy-mounted via `next/dynamic, ssr:false` from RightPanel — xterm never enters the initial bundle). Token-built theme (palette read from live CSS vars at mount + on theme flip), font follows `useFontSize`, ResizeObserver + FitAddon refit, focus only while `active`. Key encoding goes through `lib/terminal-input.ts`'s `toTerminalKeyData` (its full-terminal home); paste wraps `asBracketedPaste`. Plain-mode banner (no-PTY limitation + herdr hint), herdr pane picker dialog, read-only watch mode (800 ms poll + `planPaneRender`), owner attach (input + resize sync), restart/detach controls, dispose-on-unmount (`DELETE /api/terminal`). |
| `components/RightPanel.tsx` | `RightPanelView` gains `"terminal"`; pinned Terminal tab wired into TabBar; terminal view kept mounted after first open (shell survives tab switches; idle dispose is the backstop). |
| `components/TabBar.tsx` | Pinned Terminal tab (`SquareTerminal` icon) after Git — additive props (`terminalSelected`/`onSelectTerminal`), hidden when the callback is absent (flag guard). Coordinated with P10's dirty dots, no overlap. |
| `components/AppShell.tsx` | `rightView` state now typed as `RightPanelView` (no parallel union). Default cwd for the terminal = active session cwd via `activeCwd` prop that already flows to RightPanel. |
| `lib/feature-flags.ts` (+ test) | `terminal` default ON; `OMP_WEB_DISABLE_TERMINAL=1` disarms it (kill switch wins over the flags union). `herdrAttach` unchanged (env-gated). |
| `lib/i18n/locales/{en,zh-CN,ja}.json` | `terminal.*` namespace, 25 keys ×3. |
| Tests: `lib/terminal/{terminal-manager,herdr-plan,audit,routes}.test.mjs` | Real-shell echo round trip (cmd.exe on this host / sh on POSIX), natural-exit frame + registry linger, dispose, globalThis registry survival, coalescer timing, scrollback cap, kill switch, allow-root rejection, route contract (SSE frames, audited input with metadata-only rows, DELETE), herdr disabled-gating + owner-gate, render-plan + pane-list pure tests. `package.json` test glob extended with `lib/terminal/*.test.mjs`. |

## Deviations & judgment calls (for AGENTS.md review)

- **Key encoding**: the plan's contract says input carries "escape seqs from lib/terminal-input.ts". In practice xterm.js's `onData` emits the same escape sequences for printable/IME input, so TerminalTab routes *chords and special keys* through `toTerminalKeyData` (intercepted in `attachCustomKeyEventHandler`, xterm skips them) and lets xterm handle the printable/IME remainder. `asBracketedPaste` wraps every paste — a plain pipe cannot negotiate bracketed paste mode itself. `lib/terminal-input.ts` remains the bash tool's DOM-key encoder too.
- **Audit content**: rows are metadata + a truncated SHA-256 of the batch, deliberately NOT the raw bytes (keystrokes include passwords). "Audit every input batch" is honored; content-addressability keeps batches recognizable.
- **herdr ownership**: herdr's exact `pane list --json` schema is unknown here; parsing is defensive (bare array or `{panes}`, title/name, cwd/dir, session/sessionName, owner/ownerSession aliases; junk → `[]`). Ownership = herdr-reported owner (attach refused when set) ∩ omp-web-side claim set; writes require the claim; watch is read-only. Adjust field names when herdr's real contract is confirmed.
- **Extra route**: `app/api/terminal/herdr/route.ts` is added beyond the plan's 3 named routes because the pane picker/read poll/write commands need their own surface; it reuses the same envelope + gating discipline.
- **No PTY / resize**: plain mode has no TTY size signaling (documented trap) — resize only exists in herdr mode (`pane resize`). The banner states the TUI limitation.
- **Exited terminals linger** in the registry 5 min so a reconnecting SSE client still gets the exit frame; explicit DELETE removes immediately. Idle dispose is 10 min, matching rpc-manager.

## AGENTS.md-ready block

### Terminal (`lib/terminal/`, `/api/terminal*`, `components/TerminalTab.tsx`)
- The right panel's pinned Terminal tab spawns a real shell (no PTY) in the
  session cwd: plain pipes both ways, merged stdout+stderr, 10k-line server
  scrollback replayed to new SSE subscribers, ≥16 KB/100 ms flush coalescing,
  10-min idle dispose. Full-screen TUI apps are unsupported in this mode —
  the UI banner says so; `OMP_WEB_HERDR_BIN` enables herdr pane attach
  (watch read-only / attach-as-owner interactive) for those.
- Safety model: spawn cwd must pass the SAME allow-roots as `/api/files`;
  fixed shell candidates only (`OMP_WEB_SHELL` override → platform probe);
  user input goes to the shell's stdin, never into argv; every input batch
  is audited to `~/.omp/agent/web-terminal-audit.jsonl` (metadata + content
  hash, 1 MB rotate — never the keystrokes); `OMP_WEB_DISABLE_TERMINAL=1`
  is the kill switch (hides the tab AND refuses spawns); the `terminal`
  feature flag defaults ON and cannot be turned off except by that switch.
- Key input: chords/special keys encode via `lib/terminal-input.ts`
  (`toTerminalKeyData`); paste wraps `asBracketedPaste`; xterm's `onData`
  carries printable/IME text. Terminal font size follows the chat font-size
  setting; the xterm palette is built from design tokens at render time.
- The manager (`lib/terminal/terminal-manager.ts`) keeps its registry on
  `globalThis` (`__ompTerminals`) exactly like `rpc-manager` — hot reload
  must not orphan shell children. Exited terminals linger 5 min so late SSE
  subscribers observe the exit.
