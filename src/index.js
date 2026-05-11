// Onepilot plugin for OpenClaw — bridges app messages to/from the agent.

import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { startStreamSubscription } from "./stream.js";
import { handleUserMessage } from "./messaging.js";
import { sendOnepilotText } from "./outbound.js";
import { maybeHandleApproval } from "./approvals.js";
import { buildBeforeToolCallHook } from "./approvals-gate.js";
import { createUpstreamApprovalsBridge } from "./approvals-gate-upstream.js";
import { buildToolResultPersistHook } from "./approvals-context.js";
import { signAuthHeader } from "./pop-keys.js";
import { startWrapperApi } from "./wrapper-api.js";
import { isGatewayMode } from "./env.js";

// One subscription / channel registration per process — register() can fire
// multiple times and we need to dedupe to avoid duplicate inserts.
const _activeSubscriptions = new Map();
let _channelRegistered = false;
let _wrapperApiStarted = false;

// Per-account map: sessionKey -> sessionId (Supabase row UUID). Updated on
// every inbound user-message row. Approval forwarding reads from this map
// because the channel outbound `ctx` exposes `to: <sessionKey>` only — it
// has no idea about Supabase row UUIDs. Without this lookup, the broadcast
// would land on `messages_<sessionKey>` and iOS (subscribed to
// `messages_<sessionId-UUID>`) would never receive it.
const _sessionIdBySessionKey = new Map(); // accountId -> Map<sessionKey, sessionId>
export function rememberSessionId(accountId, sessionKey, sessionId) {
  if (!accountId || !sessionKey || !sessionId) return;
  let inner = _sessionIdBySessionKey.get(accountId);
  if (!inner) { inner = new Map(); _sessionIdBySessionKey.set(accountId, inner); }
  inner.set(String(sessionKey), String(sessionId));
}
export function lookupSessionId(accountId, sessionKey) {
  return _sessionIdBySessionKey.get(accountId)?.get(String(sessionKey)) ?? null;
}
/**
 * Fallback for the approval gate: when the hook's sessionKey doesn't map
 * to any cached entry (e.g. the hook gives an agent-internal sessionKey
 * shape that the chat side never sees), return any cached sessionId for
 * the account so the broadcast still lands on a channel iOS is listening
 * to. Maps insert in order; we return the most recently inserted.
 */
export function lookupAnySessionForAccount(accountId) {
  const inner = _sessionIdBySessionKey.get(accountId);
  if (!inner || inner.size === 0) return null;
  // Map iteration is insertion order; .values() iterates from oldest. We
  // want most recent — convert to array and pop. Cheap (cache is tiny).
  const arr = Array.from(inner.values());
  return arr[arr.length - 1] ?? null;
}

async function runCatchUp({ account, agentProfileIdLc, sinceMs, log, dispatch }) {
  try {
    const url = `${account.backendUrl}/functions/v1/agent-message-history?mode=recent-user&minutes=10&limit=20`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: signAuthHeader({ agentProfileId: account.agentProfileId, method: "GET", url, scope: "history" }) },
    });
    if (!res.ok) {
      const body = await res.text();
      log(`history fetch failed: ${res.status} ${body.slice(0, 200)}`);
      return;
    }
    const json = await res.json();
    const rows = Array.isArray(json?.messages) ? json.messages : [];
    let dispatched = 0;
    for (const row of rows) {
      if (
        agentProfileIdLc &&
        row.agent_profile_id &&
        String(row.agent_profile_id).toLowerCase() !== agentProfileIdLc
      ) continue;
      const ts = row.created_at ? Date.parse(row.created_at) : 0;
      if (!Number.isFinite(ts) || ts <= sinceMs) continue;
      dispatch(row);
      dispatched++;
    }
    if (dispatched > 0) log(`recovered ${dispatched} missed message(s) on (re)subscribe`);
  } catch (err) {
    log(`catch-up failed`, err);
  }
}

export default definePluginEntry({
  id: "onepilot",
  name: "Onepilot",
  description: "Bridges Onepilot messages to OpenClaw agents.",
  // register MUST be synchronous; async work is fire-and-forget.
  register(api) {
    const pluginConfig = api.pluginConfig ?? {};
    const accounts = pluginConfig.accounts ?? {};
    const accountIds = Object.keys(accounts);

    const log = (msg) => api.logger.info?.(`[onepilot] ${msg}`);
    const warn = (msg, err) => {
      if (err) api.logger.warn?.(`[onepilot] ${msg}: ${String(err)}`);
      else api.logger.warn?.(`[onepilot] ${msg}`);
    };

    log(
      `plugin registered — ${accountIds.length} account(s) configured: ${
        accountIds.join(", ") || "(none)"
      }`,
    );

    const gatewayPort = Number(api.config?.gateway?.port) || 18789;
    const gatewayToken =
      api.config?.gateway?.auth?.token ||
      api.config?.gateway?.http?.auth?.token ||
      "";

    if (!gatewayToken) {
      warn(
        "gateway auth token not found in config — self-fetches to /v1/chat/completions will 401",
      );
    }

    // Approval gate: before any execution-shaped tool runs, broadcast the
    // request to iOS and wait for a `/approve <id> <decision>` reply. We
    // own the gate end-to-end (no upstream exec-approvals dependency, no
    // operator.approvals scope needed). See approvals-gate.js for why.
    // Plugin hooks (typed lifecycle events like `before_tool_call`) are
    // registered via api.on(), NOT api.registerHook() — the latter is for
    // OpenClaw's own internal-events hook system (file-watching, runtime
    // persistence, etc.) and silently no-ops for plugin hook names.
    // Route approvals through upstream's pluginApprovalManager instead of
    // a parallel in-process Map. The gate itself carries a transport-
    // failure fallback (see approvals-gate.js), so a loopback WS hiccup
    // downgrades that one approval to the legacy local map rather than
    // wedging the tool call.
    let upstreamBridge = null;
    try {
      upstreamBridge = createUpstreamApprovalsBridge(api.config, (m, err) => {
        if (err) api.logger.warn?.(`[onepilot:gate-upstream] ${m}: ${String(err)}`);
        else api.logger.info?.(`[onepilot:gate-upstream] ${m}`);
      });
      log("upstream approvals bridge enabled");
    } catch (err) {
      warn("upstream approvals bridge construction failed — falling back to local gate", err);
    }

    if (typeof api.on === "function") {
      const gateLog = (m, err) => {
        if (err) api.logger.warn?.(`[onepilot:gate] ${m}: ${String(err)}`);
        else api.logger.info?.(`[onepilot:gate] ${m}`);
      };
      try {
        const beforeHook = buildBeforeToolCallHook({
          accounts,
          lookupSessionId,
          lookupAnySessionForAccount,
          upstreamBridge,
          log: gateLog,
        });
        api.on("before_tool_call", beforeHook);
        log("registered before_tool_call hook for approval gate (api.on)");
      } catch (err) {
        warn("api.on(before_tool_call) failed — approval gate inert", err);
      }
      try {
        // Persist hook: prepends an "[Onepilot: approved]" marker to the
        // tool's result message AFTER the gate let it run. Lets the model
        // see the gate's existence on its next inference instead of
        // inspecting upstream config and hallucinating "approvals off".
        const persistHook = buildToolResultPersistHook({ log: gateLog });
        api.on("tool_result_persist", persistHook);
        log("registered tool_result_persist hook for approval marker injection");
      } catch (err) {
        warn("api.on(tool_result_persist) failed — marker injection inert", err);
      }
    } else {
      warn("api.on unavailable — OpenClaw too old? approval gate inert");
    }

    // Long-lived servers (wrapper API HTTP + stream subscription) keep the
    // event loop alive. When `openclaw plugins info / install --link` loads
    // the plugin module just to inspect it, starting them wedges the CLI
    // forever — caller never gets control back. Gate on real gateway mode.
    if (!isGatewayMode()) {
      log("plugin loaded outside gateway (likely CLI inspection); skipping wrapper API + subscriptions");
      return;
    }

    if (!_wrapperApiStarted) {
      try {
        startWrapperApi({ accounts, log, warn });
        _wrapperApiStarted = true;
      } catch (err) {
        warn("startWrapperApi failed — iOS configure-key + approvals toggle will be unreachable", err);
      }
    }

    if (!_channelRegistered && typeof api.registerChannel === "function") {
      try {
        const readAccounts = (cfg) =>
          cfg?.plugins?.entries?.onepilot?.config?.accounts ??
          cfg?.plugins?.entries?.onepilot?.accounts ??
          {};

        api.registerChannel({
          plugin: {
            id: "onepilot",
            meta: {
              id: "onepilot",
              label: "Onepilot",
              description: "Delivers to the Onepilot app.",
            },
            config: {
              listAccountIds: (cfg) => Object.keys(readAccounts(cfg)),
              resolveAccount: (cfg, accountId) => {
                const a = readAccounts(cfg)[accountId];
                return a ? { accountId, ...a } : null;
              },
              isEnabled: (account) => account?.enabled !== false,
              resolveDefaultTo: ({ cfg, accountId }) => {
                const entries = readAccounts(cfg);
                const id = accountId ?? Object.keys(entries)[0];
                return entries[id]?.sessionKey ?? "main";
              },
            },
            outbound: {
              deliveryMode: "direct",
              // sendText is required by the channel adapter contract — without
              // it deliver.ts treats the channel as "outbound not configured"
              // (see openclaw/src/infra/outbound/deliver.ts:156). It handles the
              // plain-text path (regular agent replies, cron deliveries, etc.).
              sendText: (ctx) =>
                sendOnepilotText({
                  ctx,
                  accounts,
                  log: (m, err) => {
                    if (err) api.logger.warn?.(`[onepilot:outbound] ${m}: ${String(err)}`);
                    else api.logger.info?.(`[onepilot:outbound] ${m}`);
                  },
                }),
              // sendPayload is invoked instead of sendText when the upstream
              // ReplyPayload carries `channelData` or `interactive` (see
              // deliver.ts:675-690). The approval forwarder sets
              // `channelData.execApproval = { approvalId, approvalSlug,
              // allowedDecisions }` so iOS users can decide via chat bubble.
              sendPayload: async (ctx) => {
                const obLog = (m, err) => {
                  if (err) api.logger.warn?.(`[onepilot:outbound] ${m}: ${String(err)}`);
                  else api.logger.info?.(`[onepilot:outbound] ${m}`);
                };
                const accountId =
                  ctx?.accountId ??
                  ctx?.payload?.accountId ??
                  Object.keys(accounts)[0];
                const account = accounts[accountId];
                if (account) {
                  try {
                    const handled = await maybeHandleApproval({
                      ctx,
                      account,
                      log: obLog,
                      lookupSessionId,
                      fetchLatestSessionId: async (acc, sessionKey) => {
                        // Cold-start fallback: ask agent-message-history for
                        // the most recent matching session. Routed through
                        // the edge function (POP-authenticated) rather than
                        // PostgREST so the plugin host never touches a raw
                        // bearer — the only credential here is the per-host
                        // Ed25519 keypair used by signAuthHeader.
                        const histUrl = `${acc.backendUrl}/functions/v1/agent-message-history?session_key=${encodeURIComponent(sessionKey)}&limit=1`;
                        try {
                          const res = await fetch(histUrl, {
                            headers: {
                              Authorization: signAuthHeader({ agentProfileId: acc.agentProfileId, method: "GET", url: histUrl, scope: "history" }),
                            },
                          });
                          if (!res.ok) return null;
                          const j = await res.json();
                          const sid = Array.isArray(j?.messages) && j.messages[0]?.session_id;
                          if (sid) {
                            rememberSessionId(accountId, sessionKey, sid);
                            return sid;
                          }
                        } catch {}
                        return null;
                      },
                    });
                    if (handled) return { ok: true, deliveredAtMs: Date.now() };
                  } catch (err) {
                    obLog("approval forwarding failed; falling back to text send", err);
                  }
                }
                // Non-approval rich payload — flatten to text and reuse the
                // sendText path. sendOnepilotText only reads ctx.text + identity.
                const flat = { ...ctx, text: ctx?.payload?.text ?? "" };
                return sendOnepilotText({ ctx: flat, accounts, log: obLog });
              },
            },
          },
        });
        _channelRegistered = true;
        log("registered outbound channel `onepilot`");
      } catch (err) {
        warn("registerChannel failed — cron delivery will not work", err);
      }
    } else if (typeof api.registerChannel !== "function") {
      warn("api.registerChannel unavailable — OpenClaw too old? cron delivery will not work");
    }

    const subscriptions = [];

    for (const [accountId, account] of Object.entries(accounts)) {
      if (account?.enabled === false) {
        log(`[${accountId}] disabled, skipping`);
        continue;
      }
      if (_activeSubscriptions.has(accountId)) {
        log(`[${accountId}] subscription already active in this process, skipping (duplicate register call)`);
        continue;
      }
      const missing = [];
      for (const field of ["backendUrl", "streamUrl", "publishableKey", "userId", "agentProfileId", "sessionKey"]) {
        if (!account?.[field]) missing.push(field);
      }
      if (missing.length > 0) {
        warn(`[${accountId}] missing required config fields: ${missing.join(", ")}`);
        continue;
      }

      log(
        `[${accountId}] starting inbound channel subscription ` +
          `user=${String(account.userId).slice(0, 8)} ` +
          `agent=${String(account.agentProfileId).slice(0, 8)}`,
      );

      // Lowercase routing IDs — backend stores canonical lowercase UUIDs.
      const userIdLc = String(account.userId).toLowerCase();
      const agentProfileIdLc = String(account.agentProfileId).toLowerCase();

      // Catch-up high-water mark: highest user-message ts we've dispatched.
      // On every (re)subscribe we ask the backend for newer rows to recover
      // anything that landed during a Realtime gap (broadcast-only, no replay).
      let lastSeenUserAt = 0;
      const catchUpInFlight = { value: false };

      const sub = startStreamSubscription({
        accountId,
        backendUrl: account.backendUrl,
        streamUrl: account.streamUrl,
        publishableKey: account.publishableKey,
        agentProfileId: agentProfileIdLc,
        userId: userIdLc,
        schema: "public",
        table: "messages",
        filter: `user_id=eq.${userIdLc}`,
        onTerminal: ({ reason }) => {
          _activeSubscriptions.delete(accountId);
          warn(`[${accountId}] channel auth permanently failed, evicted — awaiting re-pair`);
          warn(`[${accountId}] reason: ${reason}`);
        },
        onInsert: (row) => {
          if (row?.role !== "user") return;
          if (
            agentProfileIdLc &&
            row.agent_profile_id &&
            String(row.agent_profile_id).toLowerCase() !== agentProfileIdLc
          ) {
            return;
          }
          const ts = row.created_at ? Date.parse(row.created_at) : 0;
          if (Number.isFinite(ts) && ts > lastSeenUserAt) lastSeenUserAt = ts;
          // Cache the sessionKey → sessionId mapping so approval forwarding
          // can broadcast on the channel iOS is actually subscribed to.
          if (row.session_key && row.session_id) {
            rememberSessionId(accountId, row.session_key, row.session_id);
          }
          log(
            `[${accountId}] user message id=${String(row.id ?? "").slice(0, 8)} ` +
              `session=${row.session_key ?? "?"} — dispatching to agent`,
          );
          void handleUserMessage({
            api,
            accountId,
            account,
            userMessageRow: row,
            gatewayPort,
            gatewayToken,
            log: (m, err) => {
              if (err) api.logger.warn?.(`[onepilot:${accountId}:dispatch] ${m}: ${String(err)}`);
              else api.logger.info?.(`[onepilot:${accountId}:dispatch] ${m}`);
            },
          });
        },
        onSubscribed: () => {
          if (catchUpInFlight.value) return;
          catchUpInFlight.value = true;
          void runCatchUp({
            account,
            agentProfileIdLc,
            sinceMs: lastSeenUserAt,
            log: (m, err) => {
              if (err) api.logger.warn?.(`[onepilot:${accountId}:catchup] ${m}: ${String(err)}`);
              else api.logger.info?.(`[onepilot:${accountId}:catchup] ${m}`);
            },
            dispatch: (row) => {
              const ts = row.created_at ? Date.parse(row.created_at) : 0;
              if (Number.isFinite(ts) && ts > lastSeenUserAt) lastSeenUserAt = ts;
              // Populate the cache even for catchup rows. Catchup is how the
              // mapping is recovered after a gateway restart or fresh subscribe;
              // without this, approval forwarding falls back to the REST query
              // for every approval until the user types a fresh live message.
              if (row.session_key && row.session_id) {
                rememberSessionId(accountId, row.session_key, row.session_id);
              }
              void handleUserMessage({
                api,
                accountId,
                account,
                userMessageRow: row,
                upstreamBridge,
                gatewayPort,
                gatewayToken,
                log: (m, err) => {
                  if (err) api.logger.warn?.(`[onepilot:${accountId}:dispatch] ${m}: ${String(err)}`);
                  else api.logger.info?.(`[onepilot:${accountId}:dispatch] ${m}`);
                },
              });
            },
          }).finally(() => { catchUpInFlight.value = false; });
        },
        log: (m, err) => {
          if (err) api.logger.warn?.(`[onepilot:${accountId}:stream] ${m}: ${String(err)}`);
          else api.logger.info?.(`[onepilot:${accountId}:stream] ${m}`);
        },
      });

      _activeSubscriptions.set(accountId, sub);
      subscriptions.push({ accountId, sub });
    }

    log(`${subscriptions.length} subscription(s) active`);
  },
});
