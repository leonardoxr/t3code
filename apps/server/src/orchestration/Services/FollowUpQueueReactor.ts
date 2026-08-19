/**
 * FollowUpQueueReactor - Dispatcher for queued follow-ups.
 *
 * Sends the head of a thread's follow-up queue once that thread is genuinely
 * ready: no turn starting or running, no outstanding session error, and nothing
 * waiting on the user. That gate is the correctness core of the feature — a
 * queue that can fire into a pending approval or an errored session is worse
 * than no queue at all.
 *
 * @module FollowUpQueueReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * FollowUpQueueReactorShape - Service API for queued follow-up dispatch.
 */
export interface FollowUpQueueReactorShape {
  /**
   * Start reacting to the domain events that can open the dispatch gate.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * FollowUpQueueReactor - Service tag for queued follow-up dispatch workers.
 */
export class FollowUpQueueReactor extends Context.Service<
  FollowUpQueueReactor,
  FollowUpQueueReactorShape
>()("t3/orchestration/Services/FollowUpQueueReactor") {}
