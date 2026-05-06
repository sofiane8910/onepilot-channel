// Per-host Ed25519 keypair + POP JWT signing for Supabase calls.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const SECRETS_DIR = (() => {
  const home = process.env.OPENCLAW_HOME || os.homedir() || "/tmp";
  return path.join(home, ".openclaw", "secrets");
})();

const TOKEN_LIFETIME_S = 90;

function b64urlEncode(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function ed25519PrivateKeyToRawPublicB64u(privateKey) {
  const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return b64urlEncode(spki.subarray(spki.length - 32));
}

function keyPathFor(agentProfileId) {
  return path.join(SECRETS_DIR, `${String(agentProfileId).toLowerCase()}.key`);
}

const _genLocks = new Map();

function ensureSecretsDir() {
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(SECRETS_DIR, 0o700); } catch { /* best-effort */ }
}

export async function getOrCreateKeypair(agentProfileId) {
  if (!agentProfileId || typeof agentProfileId !== "string") {
    throw new Error("agentProfileId required");
  }
  const inflight = _genLocks.get(agentProfileId);
  if (inflight) await inflight;

  const file = keyPathFor(agentProfileId);
  if (existsSync(file)) {
    const priv = createPrivateKey({ key: readFileSync(file, "utf8"), format: "pem" });
    return { publicKeyB64u: ed25519PrivateKeyToRawPublicB64u(priv), alreadyExisted: true };
  }

  const lock = (async () => {
    ensureSecretsDir();
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    writeFileSync(file, pem, { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* best-effort */ }
  })();
  _genLocks.set(agentProfileId, lock);
  try { await lock; } finally { _genLocks.delete(agentProfileId); }

  const priv = createPrivateKey({ key: readFileSync(file, "utf8"), format: "pem" });
  return { publicKeyB64u: ed25519PrivateKeyToRawPublicB64u(priv), alreadyExisted: false };
}

function loadPrivateKey(agentProfileId) {
  const file = keyPathFor(agentProfileId);
  if (!existsSync(file)) {
    throw new Error(`keypair not provisioned for ${agentProfileId}`);
  }
  return createPrivateKey({ key: readFileSync(file, "utf8"), format: "pem" });
}

export function signAuthHeader({ agentProfileId, method, url, scope }) {
  if (!agentProfileId || !method || !url || !scope) {
    throw new Error("agentProfileId, method, url, scope required");
  }
  const u = new URL(url);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", typ: "JWT", kid: String(agentProfileId).toLowerCase() };
  const payload = {
    sub: String(agentProfileId).toLowerCase(),
    iat: now,
    exp: now + TOKEN_LIFETIME_S,
    jti: b64urlEncode(randomBytes(16)),
    htu: `${u.origin}${u.pathname}`,
    htm: String(method).toUpperCase(),
    scope,
  };
  const headerB64 = b64urlEncode(Buffer.from(JSON.stringify(header)));
  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sigB64 = b64urlEncode(nodeSign(null, Buffer.from(signingInput), loadPrivateKey(agentProfileId)));
  return `Bearer ${signingInput}.${sigB64}`;
}

