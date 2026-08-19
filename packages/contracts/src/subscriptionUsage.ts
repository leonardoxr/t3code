/**
 * Subscription quota contract.
 *
 * Distinct from `./usage.ts`: that module reports *historical spend* recomputed
 * from provider transcripts, while this one reports *how much of a plan's
 * rolling quota is gone right now* — the number that decides whether the next
 * turn is allowed to run.
 *
 * Each environment pulls the figures from the provider CLIs it already hosts,
 * so a plan's usage is reported even when the spend happened outside T3 Code:
 *
 * - Claude reads the account quota endpoint with Claude Code's own OAuth token.
 * - Codex asks a short-lived `codex app-server` for `account/rateLimits/read`.
 *
 * Neither probe spends plan quota, so this can be polled while a plan is
 * exhausted. A provider that cannot be probed reports a {@link
 * SubscriptionUsageStatus} instead of failing the request, so one broken CLI
 * never blanks the other's gauge.
 *
 * @module subscriptionUsage
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Bumped whenever {@link SubscriptionUsageSnapshot} changes incompatibly.
 * Clients drop a snapshot from an older environment rather than misreading it.
 */
export const SUBSCRIPTION_USAGE_CONTRACT_VERSION = 1 as const;

/** Providers that expose a plan quota. Matches `UsageProviderKind`. */
export const SubscriptionUsageProviderKind = Schema.Literals(["claude", "codex"]);
export type SubscriptionUsageProviderKind = typeof SubscriptionUsageProviderKind.Type;

/**
 * Why a provider has no figures.
 *
 * - `ok` - {@link SubscriptionUsageProvider.windows} is populated.
 * - `unauthenticated` - the CLI is installed but not signed in to a plan (or is
 *   on an API key, which has no plan quota).
 * - `unsupported` - the installed CLI is too old to report quota.
 * - `unavailable` - the probe failed; `detail` says how.
 */
export const SubscriptionUsageStatus = Schema.Literals([
  "ok",
  "unauthenticated",
  "unsupported",
  "unavailable",
]);
export type SubscriptionUsageStatus = typeof SubscriptionUsageStatus.Type;

/**
 * One rolling quota window.
 *
 * Providers disagree on how many windows a plan has and what they are called,
 * so windows are carried as a list and rendered generically. `usedPercent` is
 * normalised to `0-100` even where a provider reports a `0-1` fraction.
 */
export const SubscriptionUsageWindow = Schema.Struct({
  /** Stable per provider, e.g. `five_hour`, `seven_day`, `codex`, `codex_bengalfox`. */
  id: TrimmedNonEmptyString,
  /** Display name, e.g. `5 hour`, `Weekly`, `Spark weekly`. */
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  /** Epoch ms when the window rolls over, or null when the provider omits it. */
  resetsAt: Schema.NullOr(Schema.Number),
});
export type SubscriptionUsageWindow = typeof SubscriptionUsageWindow.Type;

export const SubscriptionUsageProvider = Schema.Struct({
  provider: SubscriptionUsageProviderKind,
  status: SubscriptionUsageStatus,
  /** Plan name as the provider states it, e.g. `max`, `pro`. */
  planLabel: Schema.NullOr(TrimmedNonEmptyString),
  windows: Schema.Array(SubscriptionUsageWindow),
  /** Epoch ms the figures were pulled; stale values keep rendering. */
  fetchedAt: Schema.NullOr(Schema.Number),
  /** Human-readable cause when `status` is not `ok`. */
  detail: Schema.NullOr(TrimmedNonEmptyString),
});
export type SubscriptionUsageProvider = typeof SubscriptionUsageProvider.Type;

export const SubscriptionUsageSnapshot = Schema.Struct({
  version: Schema.Literal(SUBSCRIPTION_USAGE_CONTRACT_VERSION),
  providers: Schema.Array(SubscriptionUsageProvider),
});
export type SubscriptionUsageSnapshot = typeof SubscriptionUsageSnapshot.Type;
