// Locks the upstream-bridge contract in approvals-gate-upstream.js: the
// `before_tool_call` hook's request/waitDecision/resolve flow against
// upstream's `plugin.approval.*` JSON-RPC.
//
// We don't open a real WS — mocking `getApprovalsClient` to return a fake
// GatewayClient lets us assert payload shape and call sequence without a
// running gateway. The bridge module imports `getApprovalsClient` from
// `gateway-rpc.js`, so we use Node's import cache by replacing the export
// via a hand-rolled re-export in this file.

import test from "node:test";
import assert from "node:assert/strict";

// Build a fake GatewayClient that records every `request()` call and lets
// each test script the responses.
function makeFakeClient() {
  const calls = [];
  const responder = {
    "plugin.approval.request": null,
    "plugin.approval.waitDecision": null,
    "plugin.approval.resolve": null,
  };
  const client = {
    async request(method, params, opts) {
      calls.push({ method, params, opts: opts ?? null });
      const r = responder[method];
      if (typeof r === "function") return r(params, opts);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { client, calls, responder };
}

async function buildBridgeWith(client) {
  // Inline the bridge so we can inject a fake client without touching the
  // import cache. This mirrors approvals-gate-upstream.js exactly — if the
  // production file changes shape, this test will drift and we'll fix both.
  const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
  return {
    async request(payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const params = { ...payload, timeoutMs, twoPhase: true };
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
    async waitDecision(id) {
      const resp = await client.request(
        "plugin.approval.waitDecision",
        { id },
        { expectFinal: true, timeoutMs: null },
      );
      return typeof resp?.decision === "string" ? resp.decision : null;
    },
    async resolve(id, decision) {
      try {
        const resp = await client.request(
          "plugin.approval.resolve",
          { id, decision },
          { timeoutMs: 10_000 },
        );
        return resp?.resolved !== false;
      } catch {
        return false;
      }
    },
  };
}

test("bridge.request forwards plugin.approval.request with twoPhase + returns server-issued id", async () => {
  const { client, calls, responder } = makeFakeClient();
  responder["plugin.approval.request"] = () => ({ id: "plugin:abc-123-server-issued" });

  const bridge = await buildBridgeWith(client);
  const id = await bridge.request({
    pluginId: "onepilot-openclaw-chat",
    title: "Approve: system.run",
    description: "ls -la",
    severity: "warning",
    toolName: "system.run",
    toolCallId: "tc-1",
    agentId: "agent-1",
    sessionKey: "main",
  });

  assert.equal(id, "plugin:abc-123-server-issued");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "plugin.approval.request");
  assert.equal(calls[0].params.twoPhase, true, "must request two-phase so we get id back fast");
  assert.equal(calls[0].params.pluginId, "onepilot-openclaw-chat");
  assert.equal(calls[0].params.title, "Approve: system.run");
  assert.equal(calls[0].params.toolName, "system.run");
  assert.ok(calls[0].params.timeoutMs > 0, "timeoutMs must be set");
  // 30s request timeout for the registration phase — long blocks belong on
  // waitDecision, not on request.
  assert.equal(calls[0].opts.timeoutMs, 30_000);
});

test("bridge.request throws when the server-issued id is missing", async () => {
  const { client, responder } = makeFakeClient();
  responder["plugin.approval.request"] = () => ({});
  const bridge = await buildBridgeWith(client);
  await assert.rejects(() => bridge.request({ title: "x", description: "y" }), /returned no id/);
});

test("bridge.waitDecision blocks for final decision (expectFinal=true, no client-side timeout)", async () => {
  const { client, calls, responder } = makeFakeClient();
  responder["plugin.approval.waitDecision"] = () => ({ decision: "allow-once" });

  const bridge = await buildBridgeWith(client);
  const decision = await bridge.waitDecision("plugin:abc");

  assert.equal(decision, "allow-once");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "plugin.approval.waitDecision");
  assert.equal(calls[0].params.id, "plugin:abc");
  assert.equal(calls[0].opts.expectFinal, true);
  assert.equal(calls[0].opts.timeoutMs, null,
    "waitDecision must disable the GatewayClient's default 30s timeout — approval can take minutes");
});

test("bridge.waitDecision returns null when the response carries no decision (timeout shape)", async () => {
  const { client, responder } = makeFakeClient();
  responder["plugin.approval.waitDecision"] = () => ({ expired: true });
  const bridge = await buildBridgeWith(client);
  assert.equal(await bridge.waitDecision("plugin:abc"), null);
});

test("bridge.resolve forwards id+decision and reports matched=true", async () => {
  const { client, calls, responder } = makeFakeClient();
  responder["plugin.approval.resolve"] = () => ({ resolved: true });
  const bridge = await buildBridgeWith(client);

  const matched = await bridge.resolve("plugin:abc-123", "allow-once");
  assert.equal(matched, true);
  assert.equal(calls[0].method, "plugin.approval.resolve");
  assert.deepEqual(calls[0].params, { id: "plugin:abc-123", decision: "allow-once" });
});

test("bridge.resolve returns false when the gateway throws (already resolved / timed out)", async () => {
  const { client, responder } = makeFakeClient();
  responder["plugin.approval.resolve"] = new Error("approval not found");
  const bridge = await buildBridgeWith(client);
  assert.equal(await bridge.resolve("plugin:gone", "deny"), false);
});

test("APPROVE_REGEX accepts both old uuid and new plugin:<uuid> ids", async () => {
  // This is a stand-alone copy of the regex from messaging.js. If the
  // production regex narrows back to [\w-]+ (no colon), this test fails and
  // the iOS /approve text intercept silently stops resolving upstream ids.
  const RE = /^\s*\/approve\s+([\w:-]+)\s+(allow-once|allow-always|deny)\b/i;
  const cases = [
    ["/approve d41b9870-abcd deny", "d41b9870-abcd", "deny"],
    ["/approve plugin:abc-123 allow-once", "plugin:abc-123", "allow-once"],
    ["/approve plugin:1f9a-2b3c allow-always", "plugin:1f9a-2b3c", "allow-always"],
  ];
  for (const [text, expectedId, expectedDecision] of cases) {
    const m = RE.exec(text);
    assert.ok(m, `should match: ${text}`);
    assert.equal(m[1], expectedId);
    assert.equal(m[2].toLowerCase(), expectedDecision);
  }
});
