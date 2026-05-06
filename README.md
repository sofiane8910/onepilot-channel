# openclaw-onepilot-channel

OpenClaw plugin that bridges the Onepilot app to the agent runtime. Two responsibilities, both running inside the OpenClaw gateway process on the agent host:

1. **Inbound** — opens a durable channel to the Onepilot backend, listens for new user-message events, dispatches them into the agent loop via the gateway's local `/v1/chat/completions` endpoint, and POSTs the assistant reply back to the Onepilot backend so the app receives it via push. Survives mobile force-quits because the agent loop never depends on the app staying alive.
2. **Outbound channel** — registers `onepilot` as a real OpenClaw channel (`api.registerChannel`). This is what makes cron jobs (and any other agent-driven outbound delivery) work — without a registered channel, OpenClaw's delivery resolver throws `"channel is required"` at fire-time. The channel's `sendText` reuses the same backend message endpoint the inbound reply flow uses.

## Design principles

These rules govern every change to this plugin. They exist because the app ships through App Store review (1–2 week turnaround) but the plugin ships through `plugin_manifest` (instant). When the boundary between them blurs, every framework rename or schema tweak becomes a stuck App Store release. Don't blur the boundary.

**1. Plugins are the heavy lifters.** Anything that touches the framework — flag spelling, config-key paths, CLI shape, plugin install/uninstall, account write-back — lives **here**, not in iOS. If OpenClaw renames `--strict-json` tomorrow, this plugin absorbs it and ships v+1 via `plugin_manifest`; the app doesn't notice. New iOS adapter code calling `openclaw <verb>` directly is a regression — route it through the wrapper API in `src/wrapper-api.js` and let the plugin shell out.

**2. The app renders what we control.** iOS speaks to two surfaces only: this plugin's `/onepilot/v1/*` HTTP wrapper and the chat WebSocket. Both shapes are owned by us, both are versioned, both have contract tests. UI gates on capability flags (`AgentFrameworkCapability`), never on `frameworkType == .openclaw`. New features land as new wrapper endpoints with stable verbs — not as new framework-CLI invocations from Swift. If the app needs to render something the plugin doesn't expose yet, add the endpoint here first.

**3. Security first.** A leaked agent key (`oak_*`) must read zero rows outside its bound `(user_id, agent_profile_id)`, and writes must be attributed only to that pair — server-side, not from request body. Every wrapper endpoint takes `Authorization: Bearer <agentKey>`, binds on `127.0.0.1` only, and never accepts user-supplied `userId`/`agentProfileId` overrides. New edge-function calls require a `SCOPE.md` documenting the authz scope. New imports (`child_process`, `eval`, `Function(`, dynamic require) need explicit justification — the in-process plugin model means anything we import has full gateway access. Residual risks are tracked in the parent repo's `SECURITY_AUDIT.md`; if you discover a new one, add an entry there before merging.

**4. This repo is public — write for strangers, not insiders.** The plugin source ships to GitHub and runs on every user's host. Treat every comment, log line, error string, and identifier as user-readable.

- No backend architecture leaks: don't reference internal vendor names, project IDs, internal table names beyond what an endpoint already exposes, dashboard URLs, deploy hostnames, or service-internal tooling. Generic terms (`backend`, `auth provider`, `realtime channel`) over branded ones.
- No verbose internal commentary. Comments explain **why** a non-obvious thing is the way it is, not what the code does. No multi-paragraph docstrings, no walls of context that only make sense to someone on the team. If a reader needs three paragraphs to understand a function, the code is wrong, not the comments.
- No JIRA / Linear / PR / incident references in code. They rot, and they leak our process. Put that context in the commit message, where it belongs.
- No hardcoded internal URLs or staging hostnames. All endpoints come from `account.backendUrl` / `account.streamUrl` at runtime.
- Log lines are user-facing too — they end up in `journalctl` or the user's terminal. No stack-trace dumps with internal paths, no PII, no full bearer tokens (prefix-only is fine for diagnostics).
- Error messages exposed via the wrapper API are bounded (`.slice(0, 200)`, `[:200]`) for the same reason — bound the leak surface.

**Practical contract:**

- **Push == release.** Every `git push origin main` here must be paired with a fresh GitHub release **and** a `plugin_manifest` UPDATE in Supabase pinning the new version, URL, and sha256. Anything less leaves users on a stale pin while `main` claims a newer state. Follow the full 6-step runbook in [Cutting a new version](#cutting-a-new-version) — no shortcuts. The iOS app trusts the manifest, not `main`.
- Bump `package.json` version in the same PR as any user-visible change.
- New `/onepilot/v1/*` endpoint → contract test in `test/wrapper-api.test.js` + matching method in `OnepilotPluginClient.swift` in the app repo.
- Bootstrap commands (the very first `npm install`, the very first `plugins install --link`, the very first `gateway run`) are exempt — by definition the wrapper API doesn't exist yet.

## Repository layout

```
openclaw-onepilot-channel/
├── README.md            ← you are here
├── TESTING.md           ← end-to-end test sheet (foreground, force-quit, push, etc.)
├── package.json         ← npm metadata; `version` is the source of truth for releases
├── openclaw.plugin.json ← plugin manifest read by OpenClaw at install time
└── src/
    ├── index.js         ← register() hook: wires channel subscription + registers outbound
    ├── stream.js        ← inbound channel client over our raw WS (see ws-raw.js)
    ├── messaging.js     ← inbound dispatch: user message → agent loop → reply POST
    ├── outbound.js      ← outbound channel handler: cron / agent reply → backend
    ├── env.js           ← isolated runtime env reader (scanner-safe)
    ├── constants.js     ← shared user-agent string
    └── ws-raw.js        ← node:https-based WebSocket (built-in WebSocket is broken
                            inside the gateway process — see file header)
```

## Credential model

Each deployed agent holds its own **durable API key** (`agentKey`, prefix `oak_`). The app provisions one at pair time, the backend stores only an argon2id hash, and the raw key lives forever until the app revokes it. The plugin uses the key to:

- Exchange it on demand for a short-lived channel auth token (1h TTL). No rotation chain, no shared session state — each exchange is independent.
- Authenticate outbound message POSTs directly (the backend binds the key to `(userId, agentProfileId)` server-side).

Because nothing rotates and nothing is shared across agents, two gateways on the same user account can never collide on credentials. A key wedge is impossible.

## Configuring an account

Provisioned automatically by the app's deploy flow. Manual form:

```sh
openclaw --profile <agent-id> config set 'plugins.entries.onepilot.config.accounts.default' '{
  "enabled": true,
  "backendUrl": "https://api.onepilotapp.com",
  "streamUrl": "wss://api.onepilotapp.com",
  "publishableKey": "<publishable key>",
  "agentKey": "oak_...",
  "userId": "<uuid>",
  "agentProfileId": "<uuid>",
  "sessionKey": "main"
}'
```

## Distribution flow

We **do not** embed plugin source in the mobile binary. Plugin updates ship independently of App Store review.

```
┌────────────────────────┐      ┌──────────────────────┐      ┌─────────────────────┐
│  GitHub Release        │      │  plugin_manifest     │      │  Mobile app         │
│  sofiane8910/          │◀─────│  (channel='stable')  │─────▶│  PluginManifest     │
│  onepilotapp/releases  │      │  → version           │      │  Fetcher.fetch()    │
│                        │      │  → tarball_url       │      │                     │
│  onepilot-channel-     │      │  → sha256            │      │  ssh-installs over  │
│  v0.X.Y.tgz            │      │                      │      │  curl + sha256      │
└────────────────────────┘      └──────────────────────┘      │  + tar -xzf         │
                                                              └─────────────────────┘
```

1. Tag a release on `sofiane8910/onepilotapp` and attach the tgz tarball.
2. `UPDATE` the `plugin_manifest` row to point `tarball_url` and `sha256` at the new release.
3. On next agent deploy, the app reads the manifest, SSH-runs an install script on the agent host that `curl`s the tarball, verifies the sha256 inline (mismatch → abort, no files written), and `tar -xzf` into `~/.openclaw-<agentId>/plugins/openclaw-onepilot-channel/`, then runs `openclaw plugins install <dir> --link`.
4. The manifest row is the version pin — bump it whenever you want a new build to roll out.

The mobile-side reader is `ios/Sources/Onepilot/Models/Agent/Adapters/PluginManifestFetcher.swift`. The install flow lives in `OpenClawAdapter.swift` (`deployOnepilotChannelPlugin` → `installPluginFromRelease` → `buildUnixInstallScript` / `buildWindowsInstallScript`).

## Cutting a new version

Six steps. Skipping the sha256 re-fetch (#5) is the known footgun — GitHub re-uploads the asset on publish, so the digest you see while it's a draft does **not** match the published artifact.

1. **Bump** `version` in `package.json`. Refresh anything that mirrors it (the contract test in `test/wrapper-api.test.js` reads it via `package.json`, so usually nothing else).
2. **Commit + tag** in this repo: `git commit -am "Release vX.Y.Z" && git tag vX.Y.Z && git push --follow-tags`. Update the submodule pointer in `onepilotapp/` and push there too — the release CI in `onepilotapp` builds the tarball from that pointer.
3. **Watch the release CI** (`gh run watch -R sofiane8910/onepilotapp`) cut a draft GitHub Release with the tarball attached as an asset.
4. **Publish the draft**: `gh release edit "openclaw/onepilot-channel@vX.Y.Z" -R sofiane8910/onepilotapp --draft=false --latest=false`. Until this runs, the asset URL returns HTTP 404 and every iOS install fails fast.
5. **Re-fetch the canonical sha256** from the published asset (GitHub may have repacked):
   ```sh
   curl -sL "https://github.com/sofiane8910/onepilotapp/releases/download/openclaw/onepilot-channel%40vX.Y.Z/onepilot-channel-vX.Y.Z.tgz" \
     | shasum -a 256 | awk '{print $1}'
   ```
6. **Bump the manifest** in Supabase (one row, three columns):
   ```sql
   UPDATE public.plugin_manifest
   SET version = 'vX.Y.Z',
       tarball_url = 'https://github.com/sofiane8910/onepilotapp/releases/download/openclaw/onepilot-channel%40vX.Y.Z/onepilot-channel-vX.Y.Z.tgz',
       sha256 = '<sha from step 5>'
   WHERE channel = 'stable';
   ```
   Apply via `mcp__supabase_onepilot__execute_sql` (or the Supabase dashboard) — `service_role` is required because RLS denies DML to `anon`/`authenticated`. Existing agents pick up the new release on their next `ensureSyncSetup`; iOS doesn't need rebuilding.

## Rollback

If a release misbehaves, revert the `plugin_manifest` row to a known-good version and (optionally) yank the bad release. Existing agents won't downgrade automatically (the install script is a no-op when the installed version matches the manifest), but new deploys and reinstalls will pick up the rollback.

## See also

- `TESTING.md` — end-to-end test plan (foreground chat, force-quit, push dedup, multi-host).
- `/openclaw/` (in this monorepo) — upstream OpenClaw source. **Do not modify.**
- `ios/Sources/Onepilot/Models/Agent/Adapters/OpenClawAdapter.swift` — the deploy/install code.
- `ios/Sources/Onepilot/Models/Agent/Adapters/PluginManifestFetcher.swift` — manifest reader.
