/**
 * Multi-environment subscription quota state.
 *
 * Plan quota is account-level, not per environment: every connected machine
 * reports the same plans, so the readings are merged conservatively (the
 * highest `usedPercent` wins) rather than summed.
 *
 * Mirror of `apps/web/src/state/subscriptionUsage.ts` over mobile's atom
 * wiring, exactly as `./usage.ts` mirrors the web historical-spend state; the
 * merge rules themselves live in `@t3tools/shared/subscriptionUsageView`.
 *
 * @module state/subscriptionUsage
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  SubscriptionUsageProvider,
  SubscriptionUsageSnapshot,
} from "@t3tools/contracts";
import { mergeSubscriptionUsage } from "@t3tools/shared/subscriptionUsageView";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentSubscriptionUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly snapshot: SubscriptionUsageSnapshot | null;
}

/**
 * Reads every environment's quota snapshot. Unkeyed — the request carries no
 * input, so one atom serves every reader.
 */
const subscriptionUsageAtom = Atom.make((get): readonly EnvironmentSubscriptionUsageStatus[] => {
  const presentations = get(environmentPresentations.presentationsAtom);

  const statuses: EnvironmentSubscriptionUsageStatus[] = [];
  for (const [environmentId, presentation] of presentations) {
    const result = get(serverEnvironment.subscriptionUsage({ environmentId, input: {} }));
    statuses.push({
      environmentId,
      label: presentation.entry.target.label,
      isPending: result.waiting,
      error: result._tag === "Failure" ? "This environment could not report plan usage." : null,
      snapshot: Option.getOrNull(AsyncResult.value(result)),
    });
  }
  return statuses;
}).pipe(Atom.withLabel("mobile-subscription-usage:environments"));

export interface SubscriptionUsageView {
  /** Merged across environments, in `SUBSCRIPTION_USAGE_PROVIDER_ORDER`. */
  readonly providers: readonly SubscriptionUsageProvider[];
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  /**
   * True while environments that have not failed are still answering. A failed
   * environment will never improve the figures, so it must not read as "still
   * reporting".
   */
  readonly isPartial: boolean;
  readonly refresh: () => void;
}

export function useSubscriptionUsage(): SubscriptionUsageView {
  const environments = useAtomValue(subscriptionUsageAtom);

  // Refreshing only the derived atom would re-read the per-environment SWR
  // queries within their stale window and change nothing. Refresh each
  // environment's query so pull-to-refresh always re-probes the CLIs.
  const refresh = useCallback(() => {
    for (const environment of environments) {
      appAtomRegistry.refresh(
        serverEnvironment.subscriptionUsage({
          environmentId: environment.environmentId,
          input: {},
        }),
      );
    }
  }, [environments]);

  const providers = useMemo(() => {
    const snapshots: SubscriptionUsageSnapshot[] = environments.flatMap((environment) =>
      environment.snapshot === null ? [] : [environment.snapshot],
    );
    return mergeSubscriptionUsage(snapshots);
  }, [environments]);

  const answeredCount = environments.filter((environment) => environment.snapshot !== null).length;
  const stillReporting = environments.filter(
    (environment) => environment.snapshot === null && environment.error === null,
  ).length;

  return {
    providers,
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refresh,
  };
}
