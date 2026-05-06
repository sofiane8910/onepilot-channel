#!/usr/bin/env node
// CLI shim invoked by the iOS adapter (HermesAdapter / OpenClawAdapter)
// over SSH for the on/off toggle. Decisions DON'T go through here —
// iOS sends `/approve <id> <decision>` as a regular chat message and
// OpenClaw's auto-reply pipeline (commands-approve.ts) handles it.

import {
  setApprovalsForwardingEnabled,
  isApprovalsForwardingEnabled,
} from "../src/approvals.js";

function fail(msg, code = 1) {
  process.stderr.write(`approvals-cli: ${msg}\n`);
  process.exit(code);
}

async function main() {
  const [, , verb] = process.argv;
  switch (verb) {
    case "enable":
      await setApprovalsForwardingEnabled(true);
      process.stdout.write("approvals forwarding enabled\n");
      break;
    case "disable":
      await setApprovalsForwardingEnabled(false);
      process.stdout.write("approvals forwarding disabled\n");
      break;
    case "status": {
      const on = await isApprovalsForwardingEnabled();
      process.stdout.write(on ? "enabled\n" : "disabled\n");
      break;
    }
    default:
      fail(`usage: ${process.argv[1]} <enable|disable|status>`);
  }
}

main().catch((err) => fail(err?.message || String(err)));
