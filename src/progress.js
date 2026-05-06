// Live agent-progress fan-out: realtime broadcasts + recoverable trail upsert.
//
// Mirrors the Hermes plugin's _broadcast / _progress_upsert / _progress_clear
// (onepilotapp/plugins/hermes/onepilot-platform/__init__.py:383-479) so the iOS
// chat UI sees identical event names, payload shapes, and topic routing for
// both frameworks. The iOS handler is framework-agnostic — keeping these
// helpers byte-for-byte aligned with the Hermes contract is what makes the
// rendering path "Just Work" without any iOS change.
//
// All three calls are best-effort: a failure here must NOT block the canonical
// assistant-reply ingest path. Debug-level logging only, never error-level —
// a missing realtime broadcast or progress row never warrants a user-visible
// alert because the final reply still ships through agent-message-ingest.

import { signAuthHeader } from "./pop-keys.js";

const BROADCAST_TIMEOUT_MS = 3000;

/**
 * iOS Realtime topic for a given session id. Must match the Swift client's
 * `messages_<UUID first-8 uppercase>` format (case-sensitive — Phoenix
 * matches topics literally). Also must match Hermes's _channel_for_session
 * exactly so a single shared listener works for either plugin.
 */
export function channelForSession(sessionId) {
  const s = String(sessionId).replace(/-/g, "").toUpperCase();
  return `messages_${s.slice(0, 8)}`;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire-and-forget Realtime broadcast. Failures are swallowed — the canonical
 * reply still lands via the existing ingest path.
 */
export async function broadcast(account, sessionId, event, payload, log) {
  const url = `${account.backendUrl}/realtime/v1/api/broadcast`;
  const body = JSON.stringify({
    messages: [
      {
        topic: channelForSession(sessionId),
        event,
        payload,
        private: false,
      },
    ],
  });
  try {
    await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: account.publishableKey,
          Authorization: `Bearer ${account.publishableKey}`,
        },
        body,
      },
      BROADCAST_TIMEOUT_MS,
    );
  } catch (err) {
    log?.(`broadcast ${event} failed (best-effort)`, err);
  }
}

/**
 * UPSERT live agent state to `agent_session_progress` so iOS can rebuild the
 * full in-flight UI (Lottie spinner, status pill, partial response, reasoning
 * trail) on bootstrap / app-foreground / conversation-reopen. Realtime
 * broadcasts are fire-and-forget; this single row is the durable catch-up
 * snapshot. PostgREST's resolution=merge-duplicates makes session_id (PK) the
 * conflict target. 4xx (e.g. table missing) is a silent skip — chat still
 * works without it.
 *
 * `fields` is an object with optional keys; only the keys actually present on
 * the object are written (so partial updates don't clobber columns set by an
 * earlier upsert). Always bumps `last_activity_at` and `updated_at`.
 *
 *   { reasoningText?: string,
 *     statusLabel?: string,
 *     partialResponse?: string,
 *     isActive?: boolean (default true),
 *     setStartedAt?: boolean (default false) }
 */
export async function progressUpsert(
  account,
  sessionId,
  userId,
  agentProfileId,
  fields,
  log,
) {
  // Route through the `agent-progress-upsert` edge function which validates
  // the agent key against agent_credentials (argon2 verify, binding match)
  // and writes via service_role — bypasses the agent_session_progress
  // SELECT RLS policy that otherwise breaks PostgREST UPSERT for anon.
  // Every prior call from here was failing with 42501 because INSERT...ON
  // CONFLICT DO UPDATE needs SELECT visibility on the conflicting row, and
  // the SELECT policy `auth.uid() = user_id` excludes anon. Result: every
  // upsert past the very first one (where the row didn't exist yet)
  // 401'd. Symptom: iOS Lottie/status pill never hydrates from
  // `agent_session_progress` and the broadcast carrying approval
  // prompts arrives without a state row to back it.
  const url = `${account.backendUrl}/functions/v1/agent-progress-upsert`;
  const body = {
    sessionId: String(sessionId).toLowerCase(),
    userId: String(userId).toLowerCase(),
    agentProfileId: String(agentProfileId).toLowerCase(),
    isActive: fields?.isActive ?? true,
  };
  if (fields && Object.prototype.hasOwnProperty.call(fields, "reasoningText")) {
    body.reasoningText = fields.reasoningText;
  }
  if (fields && Object.prototype.hasOwnProperty.call(fields, "partialResponse")) {
    body.partialResponse = fields.partialResponse;
  }
  if (fields && Object.prototype.hasOwnProperty.call(fields, "statusLabel")) {
    body.statusLabel = fields.statusLabel;
  }
  if (fields?.setStartedAt) {
    body.setStartedAt = true;
  }
  try {
    const r = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: signAuthHeader({ agentProfileId: account.agentProfileId, method: "POST", url, scope: "progress" }),
        },
        body: JSON.stringify(body),
      },
      BROADCAST_TIMEOUT_MS,
    );
    if (r.status >= 400) {
      const txt = await r.text().catch(() => "");
      log?.(`progress upsert ${r.status}: ${txt.slice(0, 200)}`);
    }
  } catch (err) {
    log?.(`progress upsert failed (best-effort)`, err);
  }
}

/**
 * Mark the live progress row finished (`is_active=false`) and clear transient
 * fields. The row stays for a short grace window so a client returning right
 * after `done` can still see the final state; the pg_cron sweep deletes
 * finalised rows after 5 min. Best-effort — a missing row is fine.
 */
export async function progressFinalize(account, sessionId, userId, agentProfileId, log) {
  await progressUpsert(
    account,
    sessionId,
    userId,
    agentProfileId,
    { isActive: false, statusLabel: "", partialResponse: "" },
    log,
  );
}
