import {
  SUBSCRIPTION_USAGE_CONTRACT_VERSION,
  type SubscriptionUsageProvider,
  type SubscriptionUsageSnapshot,
  type SubscriptionUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatQuotaReset,
  mergeSubscriptionUsage,
  pickBindingWindow,
} from "./subscriptionUsageView.ts";

const NOW = Date.UTC(2026, 7, 19, 12, 0, 0);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function usageWindow(overrides: Partial<SubscriptionUsageWindow> = {}): SubscriptionUsageWindow {
  return {
    id: "five_hour",
    label: "5 hour",
    usedPercent: 10,
    resetsAt: NOW + HOUR_MS,
    ...overrides,
  };
}

function provider(overrides: Partial<SubscriptionUsageProvider> = {}): SubscriptionUsageProvider {
  return {
    provider: "claude",
    status: "ok",
    planLabel: "max",
    windows: [usageWindow()],
    fetchedAt: NOW,
    detail: null,
    ...overrides,
  };
}

function snapshot(
  providers: readonly SubscriptionUsageProvider[],
  version: number = SUBSCRIPTION_USAGE_CONTRACT_VERSION,
): SubscriptionUsageSnapshot {
  // An environment running older server code reports a version the contract no
  // longer declares, which is exactly the case the merge has to survive.
  return { version, providers } as SubscriptionUsageSnapshot;
}

describe("pickBindingWindow", () => {
  it("picks the most spent window", () => {
    const binding = pickBindingWindow([
      usageWindow({ id: "five_hour", usedPercent: 40 }),
      usageWindow({ id: "seven_day", usedPercent: 91 }),
      usageWindow({ id: "seven_day_opus", usedPercent: 12 }),
    ]);

    expect(binding?.id).toBe("seven_day");
    expect(binding?.usedPercent).toBe(91);
  });

  it("breaks ties on the soonest reset", () => {
    const binding = pickBindingWindow([
      usageWindow({ id: "seven_day", usedPercent: 80, resetsAt: NOW + 6 * DAY_MS }),
      usageWindow({ id: "five_hour", usedPercent: 80, resetsAt: NOW + 2 * HOUR_MS }),
      usageWindow({ id: "monthly", usedPercent: 80, resetsAt: null }),
    ]);

    expect(binding?.id).toBe("five_hour");
  });

  it("prefers a window with a known reset over one without, at equal spend", () => {
    const binding = pickBindingWindow([
      usageWindow({ id: "monthly", usedPercent: 50, resetsAt: null }),
      usageWindow({ id: "five_hour", usedPercent: 50, resetsAt: NOW + HOUR_MS }),
    ]);

    expect(binding?.id).toBe("five_hour");
  });

  it("has nothing to bind on when there are no windows", () => {
    expect(pickBindingWindow([])).toBeNull();
  });
});

describe("mergeSubscriptionUsage", () => {
  it("keeps the highest spend and soonest reset per window id across environments", () => {
    const stale = provider({
      fetchedAt: NOW - 30_000,
      windows: [
        usageWindow({ id: "five_hour", usedPercent: 12, resetsAt: NOW + 2 * HOUR_MS }),
        usageWindow({ id: "seven_day", label: "Weekly", usedPercent: 70, resetsAt: NOW + DAY_MS }),
      ],
    });
    const fresh = provider({
      fetchedAt: NOW,
      windows: [
        usageWindow({ id: "five_hour", usedPercent: 98, resetsAt: NOW + 4 * HOUR_MS }),
        usageWindow({ id: "seven_day", label: "Weekly", usedPercent: 29, resetsAt: NOW + DAY_MS }),
      ],
    });

    const merged = mergeSubscriptionUsage([snapshot([stale]), snapshot([fresh])]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.windows).toEqual([
      { id: "five_hour", label: "5 hour", usedPercent: 98, resetsAt: NOW + 2 * HOUR_MS },
      { id: "seven_day", label: "Weekly", usedPercent: 70, resetsAt: NOW + DAY_MS },
    ]);
    expect(merged[0]?.fetchedAt).toBe(NOW);
  });

  it("orders providers for reading rather than by who answered first", () => {
    const merged = mergeSubscriptionUsage([
      snapshot([provider({ provider: "codex", planLabel: "pro" }), provider()]),
    ]);

    expect(merged.map((entry) => entry.provider)).toEqual(["claude", "codex"]);
  });

  it("drops snapshots from an environment on an incompatible contract version", () => {
    const merged = mergeSubscriptionUsage([
      snapshot([provider({ windows: [usageWindow({ usedPercent: 100 })] })], 0),
      snapshot([provider({ windows: [usageWindow({ usedPercent: 5 })] })]),
    ]);

    expect(merged[0]?.windows[0]?.usedPercent).toBe(5);
  });

  it("reports nothing when every snapshot is on an incompatible version", () => {
    expect(mergeSubscriptionUsage([snapshot([provider()], 99)])).toEqual([]);
  });

  it("lets figures from one environment beat another environment's excuse", () => {
    const merged = mergeSubscriptionUsage([
      snapshot([
        provider({
          status: "unauthenticated",
          planLabel: null,
          windows: [],
          fetchedAt: null,
          detail: "Claude Code is not signed in.",
        }),
      ]),
      snapshot([provider({ windows: [usageWindow({ usedPercent: 42 })] })]),
    ]);

    expect(merged[0]?.status).toBe("ok");
    expect(merged[0]?.detail).toBeNull();
    expect(merged[0]?.planLabel).toBe("max");
    expect(merged[0]?.windows[0]?.usedPercent).toBe(42);
  });

  it("carries the first excuse when no environment has figures", () => {
    const merged = mergeSubscriptionUsage([
      snapshot([
        provider({
          status: "unavailable",
          windows: [],
          detail: "codex app-server timed out.",
        }),
      ]),
      snapshot([
        provider({ status: "unsupported", windows: [], detail: "Installed CLI is too old." }),
      ]),
    ]);

    expect(merged[0]?.status).toBe("unavailable");
    expect(merged[0]?.detail).toBe("codex app-server timed out.");
  });

  it("has nothing to report without snapshots", () => {
    expect(mergeSubscriptionUsage([])).toEqual([]);
  });
});

describe("formatQuotaReset", () => {
  it("reads in minutes under an hour", () => {
    expect(formatQuotaReset(NOW + 42 * 60_000, NOW)).toBe("resets in 42m");
  });

  it("reads in hours and minutes within a day", () => {
    expect(formatQuotaReset(NOW + 74 * 60_000, NOW)).toBe("resets in 1h 14m");
  });

  it("drops the minutes when an hour lands exactly", () => {
    expect(formatQuotaReset(NOW + 2 * HOUR_MS, NOW)).toBe("resets in 2h");
  });

  it("reads in days and hours beyond a day", () => {
    expect(formatQuotaReset(NOW + 6 * DAY_MS + 17 * HOUR_MS, NOW)).toBe("resets in 6d 17h");
  });

  it("rounds a window seconds away up to a minute", () => {
    expect(formatQuotaReset(NOW + 30_000, NOW)).toBe("resets in 1m");
  });

  it("stops claiming a reset is pending once the window has rolled over", () => {
    expect(formatQuotaReset(NOW - 60_000, NOW)).toBeNull();
    expect(formatQuotaReset(NOW, NOW)).toBeNull();
  });

  it("has nothing to say when the provider omits the reset", () => {
    expect(formatQuotaReset(null, NOW)).toBeNull();
  });
});
