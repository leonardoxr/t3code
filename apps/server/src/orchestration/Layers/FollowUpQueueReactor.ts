import {
  CommandId,
  type OrchestrationEvent,
  type OrchestrationQueuedFollowUp,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  FollowUpQueueReactor,
  type FollowUpQueueReactorShape,
} from "../Services/FollowUpQueueReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

/**
 * The thread whose queue this event could have unblocked, or null when the
 * event cannot open the gate. Session writes carry every status transition (a
 * turn finishing lands there), the follow-up events change the queue itself,
 * and the response/resolution signals are how blocked-on-the-user work clears.
 */
function gateEventThreadId(event: OrchestrationEvent): ThreadId | null {
  switch (event.type) {
    case "thread.session-set":
    case "thread.follow-up-queued":
    case "thread.follow-up-edited":
    case "thread.follow-up-removed":
    case "thread.follow-up-reordered":
    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
      return event.payload.threadId;
    case "thread.activity-appended":
      return event.payload.activity.kind === "approval.resolved" ||
        event.payload.activity.kind === "user-input.resolved"
        ? event.payload.threadId
        : null;
    default:
      return null;
  }
}

/** Queue order is `orderKey` ascending with an id tiebreak, everywhere. */
function nextQueuedFollowUp(
  followUps: ReadonlyArray<OrchestrationQueuedFollowUp>,
): OrchestrationQueuedFollowUp | undefined {
  return [...followUps].toSorted(
    (left, right) => left.orderKey.localeCompare(right.orderKey) || left.id.localeCompare(right.id),
  )[0];
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionTurnRepository = yield* ProjectionTurnRepository;

  const markFollowUpFailed = Effect.fn("markFollowUpFailed")(function* (input: {
    readonly threadId: ThreadId;
    readonly followUpId: OrchestrationQueuedFollowUp["id"];
    readonly createdAt: string;
    readonly cause: Cause.Cause<unknown>;
  }) {
    yield* Effect.logWarning("follow-up queue reactor failed to dispatch a follow-up", {
      threadId: input.threadId,
      followUpId: input.followUpId,
      cause: Cause.pretty(input.cause),
    });
    // The follow-up keeps its place and blocks the queue: never a silent drop,
    // never a silent retry loop. Marking is best effort — if the thread itself
    // went away, so did its queue.
    yield* orchestrationEngine
      .dispatch({
        type: "thread.follow-up.fail",
        commandId: CommandId.make(`server:follow-up-fail:${input.followUpId}:${input.createdAt}`),
        threadId: input.threadId,
        followUpId: input.followUpId,
        error: Cause.pretty(input.cause).slice(0, 500),
        createdAt: input.createdAt,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("follow-up queue reactor could not mark a follow-up failed", {
            threadId: input.threadId,
            followUpId: input.followUpId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
  });

  const dispatchQueueHead = Effect.fn("dispatchQueueHead")(function* (threadId: ThreadId) {
    const threadDetail = yield* projectionSnapshotQuery.getThreadDetailById(threadId);
    if (Option.isNone(threadDetail)) {
      return;
    }
    const thread = threadDetail.value;
    if (thread.archivedAt !== null) {
      return;
    }

    const head = nextQueuedFollowUp(thread.queuedFollowUps ?? []);
    // A failed head blocks the queue on purpose: the user retries or removes it.
    // A paused head means the user stopped, and stop has to stop what is next.
    if (head === undefined || head.status !== "pending") {
      return;
    }

    // No session yet is fine — dispatching boots one, exactly like a first send.
    const sessionStatus = thread.session?.status;
    if (sessionStatus === "starting" || sessionStatus === "running" || sessionStatus === "error") {
      return;
    }

    // A turn start nothing has adopted yet is work in flight even while the
    // session still reads idle.
    const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
      threadId,
    });
    if (Option.isSome(pendingTurnStart)) {
      return;
    }

    const threadShell = yield* projectionSnapshotQuery.getThreadShellById(threadId);
    if (Option.isNone(threadShell)) {
      return;
    }
    if (threadShell.value.hasPendingApprovals || threadShell.value.hasPendingUserInput) {
      return;
    }

    const createdAt = DateTime.formatIso(yield* DateTime.now);
    // Deterministic command id: a retry after a restart replays the receipt
    // instead of sending the same follow-up twice.
    yield* orchestrationEngine
      .dispatch({
        type: "thread.follow-up.promote",
        commandId: CommandId.make(`server:follow-up-promote:${head.id}`),
        threadId,
        followUpId: head.id,
        createdAt,
      })
      .pipe(
        Effect.catchCause((cause) =>
          markFollowUpFailed({ threadId, followUpId: head.id, createdAt, cause }),
        ),
      );
  });

  const dispatchQueueHeadSafely = (threadId: ThreadId) =>
    dispatchQueueHead(threadId).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("follow-up queue reactor failed to evaluate a thread", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(dispatchQueueHeadSafely);

  const start: FollowUpQueueReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        const threadId = gateEventThreadId(event);
        return threadId === null ? Effect.void : worker.enqueue(threadId);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies FollowUpQueueReactorShape;
});

export const FollowUpQueueReactorLive = Layer.effect(FollowUpQueueReactor, make);
