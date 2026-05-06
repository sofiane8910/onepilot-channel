// Locks the realtime topic + payload shape to the Hermes contract so the iOS
// chat UI renders OpenClaw and Hermes the same way without iOS changes.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Sandbox the keypair store BEFORE importing pop-keys (which reads
// OPENCLAW_HOME at module load).
process.env.OPENCLAW_HOME = mkdtempSync(path.join(tmpdir(), "onepilot-progress-"));

const { broadcast, progressUpsert, progressFinalize, channelForSession } = await import("../src/progress.js");
const { getOrCreateKeypair } = await import("../src/pop-keys.js");

const AGENT_PROFILE_ID = "33333333-3333-3333-3333-333333333333";
await getOrCreateKeypair(AGENT_PROFILE_ID);

const ACCOUNT = {
  backendUrl: "https://example.test",
  publishableKey: "pk_test",
};
const SESSION_ID = "abcdef12-3456-7890-abcd-ef1234567890";

function captureFetch() {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response("", { status: 200 });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = orig;
    },
  };
}

test("channelForSession matches the Hermes _channel_for_session format", () => {
  // Hermes uses UPPERCASE first 8 chars of the UUID (no dashes). iOS subscribes
  // case-sensitively so a lowercase prefix would route to a topic nobody is on.
  assert.equal(channelForSession(SESSION_ID), "messages_ABCDEF12");
  assert.equal(channelForSession("abcdef12-0000"), "messages_ABCDEF12");
});

test("broadcast posts to /realtime/v1/api/broadcast with the right topic, event, payload", async () => {
  const f = captureFetch();
  try {
    await broadcast(ACCOUNT, SESSION_ID, "reasoning_delta", { text: "thinking..." });
    assert.equal(f.calls.length, 1);
    const { url, init } = f.calls[0];
    assert.equal(url, "https://example.test/realtime/v1/api/broadcast");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.equal(init.headers.apikey, "pk_test");
    assert.equal(init.headers.Authorization, "Bearer pk_test");
    const body = JSON.parse(init.body);
    assert.deepEqual(body, {
      messages: [
        {
          topic: "messages_ABCDEF12",
          event: "reasoning_delta",
          payload: { text: "thinking..." },
          private: false,
        },
      ],
    });
  } finally {
    f.restore();
  }
});

// progressUpsert posts to the agent-progress-upsert edge function (NOT direct
// PostgREST) — the function authenticates against agent_credentials and writes
// via service_role, bypassing the RLS SELECT policy that breaks PostgREST
// UPSERT for anon. Body shape is camelCase to match the edge-function contract.
const ACCOUNT_WITH_KEY = { ...ACCOUNT, agentProfileId: AGENT_PROFILE_ID };
const PROGRESS_URL = "https://example.test/functions/v1/agent-progress-upsert";

function assertSignedBearer(authHeader) {
  // POP JWT: header.payload.signature, all base64url, EdDSA alg.
  assert.ok(authHeader.startsWith("Bearer eyJhbGciOiJFZERTQSI"), `not a POP-signed bearer: ${authHeader.slice(0, 40)}...`);
}

test("progressUpsert posts to the edge function with camelCase ids and selected fields", async () => {
  const f = captureFetch();
  try {
    await progressUpsert(
      ACCOUNT_WITH_KEY,
      SESSION_ID,
      "USER-AAAA",
      "AGENT-BBBB",
      { reasoningText: "trail so far\n", isActive: true, setStartedAt: true },
    );
    assert.equal(f.calls.length, 1);
    const { url, init } = f.calls[0];
    assert.equal(url, PROGRESS_URL);
    assert.equal(init.method, "POST");
    assertSignedBearer(init.headers.Authorization);
    const body = JSON.parse(init.body);
    assert.equal(body.sessionId, SESSION_ID.toLowerCase());
    assert.equal(body.userId, "user-aaaa");
    assert.equal(body.agentProfileId, "agent-bbbb");
    assert.equal(body.isActive, true);
    assert.equal(body.reasoningText, "trail so far\n");
    assert.equal(body.setStartedAt, true);
    // Fields not passed should NOT be present (so partial updates don't clobber).
    assert.ok(!("partialResponse" in body));
    assert.ok(!("statusLabel" in body));
  } finally {
    f.restore();
  }
});

test("progressUpsert without setStartedAt omits it (no clobber)", async () => {
  const f = captureFetch();
  try {
    await progressUpsert(
      ACCOUNT_WITH_KEY,
      SESSION_ID,
      "u",
      "a",
      { statusLabel: "Running exec…" },
    );
    const body = JSON.parse(f.calls[0].init.body);
    assert.equal(body.statusLabel, "Running exec…");
    assert.ok(!("setStartedAt" in body));
    assert.ok(!("reasoningText" in body));
  } finally {
    f.restore();
  }
});

test("progressFinalize upserts isActive=false (replaces the old DELETE-based clear)", async () => {
  const f = captureFetch();
  try {
    await progressFinalize(ACCOUNT_WITH_KEY, SESSION_ID, "u", "a");
    assert.equal(f.calls.length, 1);
    const { url, init } = f.calls[0];
    assert.equal(url, PROGRESS_URL);
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body);
    assert.equal(body.isActive, false);
    assert.equal(body.partialResponse, "");
    assert.equal(body.statusLabel, "");
  } finally {
    f.restore();
  }
});

test("broadcast swallows network errors (best-effort fan-out)", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("simulated network down");
  };
  try {
    // Should not throw.
    await broadcast(ACCOUNT, SESSION_ID, "started", {});
  } finally {
    globalThis.fetch = orig;
  }
});
