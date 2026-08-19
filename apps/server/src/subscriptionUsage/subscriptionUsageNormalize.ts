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

/**
 * The modern shape of the same answer. It supersedes the flat bucket map, and it
 * is not redundant with it: a model-scoped weekly limit (Fable's, say) appears
 * only here, while the legacy `seven_day_opus`-style keys for it read `null`.
 * Reading the map alone silently hid whichever limit was actually binding.
 */
const ClaudeQuotaLimit = Schema.Struct({
  kind: Schema.String,
  percent: Schema.Number,
  resets_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  scope: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        model: Schema.optionalKey(
          Schema.NullOr(
            Schema.Struct({
              display_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
      }),
    ),
  ),
});
const decodeClaudeQuotaLimits = Schema.decodeUnknownExit(Schema.Array(ClaudeQuotaLimit));

/** Buckets we have names for; anything else is title-cased from its key. */
const CLAUDE_WINDOW_LABELS: Readonly<Record<string, string>> = {
  five_hour: "5 hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly (Opus)",
  seven_day_sonnet: "Weekly (Sonnet)",
};

/** `kind` values from the `limits` array. Scoped limits name their model instead. */
const CLAUDE_LIMIT_KIND_LABELS: Readonly<Record<string, string>> = {
  session: "5 hour",
  weekly_all: "Weekly",
};

/** Keys the flat map exposes that the `limits` array already covers. */
const CLAUDE_LIMIT_KIND_IDS: Readonly<Record<string, string>> = {
  session: "five_hour",
  weekly_all: "seven_day",
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
 * Windows from the modern `limits` array, or null when the response predates it.
 *
 * A `weekly_scoped` entry is the only place a model-scoped limit appears, and it
 * is regularly the binding one, so this is preferred over the flat bucket map
 * rather than merged with it: the two describe the same plan, and merging would
 * double-count the session and weekly windows under two different ids.
 */
function claudeWindowsFromLimits(body: Record<string, unknown>): SubscriptionUsageWindow[] | null {
  const raw = body["limits"];
  if (raw === undefined || raw === null) return null;
  const decoded = decodeClaudeQuotaLimits(raw);
  if (decoded._tag === "Failure") return null;

  const windows: SubscriptionUsageWindow[] = [];
  const seen = new Set<string>();
  for (const limit of decoded.value) {
    const model = trimmedOrNull(limit.scope?.model?.display_name);
    const id =
      CLAUDE_LIMIT_KIND_IDS[limit.kind] ??
      (model === null ? limit.kind : `${limit.kind}:${model.toLowerCase()}`);
    // A plan can report several scoped limits; the id keeps them apart, and a
    // repeated id would otherwise render the same row twice.
    if (seen.has(id)) continue;
    const label =
      CLAUDE_LIMIT_KIND_LABELS[limit.kind] ??
      (model === null ? titleCaseBucketKey(limit.kind) : `Weekly (${model})`);
    const window = makeWindow({
      id,
      label,
      usedPercent: limit.percent,
      resetsAt: epochMillisFromIso(limit.resets_at),
    });
    if (window === null) continue;
    seen.add(id);
    windows.push(window);
  }
  return windows.length === 0 ? null : windows;
}

/** Windows from the legacy flat bucket map, for responses without `limits`. */
function claudeWindowsFromBuckets(body: Record<string, unknown>): SubscriptionUsageWindow[] {
  const windows: SubscriptionUsageWindow[] = [];
  for (const [key, value] of Object.entries(body)) {
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
  return windows;
}

/**
 * Turns Anthropic's `GET /api/oauth/usage` body into the claude gauge.
 *
 * The response carries the same plan twice: a modern `limits` array and a legacy
 * flat map of buckets. The array wins where present because it is the only one
 * that reports model-scoped weekly limits; the map is the fallback, and either
 * way an unrecognised entry still renders so a new limit needs no release.
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

  return {
    provider: "claude",
    status: "ok",
    planLabel: trimmedOrNull(context.planLabel),
    windows: claudeWindowsFromLimits(decoded.value) ?? claudeWindowsFromBuckets(decoded.value),
    fetchedAt: context.fetchedAtMs,
    detail: null,
  };
}

/**
 * The one bucket that is the plan's own quota.
 *
 * `rateLimitsByLimitId` also carries per-model buckets — a Spark allowance, say —
 * which are a different allowance rather than more of the same one, and showing
 * them next to the plan's makes the gauge read as though the plan had more left
 * than it does. `rateLimits` is documented as the single-bucket view of the
 * binding limit, so it names which entry that is; the map is consulted only to
 * recover the richer copy of that same bucket.
 */
function codexPlanRateLimitBucket(
  response: CodexSchema.V2GetAccountRateLimitsResponse,
): readonly [string, CodexRateLimitBucket] {
  const single = response.rateLimits;
  const limitId = trimmedOrNull(single.limitId) ?? CODEX_DEFAULT_LIMIT_ID;
  const byLimitId = response.rateLimitsByLimitId;
  const preferred = byLimitId?.[limitId];
  return [limitId, preferred ?? single] as const;
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
 * Only the plan's own bucket is reported; see {@link codexPlanRateLimitBucket}.
 * That bucket carries up to two windows, and the secondary one takes an id suffix
 * so the pair stays distinguishable when clients merge windows across machines.
 */
export function normalizeCodexRateLimits(
  response: CodexSchema.V2GetAccountRateLimitsResponse,
  context: { readonly fetchedAtMs: number },
): SubscriptionUsageProvider {
  const [limitKey, bucket] = codexPlanRateLimitBucket(response);
  const windows: SubscriptionUsageWindow[] = [];
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

  return {
    provider: "codex",
    status: "ok",
    planLabel: trimmedOrNull(bucket.planType),
    windows,
    fetchedAt: context.fetchedAtMs,
    detail: null,
  };
}
