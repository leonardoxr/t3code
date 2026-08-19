import type { SubscriptionUsageProvider } from "@t3tools/contracts";

import { formatQuotaReset, pickBindingWindow } from "@t3tools/shared/subscriptionUsageView";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { PROVIDER_PRESENTATION } from "../usage/usageProviders";

// Geometry cloned from the chat context-window meter so a plan gauge and a
// context gauge read as the same instrument at the same glance.
const RADIUS = 9.75;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const TRACK_COLOR = "color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)";
const OVERLOADED_PERCENT = 90;

/**
 * Whole percent, except that a plan short of its cap never reads as `100%`: the
 * difference between "no turns left" and "one more turn" is the whole point of
 * the gauge.
 */
function formatUsedPercent(usedPercent: number): string {
  return `${usedPercent >= 100 ? 100 : Math.min(99, Math.round(usedPercent))}%`;
}

/**
 * One provider's plan quota as a ring around its mark.
 *
 * The ring tracks the window that will stop you first, so the sidebar answers
 * "can I start another turn?" without opening anything; the hover card itemises
 * every window behind that figure. Clicking leads to the usage page, which is
 * still where historical spend lives.
 */
export function SubscriptionUsageMeter({
  provider,
  onClick,
  onPeek,
}: {
  readonly provider: SubscriptionUsageProvider;
  readonly onClick: () => void;
  /**
   * Called when the detail card is about to be read. Looking at the figures is
   * the moment they most need to be current, so this asks for a re-read; the
   * caller decides how often that is allowed to reach a provider.
   */
  readonly onPeek: () => void;
}) {
  const { label, color, mark: Mark } = PROVIDER_PRESENTATION[provider.provider];
  const bindingWindow = pickBindingWindow(provider.windows);
  const usedPercent = Math.max(0, Math.min(100, bindingWindow?.usedPercent ?? 0));
  const usageColor = usedPercent > OVERLOADED_PERCENT ? "var(--color-error)" : color;
  const dashOffset = CIRCUMFERENCE * (1 - usedPercent / 100);
  // Read per render rather than on a timer: the countdowns move by the minute,
  // and the snapshot behind them is itself only re-read once a minute.
  const nowMs = Date.now();

  return (
    <SidebarMenuItem className="shrink-0">
      <Popover
        onOpenChange={(open) => {
          if (open) onPeek();
        }}
      >
        <PopoverTrigger
          openOnHover
          delay={150}
          closeDelay={0}
          render={
            <SidebarMenuButton
              aria-label={
                bindingWindow === null
                  ? `${label} plan usage`
                  : `${label} plan ${formatUsedPercent(usedPercent)} used`
              }
              onClick={onClick}
              size="icon"
            >
              <span className="relative flex size-5 items-center justify-center">
                <svg
                  viewBox="0 0 24 24"
                  className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
                  aria-hidden="true"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r={RADIUS}
                    fill="none"
                    stroke={TRACK_COLOR}
                    strokeWidth="3"
                  />
                  <circle
                    cx="12"
                    cy="12"
                    r={RADIUS}
                    fill="none"
                    stroke={usageColor}
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeDasharray={CIRCUMFERENCE}
                    strokeDashoffset={dashOffset}
                    className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                  />
                </svg>
                <Mark className="size-2.5 shrink-0" aria-hidden />
              </span>
            </SidebarMenuButton>
          }
        />
        <PopoverPopup
          tooltipStyle
          side="top"
          viewportClassName="p-0"
          className="w-72 max-w-none text-left whitespace-normal"
        >
          <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
            <div className="flex items-center justify-between gap-3">
              <div className="font-medium text-muted-foreground text-xs">{label}</div>
              {provider.planLabel === null ? null : (
                <div className="text-secondary-label text-[11px] capitalize">
                  {provider.planLabel}
                </div>
              )}
            </div>
            {bindingWindow === null ? null : (
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(usedPercent)}
                aria-label={`${label} ${bindingWindow.label} quota used`}
              >
                <div
                  className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                  style={{ width: `${usedPercent}%`, backgroundColor: usageColor }}
                />
              </div>
            )}
            {provider.windows.length === 0 ? (
              <div className="text-secondary-label text-[11px] leading-4">
                This plan reported no quota windows.
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {provider.windows.map((quotaWindow) => {
                  const reset = formatQuotaReset(quotaWindow.resetsAt, nowMs);
                  return (
                    <div
                      key={quotaWindow.id}
                      className="flex items-baseline justify-between gap-x-3 text-[11px] leading-4"
                    >
                      {/* Model-specific windows carry long names; the reading stays
                          aligned by truncating the label rather than wrapping the row.
                          Truncation is visual only, so the full name still reaches
                          assistive tech. */}
                      <span className="min-w-0 truncate text-secondary-label">
                        {quotaWindow.label}
                      </span>
                      <span className="shrink-0 whitespace-nowrap font-medium tabular-nums text-secondary-label">
                        {formatUsedPercent(quotaWindow.usedPercent)} used
                        {reset === null ? "" : ` · ${reset}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </PopoverPopup>
      </Popover>
    </SidebarMenuItem>
  );
}
