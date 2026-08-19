/**
 * Plan-quota gauges for the top of the Usage screen.
 *
 * Rings, not bars: `react-native-svg` is already a direct dependency of this
 * app and is used for chrome throughout it (`components/T3Wordmark.tsx`,
 * `settings/appearance/sections/ThemeAppearanceSection.tsx`), so the web
 * `ContextWindowMeter` ring reproduces here — same viewBox 24, r 9.75,
 * strokeWidth 3, quarter-turn start — without adding a package. The neighbouring
 * spend chart draws with plain views only because stacked bars need no arc
 * maths, not because SVG is unavailable.
 *
 * Each card gauges the *binding* window (the one that decides whether the next
 * turn runs) and lists every window with its reset countdown underneath.
 */
import type { SubscriptionUsageProvider } from "@t3tools/contracts";
import { formatQuotaReset, pickBindingWindow } from "@t3tools/shared/subscriptionUsageView";
import { useEffect, useState } from "react";
import { View } from "react-native";
import Svg, { Circle, G } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { PROVIDER_LABEL, PROVIDER_ORDER, useProviderColors } from "./usageProviders";

const RING_SIZE = 44;
const RING_RADIUS = 9.75;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * Countdowns are minute-granular, so a minute tick keeps them honest without
 * repainting continuously.
 */
function useNowMs(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return nowMs;
}

export function SubscriptionQuotaGauges(props: {
  readonly providers: readonly SubscriptionUsageProvider[];
}) {
  const nowMs = useNowMs();
  const colors = useProviderColors();

  // Only providers with figures get a card: a ring for a CLI that is signed
  // out, too old, or unreachable would gauge nothing, so it is dropped rather
  // than drawn empty. Fixed order, so cards never swap as answers arrive.
  const gauges = PROVIDER_ORDER.flatMap((kind) => {
    const provider = props.providers.find((entry) => entry.provider === kind);
    if (provider === undefined || provider.status !== "ok") return [];
    const binding = pickBindingWindow(provider.windows);
    return binding === null ? [] : [{ provider, binding }];
  });
  if (gauges.length === 0) return null;

  return (
    <View className="gap-2">
      <Text className="px-2 text-sm font-t3-medium text-foreground-muted">Plan quota</Text>
      <View className="flex-row items-stretch gap-3">
        {gauges.map(({ provider, binding }) => (
          <View
            key={provider.provider}
            className="flex-1 gap-3 rounded-[24px] border-continuous bg-card p-4"
          >
            <View className="flex-row items-center gap-3">
              <QuotaRing usedPercent={binding.usedPercent} color={colors[provider.provider]} />
              <View className="flex-1 gap-0.5">
                <Text numberOfLines={1} className="text-base text-foreground">
                  {PROVIDER_LABEL[provider.provider]}
                </Text>
                <Text numberOfLines={1} className="text-xs text-foreground-muted">
                  {provider.planLabel === null ? binding.label : `${provider.planLabel} plan`}
                </Text>
              </View>
            </View>
            <View className="gap-1">
              {provider.windows.map((window) => (
                <Text key={window.id} className="text-xs text-foreground-muted">
                  {[
                    window.label,
                    `${formatQuotaPercent(window.usedPercent)} used`,
                    formatQuotaReset(window.resetsAt, nowMs),
                  ]
                    .filter((part): part is string => part !== null)
                    .join(" · ")}
                </Text>
              ))}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

/** Whole percents once past 10%, so the ring's caption stays a stable width. */
function formatQuotaPercent(usedPercent: number): string {
  if (usedPercent < 10) return `${usedPercent.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(usedPercent)}%`;
}

/**
 * The web context-window ring, redrawn in `react-native-svg`. The arc starts at
 * twelve o'clock, and a nearly spent window turns the danger colour so the card
 * reads at a glance.
 */
function QuotaRing(props: { readonly usedPercent: number; readonly color: string }) {
  const trackColor = useThemeColor("--color-subtle");
  const dangerColor = useThemeColor("--color-danger-foreground");
  const clamped = Math.max(0, Math.min(100, props.usedPercent));
  const strokeColor = clamped > 90 ? String(dangerColor) : props.color;

  return (
    <View style={{ width: RING_SIZE, height: RING_SIZE }} className="items-center justify-center">
      <Svg
        accessibilityElementsHidden
        width={RING_SIZE}
        height={RING_SIZE}
        viewBox="0 0 24 24"
        style={{ position: "absolute" }}
      >
        <G originX={12} originY={12} rotation={-90}>
          <Circle
            cx={12}
            cy={12}
            r={RING_RADIUS}
            fill="none"
            stroke={String(trackColor)}
            strokeWidth={3}
          />
          <Circle
            cx={12}
            cy={12}
            r={RING_RADIUS}
            fill="none"
            stroke={strokeColor}
            strokeWidth={3}
            strokeLinecap="round"
            /* Dash and gap both a full turn, spelled out: Android's dash path
               effect rejects an odd-length pattern, so the web's bare
               `strokeDasharray={circumference}` cannot cross over as-is. */
            strokeDasharray={[RING_CIRCUMFERENCE, RING_CIRCUMFERENCE]}
            strokeDashoffset={RING_CIRCUMFERENCE * (1 - clamped / 100)}
          />
        </G>
      </Svg>
      <Text className="text-[10px] tabular-nums text-foreground">
        {formatQuotaPercent(clamped)}
      </Text>
    </View>
  );
}
