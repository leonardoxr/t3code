/**
 * Multi-environment subscription quota state.
 *
 * Each connected environment probes the provider CLIs it hosts and answers with
 * its own snapshot; the client keeps the most-spent figure per window, since a
 * plan exhausted on any connected machine is exhausted for the next turn.
 *
 * @module state/subscriptionUsage
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  SubscriptionUsageProvider,
  SubscriptionUsageSnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { mergeSubscriptionUsage } from "@t3tools/shared/subscriptionUsageView";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

interface EnvironmentSubscriptionUsage {
  readonly environmentId: EnvironmentId;
  readonly isPending: boolean;
  /** Waiting on this environment will not improve the figures. */
  readonly failed: boolean;
  readonly snapshot: SubscriptionUsageSnapshot | null;
}

/**
 * Reads every environment's quota snapshot. The query takes no arguments, so one
 * atom serves every reader; the gauges and any other consumer share the same
 * per-environment queries and their stale window.
 */
const subscriptionUsageAtom = Atom.make((get): readonly EnvironmentSubscriptionUsage[] => {
  const presentations = get(environmentPresentations.presentationsAtom);

  const statuses: EnvironmentSubscriptionUsage[] = [];
  for (const [environmentId] of presentations) {
    const result = get(serverEnvironment.subscriptionUsage({ environmentId, input: {} }));
    statuses.push({
      environmentId,
      isPending: result.waiting,
      failed: result._tag === "Failure",
      snapshot: Option.getOrNull(AsyncResult.value(result)),
    });
  }
  return statuses;
}).pipe(Atom.withLabel("web-subscription-usage"));

export interface SubscriptionUsageView {
  /** Reading order, limited to the providers some environment reported. */
  readonly providers: readonly SubscriptionUsageProvider[];
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  /**
   * True while environments that have not failed are still answering. A failed
   * environment is not "still reporting": the figures will not improve by
   * waiting on it.
   */
  readonly isPartial: boolean;
  readonly refresh: () => void;
}

export function useSubscriptionUsage(): SubscriptionUsageView {
  const environments = useAtomValue(subscriptionUsageAtom);

  // Refreshing only the derived atom would re-read the per-environment SWR
  // queries within their stale window and change nothing. Refresh each
  // environment's query so the figures are actually re-probed.
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

  const providers = useMemo(
    () =>
      mergeSubscriptionUsage(
        environments.flatMap((environment) =>
          environment.snapshot === null ? [] : [environment.snapshot],
        ),
      ),
    [environments],
  );

  const answeredCount = environments.filter((environment) => environment.snapshot !== null).length;
  const stillReporting = environments.filter(
    (environment) => environment.snapshot === null && !environment.failed,
  ).length;

  return {
    providers,
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refresh,
  };
}
