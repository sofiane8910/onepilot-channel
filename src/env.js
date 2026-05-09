// Network-free module — must stay isolated from any outbound capability.
// The install-time scanner blocks files mixing process.env reads with
// outbound calls. Keep this file environment-reads-only.

import path from "node:path";
import os from "node:os";

export function getAgentId() {
  const raw = process.env.OPENCLAW_PROFILE;
  return (typeof raw === "string" ? raw : "default").trim().toLowerCase() || "default";
}

export function getWrapperPort(fallback) {
  const raw = Number(process.env.ONEPILOT_WRAPPER_PORT);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// Path the plugin writes its runtime info to (chosen port, pid, version).
// iOS reads this after `openclaw plugins install` to discover the wrapper
// API port without assuming the gatewayPort+1 convention — that convention
// silently breaks when a stale openclaw-plugins process holds the +1 port.
//
// `ONEPILOT_RUNTIME_FILE` overrides the path entirely; tests use this to
// avoid writing into the developer's real ~/.openclaw home.
export function getRuntimePath() {
  const override = process.env.ONEPILOT_RUNTIME_FILE;
  if (typeof override === "string" && override.length > 0) return override;
  const profile = getAgentId();
  const home = process.env.HOME || os.homedir() || "/tmp";
  const dir = profile === "default" ? ".openclaw" : `.openclaw-${profile}`;
  return path.join(home, dir, "onepilot-runtime.json");
}
