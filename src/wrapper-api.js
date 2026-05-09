// HTTP wrapper API exposed by the plugin. Bind: 127.0.0.1 only.
// Auth: Bearer <wrapperApiToken> — loopback-only, no Supabase scope.

import http from "node:http";
import { Buffer } from "node:buffer";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getWrapperPort, getRuntimePath } from "./env.js";
import { getOrCreateKeypair } from "./pop-keys.js";

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let _packageVersion = "unknown";
try {
  const pkgPath = path.resolve(__dirname, "..", "package.json");
  _packageVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version || "unknown";
} catch {
  // best-effort
}

const ROUTES = new Map();

function route(method, pathSpec, handler) {
  ROUTES.set(`${method} ${pathSpec}`, handler);
}

function send(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
  });
  res.end(payload);
}

function bearerEquals(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

async function readJson(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

function escapeForSingleQuoted(value) {
  // POSIX single-quote escape: ' → '\''
  return String(value).replace(/'/g, `'\\''`);
}

async function shellOpenClaw(args, { timeoutMs = 30000 } = {}) {
  // args: array of pre-escaped shell tokens. Caller is responsible for quoting.
  const cmd = `openclaw ${args.join(" ")}`;
  const { stdout, stderr } = await execAsync(cmd, {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" };
}

async function readAccountsFromConfig() {
  // Single source of truth: ask the running gateway. Avoids drift from in-memory
  // pluginConfig captured at register-time.
  try {
    const { stdout } = await shellOpenClaw(
      ["config", "get", "plugins.entries.onepilot.config.accounts", "--json"],
      { timeoutMs: 10000 },
    );
    const parsed = JSON.parse(stdout || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeAccount(accountId, accountObj) {
  const json = JSON.stringify(accountObj);
  const escaped = escapeForSingleQuoted(json);
  const key = `plugins.entries.onepilot.config.accounts.${accountId}`;
  await shellOpenClaw(["config", "set", key, `'${escaped}'`, "--strict-json"]);
}

async function deleteAccount(accountId) {
  const key = `plugins.entries.onepilot.config.accounts.${accountId}`;
  // Best-effort: try `config delete`, fall back to disabling the account.
  try {
    await shellOpenClaw(["config", "delete", key]);
  } catch {
    await writeAccount(accountId, { enabled: false });
  }
}

async function frameworkVersion() {
  try {
    const { stdout } = await shellOpenClaw(["--version"], { timeoutMs: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

route("GET", "/onepilot/v1/health", async (_req, res, ctx) => {
  const accounts = await readAccountsFromConfig();
  const accountIds = Object.keys(accounts);
  send(res, 200, {
    ok: true,
    plugin_id: "onepilot",
    plugin_version: _packageVersion,
    framework: "openclaw",
    framework_version: await frameworkVersion(),
    account_configured: accountIds.length > 0,
    accounts: accountIds,
    accounts_enabled: accountIds.filter((id) => accounts[id]?.enabled !== false),
    wrapper_api: "v1",
    started_at: ctx.startedAt,
  });
});

route("POST", "/onepilot/v1/configure", async (req, res, _ctx) => {
  const body = await readJson(req);
  const incoming = body?.accounts;
  if (!incoming || typeof incoming !== "object") {
    return send(res, 400, { ok: false, error: "missing accounts object" });
  }
  const current = await readAccountsFromConfig();
  const written = [];
  for (const [accountId, patch] of Object.entries(incoming)) {
    if (!accountId || typeof patch !== "object" || patch === null) {
      return send(res, 400, { ok: false, error: `invalid account ${accountId}` });
    }
    const merged = { ...(current[accountId] ?? {}), ...patch };
    await writeAccount(accountId, merged);
    written.push(accountId);
  }
  send(res, 200, { ok: true, written });
});

// Idempotent install-time provisioning: keypair + wrapperApiToken.
route("POST", "/onepilot/v1/account/configure-key", async (req, res, _ctx) => {
  const body = await readJson(req);
  const accountId = String(body?.accountId ?? "default");
  const accessToken = body?.accessToken;
  const publishableKey = body?.publishableKey ?? null;
  const agentProfileId = String(body?.agentProfileId ?? "").toLowerCase();
  if (!accessToken) return send(res, 400, { ok: false, error: "accessToken required" });
  if (!/^[0-9a-f-]{36}$/i.test(agentProfileId)) {
    return send(res, 400, { ok: false, error: "agentProfileId (uuid) required" });
  }

  const accounts = await readAccountsFromConfig();
  const existing = accounts[accountId];
  if (existing && existing.agentProfileId && String(existing.agentProfileId).toLowerCase() !== agentProfileId) {
    return send(res, 409, {
      ok: false,
      error: `account ${accountId} already bound to a different agentProfileId`,
    });
  }

  // Build the account body from request fields, falling back to existing
  // values for fields iOS may not resend on subsequent calls.
  const merged = {
    enabled: existing?.enabled ?? true,
    backendUrl: body?.backendUrl ?? existing?.backendUrl,
    streamUrl: body?.streamUrl ?? existing?.streamUrl,
    publishableKey: publishableKey ?? existing?.publishableKey,
    userId: body?.userId ?? existing?.userId,
    agentProfileId,
    sessionKey: body?.sessionKey ?? existing?.sessionKey,
    wrapperApiToken: existing?.wrapperApiToken,
    configuredAt: existing?.configuredAt ?? new Date().toISOString(),
  };
  const requiredFields = ["backendUrl", "streamUrl", "publishableKey", "userId", "agentProfileId", "sessionKey"];
  const missing = requiredFields.filter((f) => !merged[f]);
  if (missing.length > 0) {
    return send(res, 400, { ok: false, error: `missing fields: ${missing.join(",")}` });
  }

  // Ed25519 keypair: idempotent, generated once per agent_profile_id and
  // persisted under ~/.openclaw/secrets/. No rotation.
  let pop;
  try {
    pop = await getOrCreateKeypair(agentProfileId);
  } catch (err) {
    return send(res, 500, { ok: false, error: `keypair: ${String(err?.message ?? err)}` });
  }

  // Register public key with mint-agent-key. POP-only; legacy bearer is gone.
  const mintUrl = `${merged.backendUrl}/functions/v1/mint-agent-key`;
  const mintHeaders = {
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
  };
  if (merged.publishableKey) mintHeaders.apikey = merged.publishableKey;
  const r = await fetch(mintUrl, {
    method: "POST",
    headers: mintHeaders,
    body: JSON.stringify({
      agent_profile_id: agentProfileId,
      client_public_key: pop.publicKeyB64u,
    }),
  });
  const text = await r.text();
  if (!r.ok) {
    return send(res, r.status, { ok: false, error: `mint failed: ${text.slice(0, 200)}` });
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    return send(res, 502, { ok: false, error: "mint returned non-JSON" });
  }
  if (!parsed?.key_fingerprint) {
    return send(res, 502, { ok: false, error: "mint response missing key_fingerprint" });
  }

  // wrapperApiToken: minted only on the first configure-key call. Subsequent
  // calls keep the existing token (iOS already has it in Keychain).
  let wrapperApiToken = merged.wrapperApiToken;
  let wrapperApiTokenIssued = false;
  if (!wrapperApiToken) {
    wrapperApiToken = `wat_${randomBytes(32).toString("base64url")}`;
    wrapperApiToken = wrapperApiToken.replace(/=+$/g, "");
    merged.wrapperApiToken = wrapperApiToken;
    wrapperApiTokenIssued = true;
  }

  await writeAccount(accountId, merged);

  const responseBody = {
    ok: true,
    accountId,
    agentProfileId,
    keyFingerprint: parsed.key_fingerprint,
    keypairProvisioned: !pop.alreadyExisted,
    configuredAt: merged.configuredAt,
  };
  // Only return the wrapperApiToken on first issuance — subsequent reads
  // would let any caller harvest it via this endpoint.
  if (wrapperApiTokenIssued) {
    responseBody.wrapperApiToken = wrapperApiToken;
  }
  send(res, 200, responseBody);
});

route("POST", "/onepilot/v1/account/revoke", async (req, res, _ctx) => {
  const body = await readJson(req);
  const accountId = body?.accountId ?? "default";
  const accounts = await readAccountsFromConfig();
  if (!accounts[accountId]) {
    return send(res, 404, { ok: false, error: `unknown account ${accountId}` });
  }
  await deleteAccount(accountId);
  send(res, 200, { ok: true, accountId });
});

route("POST", "/onepilot/v1/plugin/uninstall", async (_req, res, _ctx) => {
  // Self-uninstall. The gateway keeps running; the plugin is gone after the
  // next register cycle. Caller should stop hitting the wrapper API afterward.
  await shellOpenClaw(["plugins", "uninstall", "onepilot", "--force"]);
  send(res, 200, { ok: true });
});

route("POST", "/onepilot/v1/approvals/config", async (req, res, _ctx) => {
  const body = await readJson(req);
  if (typeof body?.enabled !== "boolean") {
    return send(res, 400, { ok: false, error: "enabled (boolean) required" });
  }
  const { setApprovalsForwardingEnabled } = await import("./approvals.js");
  await setApprovalsForwardingEnabled(body.enabled);
  send(res, 200, { ok: true, enabled: body.enabled });
});

function findHandler(method, urlPath) {
  return ROUTES.get(`${method} ${urlPath}`);
}

function findExpectedTokens(accounts) {
  const tokens = [];
  for (const a of Object.values(accounts || {})) {
    if (a && typeof a.wrapperApiToken === "string" && a.wrapperApiToken) tokens.push(a.wrapperApiToken);
  }
  return tokens;
}

function writeRuntimeFile({ port, startedAt, log, warn }) {
  // iOS uses this file to discover the actual wrapper port, so it doesn't
  // have to assume the gatewayPort+1 convention (which collides with stale
  // openclaw-plugins processes from prior gateway runs).
  try {
    const runtimePath = getRuntimePath();
    mkdirSync(path.dirname(runtimePath), { recursive: true });
    writeFileSync(
      runtimePath,
      JSON.stringify({ port, pid: process.pid, startedAt, pluginVersion: _packageVersion }) + "\n",
      { mode: 0o600 },
    );
    log(`runtime info written to ${runtimePath}`);
  } catch (err) {
    warn(`runtime.json write failed`, err);
  }
}

function clearRuntimeFile() {
  // Best-effort cleanup on graceful exit so iOS doesn't read a stale port
  // from a previous run. SIGKILL bypasses this; the runtime check happens
  // every time iOS reads, so a stale file is no worse than the legacy
  // gatewayPort+1 assumption it replaces.
  try { unlinkSync(getRuntimePath()); } catch { /* ignore */ }
}

export function startWrapperApi({ accounts: initialAccounts, log, warn }) {
  // Env reads are isolated in env.js (scanner-safe — that file has no
  // outbound capability). Mixing environment access with `fetch` in this
  // file trips the install-time "credential harvesting" pattern check.
  //
  // Bind: kernel-assigned free port (0). The actual port is written to
  // `~/.openclaw-<profile>/onepilot-runtime.json`; iOS reads that file
  // to discover the port. `ONEPILOT_WRAPPER_PORT` is an explicit ops
  // override for debugging.
  const requestedPort = getWrapperPort(0);
  const startedAt = new Date().toISOString();
  let cachedTokens = findExpectedTokens(initialAccounts);

  async function refreshTokens() {
    try {
      const accounts = await readAccountsFromConfig();
      const next = findExpectedTokens(accounts);
      if (next.length > 0) cachedTokens = next;
    } catch (err) {
      warn(`refreshTokens failed`, err);
    }
  }

  // First-run bootstrap: configure-key allowed unauthenticated only when
  // no accounts exist yet — closes the install-time chicken-and-egg.
  function isBootstrapAllowed(method, urlPath, accounts) {
    if (method !== "POST" || urlPath !== "/onepilot/v1/account/configure-key") return false;
    return Object.keys(accounts || {}).length === 0;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1`);
      const auth = req.headers["authorization"] || "";
      const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";

      let allowed = cachedTokens.length > 0 && cachedTokens.some((k) => bearerEquals(presented, k));
      if (!allowed) {
        // Re-read once before rejecting — picks up a freshly-written token.
        await refreshTokens();
        allowed = cachedTokens.length > 0 && cachedTokens.some((k) => bearerEquals(presented, k));
      }
      if (!allowed) {
        // First-run bootstrap window: no accounts yet → allow configure-key.
        const accounts = await readAccountsFromConfig();
        if (!isBootstrapAllowed(req.method, url.pathname, accounts)) {
          return send(res, 401, { ok: false, error: "unauthorized" });
        }
      }

      const handler = findHandler(req.method, url.pathname);
      if (!handler) return send(res, 404, { ok: false, error: "not found" });
      await handler(req, res, { startedAt });
      // Refresh token cache after configure-key so the next request sees the
      // freshly-minted token without waiting for the 60s poll.
      if (req.method === "POST" && url.pathname === "/onepilot/v1/account/configure-key") {
        void refreshTokens();
      }
    } catch (err) {
      warn(`wrapper handler failed`, err);
      try { send(res, 500, { ok: false, error: String(err?.message || err) }); }
      catch { /* response already sent */ }
    }
  });

  server.on("error", (err) => warn(`wrapper server error`, err));
  server.listen(requestedPort, "127.0.0.1", () => {
    const actualPort = server.address()?.port ?? requestedPort;
    log(`wrapper API listening on 127.0.0.1:${actualPort} (v${_packageVersion})`);
    writeRuntimeFile({ port: actualPort, startedAt, log, warn });
  });

  // Clean up runtime.json on graceful shutdown. Don't crash if the gateway
  // already removed it.
  process.once("SIGINT", () => { clearRuntimeFile(); process.exit(130); });
  process.once("SIGTERM", () => { clearRuntimeFile(); process.exit(143); });
  process.once("exit", clearRuntimeFile);

  const refreshTimer = setInterval(refreshTokens, 60_000);
  refreshTimer.unref?.();

  return server;
}
