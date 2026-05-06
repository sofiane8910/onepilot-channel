/**
 * Loopback WebSocket client to the local OpenClaw gateway.
 *
 * The plugin runs in-process with the gateway, but `pluginApprovalManager`
 * isn't exposed via the plugin SDK as a direct in-process handle. The
 * supported path is to open a WS to the local gateway with the
 * `operator.approvals` scope and call `plugin.approval.*` JSON-RPC methods
 * — the same surface Discord/Telegram use for `exec.approval.*`.
 *
 * Why a singleton: each WS handshake costs ~10ms and every approval gate
 * goes through this client. A long-lived connection per plugin process
 * keeps approval round-trips sub-millisecond after the first one.
 *
 * Why lazy: `register()` must be synchronous (per OpenClaw plugin SDK),
 * but `createOperatorApprovalsGatewayClient` is async (auth resolution +
 * WS connect). We init on the first `getClient()` call.
 *
 * Reconnect: handled internally by `GatewayClient` (`backoffMs`, on-close
 * retry). If the WS is closed and `request()` is called, it throws
 * `gateway not connected` and the caller is expected to handle that as a
 * transient failure.
 *
 * Scope: `operator.approvals` is granted to gateway-token clients
 * connecting to loopback (see `openclaw/src/gateway/operator-approvals-client.ts`).
 * No device pairing required.
 */

// Static import — dynamic `await import("openclaw/plugin-sdk/...")` does NOT
// go through OpenClaw's jiti alias resolution and ERR_MODULE_NOT_FOUND
// fires every time at runtime (the plugin's node_modules has no `openclaw`
// package because it's a peerDependency). The bundled extensions
// (extensions/discord/src/*, extensions/zalo/src/*) all use static imports
// at module top, which the host loader resolves via jiti before the file
// executes. Same pattern here.
import { createOperatorApprovalsGatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

let _clientPromise = null;
let _client = null;

/**
 * Lazily resolve the singleton gateway client. Subsequent calls return the
 * same in-flight or resolved promise. Caller awaits and then invokes
 * `client.request(method, params, opts)`.
 *
 * @param {object} config — OpenClaw config object (the plugin receives this
 *   via `api.config`). Used for auth resolution.
 * @param {(msg: string, err?: unknown) => void} log
 * @returns {Promise<import("openclaw/plugin-sdk/gateway-runtime").GatewayClient>}
 */
export async function getApprovalsClient(config, log) {
  if (_client) return _client;
  if (_clientPromise) return _clientPromise;

  _clientPromise = (async () => {
    log?.("[gateway-rpc] connecting loopback WS for plugin.approval.* (scope: operator.approvals)");
    const client = await createOperatorApprovalsGatewayClient({
      config,
      clientDisplayName: "onepilot-openclaw-chat (plugin approval gate)",
      onClose: (info) => {
        log?.(`[gateway-rpc] WS closed: ${info?.code ?? "?"} ${info?.reason ?? ""}`);
        // Singleton stays referenced; GatewayClient handles its own reconnect
        // backoff. If reconnect fails permanently, next request() throws and
        // the gate falls back to local _pending Map.
      },
      onConnectError: (err) => {
        log?.(`[gateway-rpc] connect error: ${String(err)}`);
      },
      onHelloOk: () => {
        log?.("[gateway-rpc] connected, ready for plugin.approval.*");
      },
      onEvent: () => {
        // Plugin approvals push events back over the WS too (e.g.
        // `plugin.approval.requested` echo). We don't need them — our
        // Supabase Realtime broadcast is the authoritative iOS-bound
        // channel. Ignore.
      },
    });
    client.start();
    _client = client;
    return client;
  })().catch((err) => {
    // Reset the cached promise so the next call retries from scratch.
    _clientPromise = null;
    throw err;
  });

  return _clientPromise;
}

/**
 * Test-only: drop the singleton so a fresh client gets built on next call.
 * Production code should never call this; a once-per-process handle is by
 * design.
 */
export function _resetForTest() {
  _client = null;
  _clientPromise = null;
}
