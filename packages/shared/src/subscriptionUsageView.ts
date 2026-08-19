/**
 * Client-side reading of the subscription quota contract.
 *
 * Every connected environment probes the provider CLIs it hosts, so the same
 * plan is usually reported several times over. These helpers collapse those
 * reports into the single figure a gauge can show, and phrase the countdown
 * next to it.
 *
 * Pure: no React, no Effect runtime, so both clients and their tests share it.
 *
 * @module subscriptionUsageView
 */
import {
  SUBSCRIPTION_USAGE_CONTRACT_VERSION,
  type SubscriptionUsageProvider,
  type SubscriptionUsageProviderKind,
  type SubscriptionUsageSnapshot,
  type SubscriptionUsageStatus,
  type SubscriptionUsageWindow,
} from "@t3tools/contracts";

/**
 * Reading order for the gauges. Fixed rather than derived from the snapshots so
 * the rings never swap places as environments answer at different speeds.
 */
export const SUBSCRIPTION_USAGE_PROVIDER_ORDER = [
  "claude",
  "codex",
] as const satisfies readonly SubscriptionUsageProviderKind[];

/**
 * Window that decides whether the next turn runs: the most spent one.
 *
 * Among equally spent windows the one that rolls over soonest is the more
 * useful thing to show, because it is the one whose countdown is worth
 * watching; a window with no known reset never wins that tie, having no
 * countdown to offer.
 */
export function pickBindingWindow(
  windows: readonly SubscriptionUsageWindow[],
): SubscriptionUsageWindow | null {
  let binding: SubscriptionUsageWindow | null = null;
  for (const quotaWindow of windows) {
    if (binding === null || quotaWindow.usedPercent > binding.usedPercent) {
      binding = quotaWindow;
      continue;
    }
    if (quotaWindow.usedPercent < binding.usedPercent || quotaWindow.resetsAt === null) continue;
    if (binding.resetsAt === null || quotaWindow.resetsAt < binding.resetsAt) binding = quotaWindow;
  }
  return binding;
}

/** Mutable mirror of {@link SubscriptionUsageProvider} while reports are folded together. */
interface ProviderAccumulator {
  status: SubscriptionUsageStatus;
  detail: string | null;
  planLabel: string | null;
  /** Keyed by window id, insertion-ordered so a provider's own window order survives. */
  readonly windows: Map<string, { label: string; usedPercent: number; resetsAt: number | null }>;
  fetchedAt: number | null;
}

/**
 * Max `usedPercent` per (provider, window id) across environments; conservative
 * because any connected machine hitting its cap is the one that blocks you.
 *
 * Snapshots from an environment running older server code are dropped rather
 * than misread: a blank gauge is safer than a figure whose shape no longer
 * means what the client thinks it means.
 */
export function mergeSubscriptionUsage(
  snapshots: readonly SubscriptionUsageSnapshot[],
): readonly SubscriptionUsageProvider[] {
  const byProvider = new Map<SubscriptionUsageProviderKind, ProviderAccumulator>();

  for (const snapshot of snapshots) {
    if (snapshot.version !== SUBSCRIPTION_USAGE_CONTRACT_VERSION) continue;

    for (const reported of snapshot.providers) {
      let accumulator = byProvider.get(reported.provider);
      if (accumulator === undefined) {
        accumulator = {
          // The first report owns the excuse; any later `ok` supersedes it.
          status: reported.status,
          detail: reported.status === "ok" ? null : reported.detail,
          planLabel: null,
          windows: new Map(),
          fetchedAt: null,
        };
        byProvider.set(reported.provider, accumulator);
      } else if (reported.status === "ok" && accumulator.status !== "ok") {
        // Figures from one machine beat another machine's reason for having
        // none, and that reason stops being worth carrying once figures exist.
        accumulator.status = "ok";
        accumulator.detail = null;
      }

      // Only a probe that reached the account learns the plan name, so the
      // first machine to report one is the one that was signed in.
      accumulator.planLabel ??= reported.planLabel;
      if (reported.fetchedAt !== null) {
        accumulator.fetchedAt =
          accumulator.fetchedAt === null
            ? reported.fetchedAt
            : Math.max(accumulator.fetchedAt, reported.fetchedAt);
      }

      for (const quotaWindow of reported.windows) {
        const merged = accumulator.windows.get(quotaWindow.id);
        if (merged === undefined) {
          accumulator.windows.set(quotaWindow.id, {
            label: quotaWindow.label,
            usedPercent: quotaWindow.usedPercent,
            resetsAt: quotaWindow.resetsAt,
          });
          continue;
        }
        merged.usedPercent = Math.max(merged.usedPercent, quotaWindow.usedPercent);
        if (quotaWindow.resetsAt !== null) {
          merged.resetsAt =
            merged.resetsAt === null
              ? quotaWindow.resetsAt
              : Math.min(merged.resetsAt, quotaWindow.resetsAt);
        }
      }
    }
  }

  return SUBSCRIPTION_USAGE_PROVIDER_ORDER.flatMap((provider) => {
    const accumulator = byProvider.get(provider);
    if (accumulator === undefined) return [];
    return [
      {
        provider,
        status: accumulator.status,
        planLabel: accumulator.planLabel,
        windows: [...accumulator.windows].map(([id, folded]) => ({ id, ...folded })),
        fetchedAt: accumulator.fetchedAt,
        detail: accumulator.detail,
      } satisfies SubscriptionUsageProvider,
    ];
  });
}

const MINUTE_MS = 60_000;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/**
 * `resets in 42m`, `resets in 1h 14m`, `resets in 6d 17h`.
 *
 * Two units at most: a quota countdown is read at a glance, and the smaller
 * units churn the label without telling the reader anything they would act on.
 * Null once the window has rolled over, so a stale snapshot stops claiming a
 * reset is still pending.
 */
export function formatQuotaReset(resetsAt: number | null, nowMs: number): string | null {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return null;
  const remainingMs = resetsAt - nowMs;
  if (remainingMs <= 0) return null;

  // Rounded up so a window seconds away reads as `1m` rather than `0m`.
  const totalMinutes = Math.ceil(remainingMs / MINUTE_MS);
  const days = Math.floor(totalMinutes / MINUTES_PER_DAY);
  const hours = Math.floor((totalMinutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;

  if (days > 0) return hours === 0 ? `resets in ${days}d` : `resets in ${days}d ${hours}h`;
  if (hours > 0) return minutes === 0 ? `resets in ${hours}h` : `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}
