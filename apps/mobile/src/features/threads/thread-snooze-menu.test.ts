import { resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-snooze";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadSnoozeMenuItems, resolveSnoozeMenuSelection } from "./thread-snooze-menu";

describe("buildThreadSnoozeMenuItems", () => {
  it("offers the way back out for a snoozed row", () => {
    const items = buildThreadSnoozeMenuItems({
      snoozed: true,
      presets: resolveSnoozePresets(new Date(2026, 4, 8, 10)),
    });

    expect(items.map((item) => item.id)).toEqual(["unsnooze"]);
  });

  it("nests every preset under one Snooze entry", () => {
    const presets = resolveSnoozePresets(new Date(2026, 4, 8, 10));
    const items = buildThreadSnoozeMenuItems({ snoozed: false, presets });

    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("snooze");
    expect(items[0]?.subactions?.map((subaction) => subaction.id)).toEqual(
      presets.map((preset) => `snooze:${preset.id}`),
    );
  });

  it("offers nothing when the thread cannot be snoozed right now", () => {
    expect(buildThreadSnoozeMenuItems({ snoozed: false, presets: [] })).toEqual([]);
  });
});

describe("resolveSnoozeMenuSelection", () => {
  it("accepts a displayed evening preset while its wake time is still future", () => {
    const menuOpenedAt = new Date(2026, 4, 8, 16, 59, 30);
    const selectedAt = new Date(2026, 4, 8, 17, 0, 30);
    const displayedPresets = resolveSnoozePresets(menuOpenedAt);

    const selection = resolveSnoozeMenuSelection({
      event: "snooze:evening",
      displayedPresets,
      now: selectedAt,
    });

    expect(selection).toEqual({
      _tag: "selected",
      preset: displayedPresets.find((preset) => preset.id === "evening"),
    });
  });

  it("expires a displayed preset once its wake time has passed", () => {
    const displayedPresets = resolveSnoozePresets(new Date(2026, 4, 8, 16, 59, 30));

    expect(
      resolveSnoozeMenuSelection({
        event: "snooze:evening",
        displayedPresets,
        now: new Date(2026, 4, 8, 18, 0, 1),
      }),
    ).toEqual({ _tag: "expired" });
  });

  it("recomputes presets that remain available instead of using old timestamps", () => {
    const displayedPresets = resolveSnoozePresets(new Date(2026, 4, 8, 10));
    const selectedAt = new Date(2026, 4, 8, 10, 30);
    const selection = resolveSnoozeMenuSelection({
      event: "snooze:hour",
      displayedPresets,
      now: selectedAt,
    });

    expect(selection._tag).toBe("selected");
    if (selection._tag === "selected") {
      expect(selection.preset.snoozedUntil).toBe(
        new Date(selectedAt.getTime() + 60 * 60 * 1_000).toISOString(),
      );
    }
  });

  it("ignores menu events that are not snooze presets", () => {
    expect(
      resolveSnoozeMenuSelection({
        event: "archive",
        displayedPresets: resolveSnoozePresets(new Date(2026, 4, 8, 10)),
        now: new Date(2026, 4, 8, 10),
      }),
    ).toEqual({ _tag: "not-snooze" });
  });
});
