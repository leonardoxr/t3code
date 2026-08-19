import { describe, expect, it } from "@effect/vitest";
import type * as CodexSchema from "effect-codex-app-server/schema";

import {
  clampUsedPercent,
  formatQuotaWindowDuration,
  normalizeClaudeQuota,
  normalizeCodexRateLimits,
} from "./subscriptionUsageNormalize.ts";

const FETCHED_AT_MS = 1_787_100_000_000;

/** Captured from `GET https://api.anthropic.com/api/oauth/usage` on a max plan. */
const claudeQuotaBody = {
  five_hour: {
    utilization: 98.0,
    resets_at: "2026-08-19T04:09:59.962494+00:00",
    limit_dollars: null,
  },
  seven_day: {
    utilization: 29.0,
    resets_at: "2026-08-25T19:59:59.962516+00:00",
    limit_dollars: null,
  },
  seven_day_opus: null,
  seven_day_sonnet: null,
  seven_day_cowork: null,
  extra_usage: {
    is_enabled: false,
    monthly_limit: null,
    used_credits: null,
    utilization: null,
  },
};

const codexWeeklyPrimary = {
  usedPercent: 100,
  windowDurationMins: 10080,
  resetsAt: 1787196617,
};

/** Captured from `account/rateLimits/read` on a pro plan with a Spark bucket. */
const codexRateLimitsResponse = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: codexWeeklyPrimary,
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null,
    spendControlReached: false,
    planType: "pro",
    rateLimitReachedType: "rate_limit_reached",
  },
  // Declared out of order: the app-server serialises this map differently on
  // every call, so the normaliser has to impose an order of its own.
  rateLimitsByLimitId: {
    codex_bengalfox: {
      limitId: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1787196617 },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      individualLimit: null,
      spendControlReached: false,
      planType: "pro",
      rateLimitReachedType: null,
    },
    codex: {
      limitId: "codex",
      limitName: null,
      primary: codexWeeklyPrimary,
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      individualLimit: null,
      spendControlReached: false,
      planType: "pro",
      rateLimitReachedType: "rate_limit_reached",
    },
  },
} satisfies CodexSchema.V2GetAccountRateLimitsResponse;

describe("normalizeClaudeQuota", () => {
  it("maps the live max-plan response and drops the buckets the plan lacks", () => {
    const provider = normalizeClaudeQuota(claudeQuotaBody, {
      planLabel: "max",
      fetchedAtMs: FETCHED_AT_MS,
    });

    expect(provider).toEqual({
      provider: "claude",
      status: "ok",
      planLabel: "max",
      fetchedAt: FETCHED_AT_MS,
      detail: null,
      windows: [
        {
          id: "five_hour",
          label: "5 hour",
          usedPercent: 98,
          resetsAt: Date.parse("2026-08-19T04:09:59.962Z"),
        },
        {
          id: "seven_day",
          label: "Weekly",
          usedPercent: 29,
          resetsAt: Date.parse("2026-08-25T19:59:59.962Z"),
        },
      ],
    });
  });

  it("renders a codenamed bucket the client has never heard of", () => {
    const provider = normalizeClaudeQuota(
      { nimbus_quill: { utilization: 4, resets_at: null } },
      { planLabel: null, fetchedAtMs: FETCHED_AT_MS },
    );

    expect(provider.windows).toEqual([
      { id: "nimbus_quill", label: "Nimbus Quill", usedPercent: 4, resetsAt: null },
    ]);
    expect(provider.planLabel).toBeNull();
  });

  it("drops a bucket that is both unused and never resets, because the plan lacks it", () => {
    const provider = normalizeClaudeQuota(
      {
        five_hour: { utilization: 12, resets_at: "2026-08-19T04:09:59.962494+00:00" },
        cinder_cove: { utilization: 0, resets_at: null },
      },
      { planLabel: "max", fetchedAtMs: FETCHED_AT_MS },
    );

    expect(provider.windows.map((window) => window.id)).toEqual(["five_hour"]);
  });

  it("keeps an unused bucket that does reset, because spending against it is possible", () => {
    const provider = normalizeClaudeQuota(
      { seven_day: { utilization: 0, resets_at: "2026-08-25T19:59:59.962516+00:00" } },
      { planLabel: "max", fetchedAtMs: FETCHED_AT_MS },
    );

    expect(provider.windows.map((window) => window.id)).toEqual(["seven_day"]);
  });

  it("reports an unreadable body as unavailable rather than as an empty plan", () => {
    const provider = normalizeClaudeQuota("not a quota document", {
      planLabel: "max",
      fetchedAtMs: FETCHED_AT_MS,
    });

    expect(provider.status).toBe("unavailable");
    expect(provider.windows).toEqual([]);
    expect(provider.fetchedAt).toBeNull();
  });
});

describe("normalizeCodexRateLimits", () => {
  it("maps every bucket of the live pro-plan response in a stable order", () => {
    const provider = normalizeCodexRateLimits(codexRateLimitsResponse, {
      fetchedAtMs: FETCHED_AT_MS,
    });

    expect(provider).toEqual({
      provider: "codex",
      status: "ok",
      planLabel: "pro",
      fetchedAt: FETCHED_AT_MS,
      detail: null,
      windows: [
        { id: "codex", label: "Weekly", usedPercent: 100, resetsAt: 1787196617000 },
        {
          id: "codex_bengalfox",
          label: "GPT-5.3-Codex-Spark Weekly",
          usedPercent: 12,
          resetsAt: 1787196617000,
        },
      ],
    });
  });

  it("falls back to the single rateLimits view when no bucket map is sent", () => {
    const provider = normalizeCodexRateLimits(
      {
        rateLimits: {
          ...codexRateLimitsResponse.rateLimits,
          secondary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1787100000 },
        },
      },
      { fetchedAtMs: FETCHED_AT_MS },
    );

    expect(provider.windows).toEqual([
      { id: "codex", label: "Weekly", usedPercent: 100, resetsAt: 1787196617000 },
      { id: "codex:secondary", label: "5 hour", usedPercent: 42, resetsAt: 1787100000000 },
    ]);
  });
});

describe("clampUsedPercent", () => {
  it("keeps readings inside the range the contract encodes", () => {
    expect(clampUsedPercent(0.42)).toBe(0.42);
    expect(clampUsedPercent(132)).toBe(100);
    expect(clampUsedPercent(-5)).toBe(0);
    expect(clampUsedPercent(Number.NaN)).toBe(0);
  });

  it("clamps through the normalisers, so one absurd figure cannot fail the encode", () => {
    const claude = normalizeClaudeQuota(
      { five_hour: { utilization: 118, resets_at: null } },
      { planLabel: null, fetchedAtMs: FETCHED_AT_MS },
    );
    const codex = normalizeCodexRateLimits(
      {
        rateLimits: {
          ...codexRateLimitsResponse.rateLimits,
          primary: { usedPercent: -3, windowDurationMins: 10080, resetsAt: 1787196617 },
        },
      },
      { fetchedAtMs: FETCHED_AT_MS },
    );

    expect(claude.windows[0]?.usedPercent).toBe(100);
    expect(codex.windows[0]?.usedPercent).toBe(0);
  });
});

describe("formatQuotaWindowDuration", () => {
  it("names whole-unit windows and falls back to the raw duration", () => {
    expect(formatQuotaWindowDuration(10080)).toBe("Weekly");
    expect(formatQuotaWindowDuration(300)).toBe("5 hour");
    expect(formatQuotaWindowDuration(1440)).toBe("Daily");
    expect(formatQuotaWindowDuration(4320)).toBe("3 day");
    expect(formatQuotaWindowDuration(90)).toBe("90 minute");
    expect(formatQuotaWindowDuration(null)).toBeNull();
  });
});
