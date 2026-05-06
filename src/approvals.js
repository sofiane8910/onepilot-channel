// Approval forwarding bridge.
//
// OpenClaw's exec-approval-forwarder routes exec-approval requests to
// configured channel targets via the channel's `outbound.sendText`. The
// payload carries the canonical marker `channelData.execApproval =
// { approvalId, approvalSlug, allowedDecisions }` (see
// openclaw/src/infra/exec-approval-reply.ts:120). When the marker is
// present, this module hijacks the outbound and broadcasts an
// `approval_requested` event on the iOS Supabase Realtime channel so
// Onepilot can render an actionable bubble.
//
// Decision flow (no out-of-band IPC):
//   iOS bubble tap → app posts a chat message containing the literal
//   `/approve <id> <decision>` text into Supabase. The plugin's existing
//   inbound subscriber dispatches it to the gateway as a regular user
//   message; OpenClaw's auto-reply pipeline (commands-approve.ts) matches
//   `/approve …` and calls `exec.approval.resolve` JSON-RPC against the
//   in-process ExecApprovalManager. No CLI, no socket, no upstream forks.

import { broadcast } from "./progress.js";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ENABLED_FLAG_FILE = path.join(
  process.env.HOME || "/tmp",
  ".openclaw-onepilot",
  "approvals.enabled",
);

const BACKUP_FILE = path.join(
  process.env.HOME || "/tmp",
  ".openclaw-onepilot",
  "approvals.backup.json",
);

/**
 * Resolve the active OpenClaw config path. The gateway is normally launched
 * with `--profile <name>` which sets OPENCLAW_CONFIG_PATH; we honor that
 * first, then fall back to walking up from this file's location
 * (`<stateDir>/plugins/openclaw-onepilot-channel/src/approvals.js` →
 * `<stateDir>/openclaw.json`). That's reliable because the plugin is
 * always installed inside the active profile's state dir.
 */
function resolveConfigPath() {
  const env = process.env;
  if (env.OPENCLAW_CONFIG_PATH) return env.OPENCLAW_CONFIG_PATH;
  const here = fileURLToPath(import.meta.url);
  // here = .../<stateDir>/plugins/<plugin>/src/approvals.js → up 3 → <stateDir>
  const stateDir = path.resolve(path.dirname(here), "..", "..", "..");
  return path.join(stateDir, "openclaw.json");
}

// Pre-v0.9 migration helpers. Approvals are now enforced by the plugin's
// `before_tool_call` hook (see approvals-gate.js); upstream openclaw.json is
// no longer touched. Helpers below only run on hosts that still have a
// backup file from the old approach.

function setDeep(obj, dottedPath, value) {
  const keys = dottedPath.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== "object") cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

const TRACKED_PATHS = [
  "tools.exec.security",
  "tools.exec.ask",
  "approvals.exec.enabled",
  "approvals.exec.mode",
  "approvals.exec.targets",
];

/**
 * One-time migration: pre-v0.9 versions of this plugin patched
 * tools.exec.* + approvals.exec.* into openclaw.json on toggle ON. v0.9
 * dropped that approach (we own the gate via before_tool_call). On hosts
 * upgrading from v0.5–v0.8, restore the saved-pre-toggle values from
 * BACKUP_FILE so the user's openclaw.json returns to the state it was in
 * before they ever turned approvals on. Idempotent — no-op when no
 * backup file exists.
 */
async function migratePreV09Config(log) {
  let backup;
  try {
    backup = JSON.parse(await fs.readFile(BACKUP_FILE, "utf8"));
  } catch {
    return; // no migration needed
  }
  if (!backup || typeof backup !== "object") return;

  const cfgPath = resolveConfigPath();
  let cfg;
  try {
    cfg = JSON.parse(await fs.readFile(cfgPath, "utf8"));
  } catch {
    return;
  }
  for (const p of TRACKED_PATHS) {
    if (Object.prototype.hasOwnProperty.call(backup, p)) {
      setDeep(cfg, p, backup[p]);
    } else {
      const keys = p.split(".");
      let cur = cfg;
      for (let i = 0; i < keys.length - 1; i++) cur = cur?.[keys[i]];
      if (cur && typeof cur === "object") delete cur[keys[keys.length - 1]];
    }
  }
  if (cfg?.tools?.exec && Object.keys(cfg.tools.exec).length === 0) delete cfg.tools.exec;
  if (cfg?.tools && Object.keys(cfg.tools).length === 0) delete cfg.tools;
  if (cfg?.approvals?.exec && Object.keys(cfg.approvals.exec).length === 0) delete cfg.approvals.exec;
  if (cfg?.approvals && Object.keys(cfg.approvals).length === 0) delete cfg.approvals;

  const tmp = cfgPath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), "utf8");
  await fs.rename(tmp, cfgPath);
  await fs.unlink(BACKUP_FILE).catch(() => {});
  log?.("migrated: restored pre-v0.9 openclaw.json from backup");
}

/**
 * Returns true when the user has opted into approval forwarding via the
 * iOS wizard / agent detail toggle. Default false. Flipped via
 * `bin/approvals-cli.js enable|disable`, called from the iOS adapter.
 */
export async function isApprovalsForwardingEnabled() {
  try {
    await fs.access(ENABLED_FLAG_FILE);
    return true;
  } catch {
    return false;
  }
}

export async function setApprovalsForwardingEnabled(enabled, opts = {}) {
  const dir = path.dirname(ENABLED_FLAG_FILE);
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  if (enabled) {
    await fs.writeFile(ENABLED_FLAG_FILE, String(Date.now()), "utf8");
  } else {
    await fs.unlink(ENABLED_FLAG_FILE).catch(() => {});
  }
  // One-shot upgrade migration from pre-v0.9 hosts that had openclaw.json
  // patched. Pure no-op when no backup file is present.
  await migratePreV09Config(opts.log).catch((err) => {
    opts.log?.(`pre-v0.9 migration failed (toggle still recorded in flag file)`, err);
  });
}

/**
 * Detect an exec-approval payload by the canonical upstream marker
 * `channelData.execApproval`. The forwarder always sets this — see
 * openclaw/src/infra/exec-approval-reply.ts:120 (buildExecApprovalPendingReplyPayload).
 */
export function extractApproval(ctx) {
  const channelData =
    ctx?.payload?.channelData ||
    ctx?.message?.channelData ||
    ctx?.channelData ||
    null;
  return channelData?.execApproval || null;
}

/**
 * Channel outbound hook. Returns true if the payload was an approval and
 * we handled it (caller MUST NOT forward as a regular text message).
 * Returns false to let the regular sendOnepilotText path run.
 *
 * `lookupSessionId(accountId, sessionKey)` is injected by the caller to
 * resolve the Supabase session UUID from the upstream `to` (sessionKey).
 * Required because the outbound ctx only exposes `to: <sessionKey>` while
 * iOS subscribes to `messages_<sessionId-UUID-prefix>`.
 */
export async function maybeHandleApproval({ ctx, account, log, lookupSessionId, fetchLatestSessionId }) {
  const approval = extractApproval(ctx);
  if (!approval) return false;
  const enabled = await isApprovalsForwardingEnabled();
  if (!enabled) {
    log?.(`approval received but forwarding disabled — dropping (default off) id=${String(approval.approvalId).slice(0, 8)}`);
    return true;
  }

  // Resolve the Supabase session UUID. Cache hit (recent inbound user
  // message) is the hot path. Cold start fallback queries Supabase for the
  // most recent session row matching this account. Last-resort: skip the
  // broadcast (we'd land on the wrong channel anyway).
  const sessionKey = ctx?.to || ctx?.payload?.sessionKey || account?.sessionKey || "main";
  const accountId =
    ctx?.accountId ||
    ctx?.payload?.accountId ||
    account?.accountId ||
    "default";

  let sessionId = null;
  if (typeof lookupSessionId === "function") {
    sessionId = lookupSessionId(accountId, sessionKey);
  }
  if (!sessionId && typeof fetchLatestSessionId === "function") {
    try { sessionId = await fetchLatestSessionId(account, sessionKey); } catch {}
  }
  if (!sessionId) {
    log?.(`approval ${String(approval.approvalId).slice(0, 8)}: no sessionId for sessionKey="${sessionKey}" — skipping broadcast (iOS won't receive). Open chat in iOS first or send any message to populate the cache.`);
    return true; // still return true so the upstream doesn't fall back to plain text
  }

  const text = ctx?.payload?.text || ctx?.message?.text || "";

  // Mirror the schema in onepilot-hermes-chat/approvals.py and the iOS
  // ApprovalRequest decoder. Keep the keys snake_case so both plugins
  // hit one decoder.
  const body = {
    approval_id: String(approval.approvalId || ""),
    approval_slug: String(approval.approvalSlug || ""),
    framework: "openclaw",
    tool_name: "system.run",
    command: text,
    argv: [],
    cwd: null,
    session_key: sessionId,
    agent_id: null,
    security: "medium",
    expires_at_ms: null,
    allowed_decisions: Array.isArray(approval.allowedDecisions)
      ? approval.allowedDecisions
      : ["allow-once", "allow-always", "deny"],
  };

  // Verbose log so we can diagnose why iOS isn't receiving. Shows the exact
  // channel topic the broadcast goes to — must match `messages_<UUID-prefix>`
  // that iOS computed via Foundation UUID.uuidString.prefix(8).
  const { channelForSession } = await import("./progress.js");
  const topic = channelForSession(sessionId);
  log?.(`approval ${body.approval_id.slice(0, 8)}: sessionKey="${sessionKey}" → sessionId=${String(sessionId).slice(0, 8)} → topic="${topic}"`);
  await broadcast(account, sessionId, "approval_requested", body, log);
  log?.(`forwarded approval_requested id=${body.approval_id.slice(0, 8)} topic=${topic}`);
  return true;
}
