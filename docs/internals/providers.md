# Provider architecture

> For maintainers. Using T3 Code? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. T3 Code supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with six entries:

| Driver kind   | Driver source                           |
| ------------- | --------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]       |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]     |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]     |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]         |
| `omp`         | [`Drivers/OmpDriver.ts`][omp]           |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode] |

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

The `omp` driver wraps the Oh My Pi CLI (`omp`, npm package `@oh-my-pi/pi-coding-agent`). It is
ACP-based: the adapter spawns `omp acp` and speaks the Agent Client Protocol via
`packages/effect-acp`.

When the upstream model provider answers `429`, omp prints the raw error as the whole assistant
message and still ends the turn with `end_turn`, which would record a success whose only content is
an error blob. `OmpAdapter` recognizes that message (`parseOmpRateLimitNotice`, strict: the notice
must BE the message, so an agent quoting a 429 stays prose) and settles the turn as `failed`,
carrying `rateLimitResetsAt` on `turn.completed`. Ingestion turns that into a `turn.rate-limited`
activity, and the web working row labels the wait with the reset time instead of spinning silently
while omp backs off.

## Registry and routing

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

## How provider work is requested

Clients never call a provider directly. They dispatch orchestration commands over the RPC method
`orchestration.dispatchCommand`, defined with the rest of the orchestration surface in
[`orchestration.ts`][contracts]. The client-dispatchable provider-facing commands are
`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.checkpoint.revert`, and `thread.session.stop`, plus the mode
setters `thread.runtime-mode.set` and `thread.interaction-mode.set`.

The engine persists an event for the command, and a server-side reactor performs the provider call.
Provider output comes back as internal commands such as `thread.message.assistant.delta` and
`thread.session.set`, which clients observe through `orchestration.subscribeThread`. See
[overview.md](./overview.md) for the command/event loop.

## Server-side workers

Provider work flows through three queue-backed workers. All three are built with
`makeDrainableWorker` from [`DrainableWorker.ts`][worker] and expose `drain` for deterministic test
synchronization.

1. [`ProviderRuntimeIngestion`][ingest] consumes provider runtime streams and emits orchestration
   commands.
2. [`ProviderCommandReactor`][cmd] reacts to orchestration intent events and dispatches provider
   calls.
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion, and
   performs reverts.

### Buffered assistant delivery

A thread in `buffered` assistant delivery mode accumulates assistant text instead of streaming each
delta. The buffer is not held until turn completion. In [`ProviderRuntimeIngestion`][ingest],
`MAX_BUFFERED_ASSISTANT_CHARS` is 24,000: the append that would exceed it invalidates the buffer and
spills the whole accumulated text as one delta. The buffer also flushes at interaction boundaries,
when a request opens (approval) or user input is requested, via
`flushBufferedAssistantMessagesForTurn`.

## Plan quota probes

[`SubscriptionUsageService`][quota] answers `server.getSubscriptionUsage` with how much of each
provider plan's rolling quota is spent. It is deliberately separate from [`UsageService`][usage],
which reprices historical spend from transcripts: this one answers "will the next turn run".

Both providers are pulled rather than observed, because the gauge has to be populated with no thread
running:

- Claude: `GET https://api.anthropic.com/api/oauth/usage`, authenticated with Claude Code's own
  stored OAuth token (macOS login keychain, otherwise `<claudeHome>/.credentials.json`). The
  credential is read, never written — refreshing it is Claude Code's job. The response is treated as
  an open map of `{ utilization, resets_at }` buckets so plan windows we have never heard of still
  render.
- Codex: a short-lived `codex app-server` is spawned for `account/rateLimits/read`, typed by the
  generated protocol in `packages/effect-codex-app-server`. `rateLimitsByLimitId` is serialized in
  a different order on every call, so buckets are sorted by key or the gauge's windows reshuffle
  between polls.

Neither probe spends plan quota, so polling still works once a limit is reached. Both run
concurrently behind independent timeouts, and every failure becomes a per-provider status rather
than an RPC error, so one broken CLI cannot blank the other's gauge. Results are cached for a minute
per provider: spawning an app-server for every poll of every connected client is the cost that cache
exists to avoid.

A bucket that is both unused and has no reset time is dropped — that is how both providers report a
window the plan was never granted, and an empty ring reads as "0% spent" rather than "nothing to
report".

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[cursor]: ../../apps/server/src/provider/Drivers/CursorDriver.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts
[omp]: ../../apps/server/src/provider/Drivers/OmpDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[quota]: ../../apps/server/src/subscriptionUsage/SubscriptionUsageService.ts
[usage]: ../../apps/server/src/usage/UsageService.ts
