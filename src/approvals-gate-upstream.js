/**
 * Bridge wrapping upstream `plugin.approval.*` JSON-RPC into a 3-method API
 * that mirrors the existing in-memory gate's semantics. Lets the
 * `before_tool_call` hook in `approvals-gate.js` swap implementations with
 * a single conditional.
 *
 * The flow when a tool call hits the gate:
 *   1. Hook calls `request({...payload, twoPhase: true})` →
 *      gateway returns the assigned approval id (`plugin:<uuid>`)
 *      immediately. Plugin then broadcasts `approval_requested` to iOS via
 *      Supabase Realtime (unchanged from today).
 *   2. Hook calls `waitDecision(id)` → blocks until iOS user resolves the
 *      approval (via the `/approve` chat-message intercept that calls
 *      `resolve(id, decision)` on this same client). Returns the decision
 *      string (`allow-once`, `allow-always`, `deny`) or `null` on timeout.
 *
 * The intercept in `messaging.js` calls `resolve(id, decision)` against
 * the same singleton client to unblock the awaiting `waitDecision`.
 */

import { getApprovalsClient } from "./gateway-rpc.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Construct a bridge bound to a specific config + log surface. The plugin
 * builds this once during `register()` and passes it into the hook factory
 * when the upstream-approvals flag is on.
 *
 * @param {object} config — `api.config` (OpenClaw config from plugin SDK)
 * @param {(msg: string, err?: unknown) => void} log
 */
export function createUpstreamApprovalsBridge(config, log) {
  return {
    /**
     * Register a pending approval with upstream's `pluginApprovalManager`.
     * Two-phase: returns the assigned id immediately so the caller can
     * broadcast to iOS before awaiting the decision.
     *
     * @param {object} payload — fields mapped to PluginApprovalRequestPayload
     *   (title, description, severity, toolName, toolCallId, agentId,
     *   sessionKey, ...). See openclaw/src/infra/plugin-approvals.ts for
     *   the canonical shape.
     * @param {number} [timeoutMs] — defaults to 5 min, capped server-side
     *   at MAX_PLUGIN_APPROVAL_TIMEOUT_MS (10 min)
     * @returns {Promise<string>} the assigned approval id (`plugin:<uuid>`)
     */
    async request(payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const client = await getApprovalsClient(config, log);
      const params = {
        ...payload,
        timeoutMs,
        twoPhase: true,
      };
      // expectFinal=false: we want the immediate "pending" response with id,
      // not the final decision. waitDecision() handles the final hop.
      const resp = await client.request("plugin.approval.request", params, {
        timeoutMs: 30_000,
      });
      const id =
        typeof resp?.id === "string"
          ? resp.id
          : typeof resp?.approvalId === "string"
            ? resp.approvalId
            : null;
      if (!id) {
        throw new Error(
          `plugin.approval.request returned no id (resp=${JSON.stringify(resp).slice(0, 200)})`,
        );
      }
      return id;
    },

    /**
     * Block until the user resolves the approval, or the gateway times it
     * out. Returns the decision string or `null` for timeout/unknown.
     *
     * @param {string} id — value returned by `request()`
     * @returns {Promise<string|null>}
     */
    async waitDecision(id) {
      const client = await getApprovalsClient(config, log);
      // expectFinal=true + timeoutMs=null: this call legitimately blocks
      // for up to the approval's gateway-side timeout. The 30s default
      // request timeout would fire prematurely.
      const resp = await client.request(
        "plugin.approval.waitDecision",
        { id },
        { expectFinal: true, timeoutMs: null },
      );
      const decision = typeof resp?.decision === "string" ? resp.decision : null;
      return decision;
    },

    /**
     * Submit a decision for an awaiting approval. Called from the
     * `/approve` text intercept in messaging.js once the iOS user taps.
     *
     * @param {string} id
     * @param {"allow-once"|"allow-always"|"deny"} decision
     * @returns {Promise<boolean>} true if the approval was matched and
     *   resolved, false if no pending entry (timed out / already resolved)
     */
    async resolve(id, decision) {
      const client = await getApprovalsClient(config, log);
      try {
        const resp = await client.request(
          "plugin.approval.resolve",
          { id, decision },
          { timeoutMs: 10_000 },
        );
        return resp?.resolved !== false;
      } catch (err) {
        log?.(`[gate-upstream] resolve failed for id=${String(id).slice(0, 16)}: ${String(err)}`);
        return false;
      }
    },
  };
}
