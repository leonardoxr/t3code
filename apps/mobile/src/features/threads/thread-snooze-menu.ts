import type { MenuAction } from "@react-native-menu/menu";
import {
  resolveSnoozePresets,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-snooze";

/** Preset rows shared by the row's Snooze submenu and the swipe Snooze menu. */
export function buildSnoozePresetMenuItems(presets: ReadonlyArray<SnoozePreset>): MenuAction[] {
  return presets.map((preset) => ({
    id: `snooze:${preset.id}`,
    title: preset.label,
    subtitle: preset.whenLabel,
  }));
}

/**
 * Snooze half of a thread row's long-press menu. A snoozed row offers the way
 * back out (Wake) instead of more snooze times; a row that cannot be snoozed
 * right now (waiting on the user, or starting a turn) offers neither.
 */
export function buildThreadSnoozeMenuItems(input: {
  readonly snoozed: boolean;
  readonly presets: ReadonlyArray<SnoozePreset>;
}): MenuAction[] {
  if (input.snoozed) {
    return [{ id: "unsnooze", title: "Wake", image: "clock" }];
  }
  if (input.presets.length === 0) return [];
  return [
    {
      id: "snooze",
      title: "Snooze",
      image: "clock",
      subactions: buildSnoozePresetMenuItems(input.presets),
    },
  ];
}

/**
 * Native menus snapshot their items when opened, so a preset row ("This
 * evening") can be tapped after its own wake time has passed. Re-resolve
 * against the current clock, and fall back to the displayed preset only while
 * its wake time is still in the future.
 */
export function resolveSnoozeMenuSelection(input: {
  readonly event: string;
  readonly displayedPresets: ReadonlyArray<SnoozePreset>;
  readonly now: Date;
}):
  | { readonly _tag: "selected"; readonly preset: SnoozePreset }
  | { readonly _tag: "expired" }
  | { readonly _tag: "not-snooze" } {
  if (!input.event.startsWith("snooze:")) return { _tag: "not-snooze" };

  const currentPreset = resolveSnoozePresets(input.now).find(
    (candidate) => input.event === `snooze:${candidate.id}`,
  );
  if (currentPreset) return { _tag: "selected", preset: currentPreset };

  const displayedPreset = input.displayedPresets.find(
    (candidate) => input.event === `snooze:${candidate.id}`,
  );
  if (displayedPreset && Date.parse(displayedPreset.snoozedUntil) > input.now.getTime()) {
    return { _tag: "selected", preset: displayedPreset };
  }
  return { _tag: "expired" };
}
