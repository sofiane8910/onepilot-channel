// Approval-context injection for the model.
//
// When our before_tool_call gate approves a tool, we record the decision
// here. The tool_result_persist hook (registered separately in index.js)
// reads this map and prepends a marker to the tool's result message before
// it lands in the session transcript. The model reads the transcript on
// its next inference, so the marker becomes natural context — no system
// prompt change, no upstream OpenClaw modification.
//
// In production we observed the model hallucinating "approvals aren't
// active" because it inspected upstream openclaw.json (which v0.9 no
// longer patches) and didn't find an `approvals.exec.*` block. The
// marker tells the model in-band that a gate ran and the user explicitly
// allowed the run.

// Two indices for resilient lookup:
//   _byToolCallId: toolCallId → {decision, decidedAtMs, sessionKey, toolName}
//     Primary key. toolCallId is provider-issued and globally unique per
//     call, so this is the most reliable correlator between the gate's
//     `before_tool_call` event and the persist hook's event.
//   _bySessionAndTool: `${sessionKey}:${toolName}` → newest entry
//     Fallback for the case where toolCallId was undefined at gate time
//     (the type allows it) but defined at persist time, or vice versa.
const _byToolCallId = new Map();
const _bySessionAndTool = new Map();
const TTL_MS = 5 * 60 * 1000; // GC bound; way longer than any tool roundtrip

function softKey(sessionKey, toolName) {
  return `${sessionKey ?? ""}:${toolName ?? ""}`;
}

function gc() {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of _byToolCallId) {
    if (v.decidedAtMs < cutoff) _byToolCallId.delete(k);
  }
  for (const [k, v] of _bySessionAndTool) {
    if (v.decidedAtMs < cutoff) _bySessionAndTool.delete(k);
  }
}

/**
 * Called from approvals-gate after `awaitDecision` resolves with allow.
 * `approvalId` is the gate-generated UUID broadcast on `approval_requested`
 * — kept on the entry purely for traceability in the persist-hook log line
 * so plugin logs link `[gate] approval_resolved id=…` to
 * `[persist] injected approval marker approvalId=…`.
 */
export function recordApproval({ approvalId, sessionKey, toolName, toolCallId, decision }) {
  const entry = {
    approvalId: approvalId ?? null,
    decision,
    decidedAtMs: Date.now(),
    sessionKey: sessionKey ?? null,
    toolName: toolName ?? null,
    toolCallId: toolCallId ?? null,
  };
  if (toolCallId) {
    _byToolCallId.set(toolCallId, entry);
  }
  // Always seed the soft key too, so a persist event whose toolCallId
  // doesn't match (provider remap, normalization) can still find the
  // approval by (sessionKey, toolName).
  _bySessionAndTool.set(softKey(sessionKey, toolName), entry);
  gc();
}

/**
 * Build the tool_result_persist hook. Tries toolCallId first, falls back
 * to (sessionKey, toolName), and on success deletes from BOTH indices so
 * the marker is one-shot per approval. Logs every persist event so the
 * runtime story is visible end-to-end.
 *
 * NOTE: tool_result_persist is synchronous-only per OpenClaw's hook
 * runner (`openclaw/src/plugins/hooks.ts:692`); a Promise return is
 * dropped with a warning. This handler is sync.
 */
export function buildToolResultPersistHook({ log }) {
  return function toolResultPersistHook(event, ctx) {
    const tcId = event?.toolCallId ?? ctx?.toolCallId ?? null;
    const sk = ctx?.sessionKey ?? null;
    const tn = event?.toolName ?? ctx?.toolName ?? null;

    let approval = null;
    let matchedBy = null;
    if (tcId && _byToolCallId.has(tcId)) {
      approval = _byToolCallId.get(tcId);
      matchedBy = "toolCallId";
    } else {
      const sk2 = softKey(sk, tn);
      if (_bySessionAndTool.has(sk2)) {
        approval = _bySessionAndTool.get(sk2);
        matchedBy = "sessionKey+toolName";
      }
    }

    if (!approval) {
      // Diagnostic only when there's anything pending — silence is fine
      // for tools that never went through our gate (the common case).
      if (_byToolCallId.size > 0 || _bySessionAndTool.size > 0) {
        log?.(`[persist] no approval match toolCallId=${tcId ? String(tcId).slice(0, 8) : "-"} sessionKey="${sk ?? "-"}" toolName="${tn ?? "-"}" recorded_keys=tcid:${_byToolCallId.size}/sk:${_bySessionAndTool.size}`);
      }
      return undefined;
    }

    // One-shot consume from both indices.
    if (approval.toolCallId) _byToolCallId.delete(approval.toolCallId);
    _bySessionAndTool.delete(softKey(approval.sessionKey, approval.toolName));

    const msg = event?.message;
    if (!msg) {
      log?.(`[persist] approval matched but event.message is missing — skipping marker`);
      return undefined;
    }

    const marker =
      `[Onepilot: this command was explicitly approved by the user via the mobile app ` +
      `(${approval.decision}) before it ran.]`;

    let nextContent;
    if (typeof msg.content === "string") {
      nextContent = `${marker}\n\n${msg.content}`;
    } else if (Array.isArray(msg.content)) {
      nextContent = [{ type: "text", text: marker }, ...msg.content];
    } else {
      log?.(`[persist] approval matched but msg.content has unexpected shape (${typeof msg.content}) — skipping marker`);
      return undefined;
    }

    const approvalIdShort = approval.approvalId ? String(approval.approvalId).slice(0, 8) : "-";
    log?.(`[persist] injected approval marker approvalId=${approvalIdShort} (matchedBy=${matchedBy}) toolCallId=${tcId ? String(tcId).slice(0, 8) : "-"} decision=${approval.decision}`);
    return { message: { ...msg, content: nextContent } };
  };
}
