/**
 * Maps a provider's raw quota answer onto {@link SubscriptionUsageProvider}.
 *
 * Everything here is pure so the exact bodies the two CLIs return can be pinned
 * by tests without a network or a spawned binary; the probes beside this module
 * own the credential, HTTP, and stdio work.
 *
 * Both providers hand back an open-ended set of buckets - Anthropic keeps
 * adding codenamed windows to plans, and Codex reports one bucket per model
 * family - so nothing here enumerates the windows a plan is expected to have.
 *
 * @module subscriptionUsage/subscriptionUsageNormalize
 */
import type {
  SubscriptionUsageProvider,
  SubscriptionUsageProviderKind,
  SubscriptionUsageStatus,
  SubscriptionUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as CodexSchema from "effect-codex-app-server/schema";

/**
 * A quota bucket in Anthropic's response. Buckets carry more fields than this
 * (dollar limits, overage state); only the two that drive a gauge are read, and
 * unknown keys are ignored so a new field never breaks the read.
 */
const ClaudeQuotaBucket = Schema.Struct({
  utilization: Schema.Number,
  resets_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeClaudeQuotaBucket = Schema.decodeUnknownExit(ClaudeQuotaBucket);

/** The response is a flat map of bucket name to bucket, with no envelope. */
const ClaudeQuotaBody = Schema.Record(Schema.String, Schema.Unknown);
const decodeClaudeQuotaBody = Schema.decodeUnknownExit(ClaudeQuotaBody);

/** Buckets we have names for; anything else is title-cased from its key. */
const CLAUDE_WINDOW_LABELS: Readonly<Record<string, string>> = {
  five_hour: "5 hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly (Opus)",
  seven_day_sonnet: "Weekly (Sonnet)",
};

/** A purchased credit balance, not a rolling window, so it is never a gauge. */
const CLAUDE_CREDIT_BALANCE_KEY = "extra_usage";

/** Codex's own bucket. Its windows read better without the redundant name. */
const CODEX_DEFAULT_LIMIT_ID = "codex";

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const DAYS_PER_WEEK = 7;

/** The `rateLimits` view and the `rateLimitsByLimitId` entries share a shape. */
type CodexRateLimitBucket = CodexSchema.V2GetAccountRateLimitsResponse["rateLimits"];

function trimmedOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Keeps a reading inside the contract's `0-100` range, so one absurd figure
 * cannot fail the encode of the whole snapshot.
 *
 * Both CLIs already report a percentage, so an out-of-range value is a provider
 * bug rather than a fraction to rescale - rescaling would turn 0.9% used into a
 * nearly full ring.
 */
export function clampUsedPercent(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 100 ? 100 : value;
}

/** ISO-8601 to epoch ms; null when the provider omits or garbles the stamp. */
function epochMillisFromIso(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  return Option.match(DateTime.make(value), {
    onNone: () => null,
    onSome: (instant) => DateTime.toEpochMillis(instant),
  });
}

/** Codex stamps resets in epoch seconds; the contract carries epoch ms. */
function epochMillisFromSeconds(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value * 1000;
}

/** `nimbus_quill` reads as `Nimbus Quill` until we learn its real name. */
function titleCaseBucketKey(key: string): string {
  return key
    .split(/[_-]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

/**
 * Builds a window, dropping readings that describe nothing.
 *
 * An id or label that would violate the contract's non-empty check is dropped
 * so one malformed bucket cannot fail the whole snapshot. A bucket that is
 * simultaneously unused and has no reset time is dropped too: that is how both
 * providers report a window the plan was never granted (Anthropic lists every
 * codenamed bucket it knows, provisioned or not), and listing it would pad the
 * gauge's detail card with rows that can never move.
 */
function makeWindow(input: {
  readonly id: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt: number | null;
}): SubscriptionUsageWindow | null {
  const id = input.id.trim();
  const label = input.label.trim();
  if (id.length === 0 || label.length === 0) return null;
  const usedPercent = clampUsedPercent(input.usedPercent);
  if (usedPercent === 0 && input.resetsAt === null) return null;
  return {
    id,
    label,
    usedPercent,
    resetsAt: input.resetsAt,
  };
}

/**
 * A provider with no figures. The status and detail render in place of the
 * ring, which is why every probe failure funnels through here instead of
 * failing the RPC.
 */
export function emptySubscriptionUsage(
  provider: SubscriptionUsageProviderKind,
  status: Exclude<SubscriptionUsageStatus, "ok">,
  detail: string,
): SubscriptionUsageProvider {
  return {
    provider,
    status,
    planLabel: null,
    windows: [],
    fetchedAt: null,
    detail: trimmedOrNull(detail),
  };
}

/**
 * `10080` reads as `Weekly` and `300` as `5 hour`; every other duration falls
 * out of the same whole-unit rules. Null when the provider omits the duration.
 */
export function formatQuotaWindowDuration(minutes: number | null | undefined): string | null {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes % MINUTES_PER_DAY === 0) {
    const days = minutes / MINUTES_PER_DAY;
    if (days === 1) return "Daily";
    if (days === DAYS_PER_WEEK) return "Weekly";
    return `${days} day`;
  }
  if (minutes % MINUTES_PER_HOUR === 0) return `${minutes / MINUTES_PER_HOUR} hour`;
  return `${minutes} minute`;
}

/**
 * Turns Anthropic's `GET /api/oauth/usage` body into the claude gauge.
 *
 * Every top-level entry carrying a numeric `utilization` becomes a window, so a
 * plan that grows a new bucket renders it without a release. Buckets a plan
 * does not have arrive as `null` and are skipped.
 */
export function normalizeClaudeQuota(
  body: unknown,
  context: { readonly planLabel: string | null; readonly fetchedAtMs: number },
): SubscriptionUsageProvider {
  const decoded = decodeClaudeQuotaBody(body);
  if (decoded._tag === "Failure") {
    return emptySubscriptionUsage(
      "claude",
      "unavailable",
      "Anthropic returned an unreadable quota response.",
    );
  }

  const windows: SubscriptionUsageWindow[] = [];
  for (const [key, value] of Object.entries(decoded.value)) {
    if (value === null || key === CLAUDE_CREDIT_BALANCE_KEY) continue;
    const bucket = decodeClaudeQuotaBucket(value);
    if (bucket._tag === "Failure") continue;
    const window = makeWindow({
      id: key,
      label: CLAUDE_WINDOW_LABELS[key] ?? titleCaseBucketKey(key),
      usedPercent: bucket.value.utilization,
      resetsAt: epochMillisFromIso(bucket.value.resets_at),
    });
    if (window !== null) windows.push(window);
  }

  return {
    provider: "claude",
    status: "ok",
    planLabel: trimmedOrNull(context.planLabel),
    windows,
    fetchedAt: context.fetchedAtMs,
    detail: null,
  };
}

/**
 * `rateLimitsByLimitId` carries every bucket the account has. Servers that
 * predate it fill only the single `rateLimits` view, which is the same shape
 * under its own id.
 *
 * The bucket map arrives in a different order on every call, so it is sorted
 * here: an unsorted list would reshuffle the rendered windows between polls.
 */
function codexRateLimitBuckets(
  response: CodexSchema.V2GetAccountRateLimitsResponse,
): ReadonlyArray<readonly [string, CodexRateLimitBucket]> {
  const byLimitId = response.rateLimitsByLimitId;
  if (byLimitId) {
    const entries = Object.entries(byLimitId);
    if (entries.length > 0) {
      return entries
        .map(([key, bucket]) => [trimmedOrNull(bucket.limitId) ?? key, bucket] as const)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    }
  }
  const single = response.rateLimits;
  return [[trimmedOrNull(single.limitId) ?? CODEX_DEFAULT_LIMIT_ID, single] as const];
}

function codexWindowLabel(
  limitKey: string,
  limitName: string | null | undefined,
  minutes: number | null | undefined,
): string {
  const name = trimmedOrNull(limitName) ?? (limitKey === CODEX_DEFAULT_LIMIT_ID ? null : limitKey);
  const duration = formatQuotaWindowDuration(minutes);
  if (name === null) return duration ?? limitKey;
  return duration === null ? name : `${name} ${duration}`;
}

/**
 * Turns `account/rateLimits/read` into the codex gauge.
 *
 * A bucket reports up to two windows; the secondary one takes an id suffix so
 * the pair stays distinguishable when clients merge windows across machines.
 */
export function normalizeCodexRateLimits(
  response: CodexSchema.V2GetAccountRateLimitsResponse,
  context: { readonly fetchedAtMs: number },
): SubscriptionUsageProvider {
  const windows: SubscriptionUsageWindow[] = [];
  let planLabel: string | null = null;

  for (const [limitKey, bucket] of codexRateLimitBuckets(response)) {
    planLabel ??= trimmedOrNull(bucket.planType);
    const slots = [
      ["", bucket.primary],
      [":secondary", bucket.secondary],
    ] as const;
    for (const [suffix, slot] of slots) {
      if (!slot) continue;
      const window = makeWindow({
        id: `${limitKey}${suffix}`,
        label: codexWindowLabel(limitKey, bucket.limitName, slot.windowDurationMins),
        usedPercent: slot.usedPercent,
        resetsAt: epochMillisFromSeconds(slot.resetsAt),
      });
      if (window !== null) windows.push(window);
    }
  }

  return {
    provider: "codex",
    status: "ok",
    planLabel,
    windows,
    fetchedAt: context.fetchedAtMs,
    detail: null,
  };
}
