/**
 * SubscriptionUsageService - reports how much of each provider plan's rolling
 * quota is already gone.
 *
 * Distinct from `../usage/UsageService.ts`: that one reprices historical spend
 * from transcripts, this one answers "will the next turn run". Both providers
 * are probed concurrently and independently, and every failure becomes a
 * per-provider status, so `read` never fails and one broken CLI never blanks
 * the other's gauge.
 *
 * Results are cached for a minute per provider. Spawning a `codex app-server`
 * for every poll of every connected client is the cost this exists to avoid.
 *
 * @module subscriptionUsage/SubscriptionUsageService
 */
import {
  SUBSCRIPTION_USAGE_CONTRACT_VERSION,
  type SubscriptionUsageProvider,
  type SubscriptionUsageProviderKind,
  type SubscriptionUsageSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type { HttpClient } from "effect/unstable/http";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerSettings from "../serverSettings.ts";
import { probeClaudeSubscriptionUsage } from "./claudeQuotaProbe.ts";
import { probeCodexSubscriptionUsage } from "./codexQuotaProbe.ts";
import { emptySubscriptionUsage } from "./subscriptionUsageNormalize.ts";

/** Snapshot order, so gauges never reshuffle between reads. */
const PROVIDER_ORDER = ["claude", "codex"] as const;

/**
 * Hard ceilings per probe. Claude is one HTTP round trip; Codex has to boot a
 * CLI first, which is around 1.5 seconds on a warm machine.
 */
const PROBE_TIMEOUT_MS: Readonly<Record<SubscriptionUsageProviderKind, number>> = {
  claude: 5_000,
  codex: 8_000,
};

/**
 * Quota windows move in hours, so a minute-old figure is still the right one
 * and every client polling in that minute shares a single probe.
 */
const CACHE_TTL_MS = 60_000;

/** Bounded, because the detail travels to every client on every read. */
const MAX_DETAIL_LENGTH = 300;

/** The services the probes need, materialized once so `read` stays `R = never`. */
type ProbeServices =
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner;

interface CacheEntry {
  readonly value: SubscriptionUsageProvider;
  readonly cachedAtMs: number;
}

/**
 * Turns a failed probe into a sentence for the gauge's detail line. Not every
 * Error carries a usable `message` - some of Effect's control-flow errors leave
 * it undefined - so the name is the fallback before the generic wording.
 */
function describeProbeFailure(cause: Cause.Cause<unknown>): string {
  const squashed = Cause.squash(cause);
  const message =
    squashed instanceof Error
      ? (squashed.message ?? squashed.name)
      : typeof squashed === "string"
        ? squashed
        : String(squashed);
  const trimmed = typeof message === "string" ? message.trim() : "";
  if (trimmed.length === 0) return "The quota probe failed.";
  return trimmed.length > MAX_DETAIL_LENGTH
    ? `${trimmed.slice(0, MAX_DETAIL_LENGTH - 1)}\u2026`
    : trimmed;
}

export class SubscriptionUsageService extends Context.Service<
  SubscriptionUsageService,
  {
    readonly read: () => Effect.Effect<SubscriptionUsageSnapshot>;
  }
>()("t3/subscriptionUsage/SubscriptionUsageService") {}

/** Empty providers, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  SubscriptionUsageService,
  SubscriptionUsageService.of({
    read: () =>
      Effect.succeed({
        version: SUBSCRIPTION_USAGE_CONTRACT_VERSION,
        providers: [],
      }),
  }),
);

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const probeContext = yield* Effect.context<ProbeServices>();

  const cache = new Map<SubscriptionUsageProviderKind, CacheEntry>();
  const inFlight = new Map<
    SubscriptionUsageProviderKind,
    Deferred.Deferred<SubscriptionUsageProvider>
  >();

  /**
   * Runs one provider's probe. A disabled provider is answered from settings
   * rather than by spawning anything the user has switched off.
   */
  const probe = Effect.fn("SubscriptionUsageService.probe")(function* (
    provider: SubscriptionUsageProviderKind,
  ) {
    const settings = yield* settingsService.getSettings;
    if (provider === "claude") {
      const claude = settings.providers.claudeAgent;
      return claude.enabled
        ? yield* probeClaudeSubscriptionUsage(claude)
        : emptySubscriptionUsage(
            "claude",
            "unavailable",
            "Claude is disabled in T3 Code settings.",
          );
    }
    const codex = settings.providers.codex;
    return codex.enabled
      ? yield* probeCodexSubscriptionUsage(codex)
      : emptySubscriptionUsage("codex", "unavailable", "Codex is disabled in T3 Code settings.");
  });

  /**
   * Probes and caches. Timeouts, transport failures, and defects all land as an
   * `unavailable` status, which is why `read` has no error channel.
   */
  const refresh = Effect.fn("SubscriptionUsageService.refresh")(function* (
    provider: SubscriptionUsageProviderKind,
  ) {
    const value = yield* probe(provider).pipe(
      Effect.provideContext(probeContext),
      // Interrupting on timeout is what closes the probe's scope, so a codex
      // app-server that never answers is still reaped before we give up on it.
      Effect.timeoutOption(PROBE_TIMEOUT_MS[provider]),
      Effect.map(
        Option.match({
          onNone: () =>
            emptySubscriptionUsage(
              provider,
              "unavailable",
              `The ${provider} quota probe timed out after ${PROBE_TIMEOUT_MS[provider] / 1000}s.`,
            ),
          onSome: (probed) => probed,
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.succeed(
          emptySubscriptionUsage(provider, "unavailable", describeProbeFailure(cause)),
        ),
      ),
    );
    const cachedAtMs = yield* Clock.currentTimeMillis;
    cache.set(provider, { value, cachedAtMs });
    return value;
  });

  const readProvider = Effect.fn("SubscriptionUsageService.readProvider")(function* (
    provider: SubscriptionUsageProviderKind,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const cached = cache.get(provider);
    if (cached !== undefined && now - cached.cachedAtMs < CACHE_TTL_MS) return cached.value;

    const pending = inFlight.get(provider);
    if (pending !== undefined) {
      // Someone else is already refreshing. Handing back the stale figures
      // keeps the gauge on screen; only a cold read has to wait for the probe.
      return cached !== undefined ? cached.value : yield* Deferred.await(pending);
    }

    // Registered without an await point between the lookup above and this
    // insert, so two concurrent reads can never both start a probe.
    const deferred = Deferred.makeUnsafe<SubscriptionUsageProvider>();
    inFlight.set(provider, deferred);
    return yield* refresh(provider).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          inFlight.delete(provider);
        }).pipe(Effect.andThen(Deferred.done(deferred, exit))),
      ),
    );
  });

  const read = Effect.fn("SubscriptionUsageService.read")(function* () {
    const providers = yield* Effect.all(
      PROVIDER_ORDER.map((provider) => readProvider(provider)),
      { concurrency: "unbounded" },
    );
    return {
      version: SUBSCRIPTION_USAGE_CONTRACT_VERSION,
      providers,
    } satisfies SubscriptionUsageSnapshot;
  });

  return SubscriptionUsageService.of({ read });
});

export const layer = Layer.effect(SubscriptionUsageService, make);
