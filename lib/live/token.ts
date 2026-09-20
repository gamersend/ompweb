/**
 * Server-side token plumbing for the Codex live voice lane.
 *
 * PROTOCOL FINDING (probed omp 18.2.6, 2026-09-19): omp's CLI already exposes
 * the ChatGPT Codex OAuth credential its TUI `/live` voice uses —
 * `omp token openai-codex` prints the current access token (a bare JWT on
 * stdout, refreshed by omp itself when near expiry; `--force-refresh` forces
 * it) and `omp token openai-codex --list` prints the stored accounts as
 * "<n>. <email> (<plan>)" lines. That is why ompweb implements NO OAuth of
 * its own: no device flow, no refresh-token store, nothing to rotate. Per the
 * task contract, the omp-exposed path is preferred over reimplementing OAuth,
 * and it keeps the skill's "one credential store per app" boundary intact —
 * ompweb shells the user's own omp and holds the token only in memory for the
 * length of one signaling exchange. It is never written to disk, never logged,
 * and never sent to the browser.
 *
 * ompweb never reads omp's agent.db / credential stores directly — only this
 * fixed-argv CLI surface, exactly like /api/plugins shells `omp plugin` and
 * /api/provider-usage shells `omp usage --json --redact`.
 */

import { execFile } from "child_process";

import { OMP_CODEX_PROVIDER } from "./protocol";
import { resolveOmpBin } from "@/lib/omp/omp-cli";

export class LiveTokenError extends Error {
  constructor(
    readonly code: "omp_unavailable" | "live_unauthorized",
    message: string,
  ) {
    super(message);
    this.name = "LiveTokenError";
  }
}

/** The account metadata the UI may see — no token fields, ever. */
export interface CodexAccount {
  email: string;
  plan: string;
}

function runOmp(args: string[], timeoutMs: number): Promise<string> {
  const bin = resolveOmpBin();
  if (!bin) {
    return Promise.reject(new LiveTokenError("omp_unavailable", "omp binary not found on PATH"));
  }
  return new Promise<string>((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || error.message || "").trim().slice(0, 200);
        reject(new LiveTokenError("live_unauthorized", detail || `omp token failed (${error.code ?? "error"})`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * The access token for one signaling exchange, obtained fresh from the user's
 * own omp install. omp refreshes it when near expiry; no caching here, because
 * a token is only needed once per call and a cached one could outlive a
 * logout. Failures carry a machine code and a bounded message — never the
 * token itself.
 */
export async function getCodexLiveToken(): Promise<{ token: string; accountID: string }> {
  let out: string;
  try {
    out = await runOmp(["token", OMP_CODEX_PROVIDER], 15_000);
  } catch (err) {
    if (err instanceof LiveTokenError) throw err;
    throw new LiveTokenError("live_unauthorized", err instanceof Error ? err.message : String(err));
  }
  const token = out.trim();
  if (!token || /\s/.test(token)) {
    throw new LiveTokenError("live_unauthorized", "omp token output was empty or malformed");
  }
  return { token, accountID: claimsFromJwt(token).accountID };
}

/**
 * The stored Codex accounts (email + plan) for the status route. Uses
 * `--list`, which prints account metadata only — this command cannot leak a
 * token even if its output were forwarded verbatim.
 */
export async function listCodexAccounts(): Promise<CodexAccount[]> {
  const out = await runOmp(["token", OMP_CODEX_PROVIDER, "--list"], 15_000);
  return parseCodexAccountList(out);
}

/** Parse `omp token <provider> --list` output: "<n>. <email> (<plan>)" lines. */
export function parseCodexAccountList(out: string): CodexAccount[] {
  const accounts: CodexAccount[] = [];
  for (const line of out.split(/\r?\n/)) {
    const match = line.match(/^\s*\d+\.\s+(\S+@\S+)\s+\(([^)]*)\)\s*$/);
    if (match) {
      accounts.push({ email: match[1] ?? "", plan: match[2]?.trim() ?? "" });
    }
  }
  return accounts;
}

/**
 * Decode only the JWT claims ompweb needs (account id) from the token omp
 * handed over. Mirrors the claim structure every Codex token carries; a
 * non-JWT token is tolerated — the account header is simply omitted and the
 * route proceeds, because firedeck's accepted path only attaches
 * `chatgpt-account-id` when it is known.
 */
export function claimsFromJwt(token: string): { accountID: string } {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return { accountID: "" };
    const payload = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    const auth = payload["https://api.openai.com/auth"] ?? {};
    return {
      accountID: typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : "",
    };
  } catch {
    return { accountID: "" };
  }
}
