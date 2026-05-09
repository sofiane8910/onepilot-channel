// Contract test for the wrapper-api HTTP surface.
//
// Strategy: prepend a stub `openclaw` shell script to PATH so the wrapper's
// shellOpenClaw() calls return predictable fixtures. Boot the server on a
// random port, curl each endpoint, assert the shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const WRAPPER_TOKEN = "wat_test_wrappertoken1234567890";

function setupStubBin() {
  const dir = mkdtempSync(path.join(tmpdir(), "onepilot-stub-"));
  const stub = path.join(dir, "openclaw");
  const initialAccounts = JSON.stringify({
    default: {
      enabled: true,
      backendUrl: "http://127.0.0.1:9999",
      streamUrl: "ws://127.0.0.1:9999",
      publishableKey: "pk_test",
      wrapperApiToken: WRAPPER_TOKEN,
      userId: "11111111-1111-1111-1111-111111111111",
      agentProfileId: "22222222-2222-2222-2222-222222222222",
      sessionKey: "main",
    },
  }).replace(/'/g, `'\\''`);

  // Bash stub: implements `openclaw config get/set/delete --json`,
  // `--version`, `plugins uninstall`. Stores config in a per-instance file.
  const cfgPath = path.join(dir, "config.json");
  writeFileSync(cfgPath, initialAccounts);
  const script = `#!/usr/bin/env bash
set -e
case "$1" in
  --version) echo "openclaw 99.9.9-stub"; exit 0 ;;
  config)
    case "$2" in
      get) cat "${cfgPath}" ; exit 0 ;;
      set)
        # last token is the JSON value (single-quoted); --strict-json may follow.
        # We just record that a write happened — for the rotate test we read
        # back via /v1/health → readAccountsFromConfig → 'config get'.
        # Parse: openclaw config set <key> '<json>' [--strict-json]
        shift 2
        # remove key
        shift
        val="$1"
        # strip optional leading single quote pair
        val="\${val#\\'}"; val="\${val%\\'}"
        # echo updated json into cfg file: replace 'default' entry entirely
        # for simplicity. Full key path support not needed for these tests.
        echo "{\\"default\\": $val}" > "${cfgPath}"
        exit 0 ;;
      delete)
        echo "{}" > "${cfgPath}"
        exit 0 ;;
    esac ;;
  plugins)
    case "$2" in
      uninstall) echo "uninstalled"; exit 0 ;;
    esac ;;
esac
echo "unhandled stub: $@" >&2
exit 0
`;
  writeFileSync(stub, script);
  chmodSync(stub, 0o755);
  return { binDir: dir, cfgPath };
}

async function bootWrapper({ port, runtimeFile } = {}) {
  const { startWrapperApi } = await import("../src/wrapper-api.js");
  const calls = { logs: [], warns: [] };
  if (port) process.env.ONEPILOT_WRAPPER_PORT = String(port);
  // Sandbox the runtime.json write so tests don't touch the developer's
  // real ~/.openclaw home.
  const rt = runtimeFile ?? path.join(mkdtempSync(path.join(tmpdir(), "onepilot-rt-")), "runtime.json");
  process.env.ONEPILOT_RUNTIME_FILE = rt;
  const server = startWrapperApi({
    accounts: { default: { wrapperApiToken: WRAPPER_TOKEN } },
    log: (m) => calls.logs.push(m),
    warn: (m, e) => calls.warns.push([m, e?.message || String(e || "")]),
  });
  // wait for listen
  await new Promise((resolve) => setTimeout(resolve, 80));
  return { server, calls, runtimeFile: rt };
}

async function curl(method, port, urlPath, body, key = WRAPPER_TOKEN) {
  const r = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: r.status, json };
}

function pickPort() {
  return 19000 + Math.floor(Math.random() * 500);
}

test("wrapper API: rejects missing/wrong bearer", async () => {
  const { binDir } = setupStubBin();
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  const port = pickPort();
  const { server } = await bootWrapper({ port });
  try {
    const noAuth = await fetch(`http://127.0.0.1:${port}/onepilot/v1/health`);
    assert.equal(noAuth.status, 401);

    const bad = await curl("GET", port, "/onepilot/v1/health", null, "wat_wrong");
    assert.equal(bad.status, 401);
  } finally {
    server.close();
    process.env.PATH = oldPath;
  }
});

test("wrapper API: GET /health returns shape", async () => {
  const { binDir } = setupStubBin();
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  const port = pickPort();
  const { server } = await bootWrapper({ port });
  try {
    const r = await curl("GET", port, "/onepilot/v1/health");
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.plugin_id, "onepilot");
    assert.equal(r.json.framework, "openclaw");
    assert.equal(r.json.wrapper_api, "v1");
    assert.equal(typeof r.json.plugin_version, "string");
    assert.equal(r.json.account_configured, true);
    assert.deepEqual(r.json.accounts, ["default"]);
  } finally {
    server.close();
    process.env.PATH = oldPath;
  }
});

test("wrapper API: POST /configure rejects bad payload", async () => {
  const { binDir } = setupStubBin();
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  const port = pickPort();
  const { server } = await bootWrapper({ port });
  try {
    const r = await curl("POST", port, "/onepilot/v1/configure", { not_accounts: 1 });
    assert.equal(r.status, 400);
    assert.equal(r.json.ok, false);
  } finally {
    server.close();
    process.env.PATH = oldPath;
  }
});

test("wrapper API: 404 on unknown path", async () => {
  const { binDir } = setupStubBin();
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  const port = pickPort();
  const { server } = await bootWrapper({ port });
  try {
    const r = await curl("GET", port, "/onepilot/v1/nope");
    assert.equal(r.status, 404);
  } finally {
    server.close();
    process.env.PATH = oldPath;
  }
});

test("wrapper API: POST /plugin/uninstall calls the stub", async () => {
  const { binDir } = setupStubBin();
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  const port = pickPort();
  const { server } = await bootWrapper({ port });
  try {
    const r = await curl("POST", port, "/onepilot/v1/plugin/uninstall", {});
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
  } finally {
    server.close();
    process.env.PATH = oldPath;
  }
});

test("wrapper API: writes runtime.json with chosen port + pid + version", async () => {
  const { binDir } = setupStubBin();
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  const port = pickPort();
  const { server, runtimeFile } = await bootWrapper({ port });
  try {
    // The file is written from inside the listen() callback, after a tick.
    await new Promise((r) => setTimeout(r, 50));
    const { readFileSync, existsSync } = await import("node:fs");
    assert.ok(existsSync(runtimeFile), `runtime file not written at ${runtimeFile}`);
    const parsed = JSON.parse(readFileSync(runtimeFile, "utf8"));
    assert.equal(parsed.port, port, "runtime.json port should match listen port");
    assert.equal(typeof parsed.pid, "number");
    assert.equal(typeof parsed.startedAt, "string");
    assert.equal(typeof parsed.pluginVersion, "string");
    assert.notEqual(parsed.pluginVersion, "");
  } finally {
    server.close();
    process.env.PATH = oldPath;
  }
});

test("wrapper API: defaults to kernel-assigned port (no collision possible)", async () => {
  // The May 2026 outage was a stale openclaw-plugins holding gatewayPort+1.
  // v0.13 binds port 0 unconditionally so there's no port to collide on.
  // iOS reads the actual port from runtime.json.
  const { binDir } = setupStubBin();
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  const oldExplicit = process.env.ONEPILOT_WRAPPER_PORT;
  delete process.env.ONEPILOT_WRAPPER_PORT;

  let server;
  try {
    const r = await bootWrapper({ port: undefined });
    server = r.server;
    const { existsSync, readFileSync } = await import("node:fs");
    assert.ok(existsSync(r.runtimeFile), "runtime.json should be written");
    const parsed = JSON.parse(readFileSync(r.runtimeFile, "utf8"));
    assert.ok(parsed.port > 0 && parsed.port < 65536, "kernel should assign a real port");
    // Wrapper is healthy on the assigned port.
    const probe = await fetch(`http://127.0.0.1:${parsed.port}/onepilot/v1/health`, {
      headers: { authorization: `Bearer ${WRAPPER_TOKEN}` },
    });
    assert.equal(probe.status, 200);
  } finally {
    if (server) server.close();
    if (oldExplicit !== undefined) {
      process.env.ONEPILOT_WRAPPER_PORT = oldExplicit;
    } else {
      delete process.env.ONEPILOT_WRAPPER_PORT;
    }
    process.env.PATH = oldPath;
  }
});
