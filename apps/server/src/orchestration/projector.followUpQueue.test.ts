import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = "thread-1";

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make(THREAD_ID),
    occurredAt: NOW,
    commandId: CommandId.make(`cmd-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

function queuedFollowUpPayload(input: {
  readonly id: string;
  readonly orderKey: string;
  readonly text?: string;
}) {
  return {
    threadId: THREAD_ID,
    followUp: {
      id: input.id,
      text: input.text ?? "keep going",
      attachments: [],
      runtimeMode: "full-access",
      interactionMode: "default",
      orderKey: input.orderKey,
      status: "pending",
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

function queuedEvent(input: {
  readonly sequence: number;
  readonly id: string;
  readonly orderKey: string;
  readonly text?: string;
}): OrchestrationEvent {
  return makeEvent({
    sequence: input.sequence,
    type: "thread.follow-up-queued",
    payload: queuedFollowUpPayload(input),
  });
}

const applyEvents = Effect.fn("applyEvents")(function* (events: ReadonlyArray<OrchestrationEvent>) {
  let model: OrchestrationReadModel = yield* projectEvent(
    createEmptyReadModel(NOW),
    makeEvent({
      sequence: 0,
      type: "thread.created",
      payload: {
        threadId: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "demo",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  );
  for (const event of events) {
    model = yield* projectEvent(model, event);
  }
  return model;
});

describe("orchestration projector: queued follow-ups", () => {
  it.effect("keeps the queue ordered by order key", () =>
    Effect.gen(function* () {
      const model = yield* applyEvents([
        queuedEvent({ sequence: 1, id: "follow-up-late", orderKey: "z" }),
        queuedEvent({ sequence: 2, id: "follow-up-head", orderKey: "b" }),
      ]);
      expect(model.threads[0]?.queuedFollowUps?.map((followUp) => followUp.id)).toEqual([
        "follow-up-head",
        "follow-up-late",
      ]);
    }),
  );

  it.effect("applies an edit and a reorder to the named follow-up", () =>
    Effect.gen(function* () {
      const model = yield* applyEvents([
        queuedEvent({ sequence: 1, id: "follow-up-1", orderKey: "b" }),
        queuedEvent({ sequence: 2, id: "follow-up-2", orderKey: "m" }),
        makeEvent({
          sequence: 3,
          type: "thread.follow-up-edited",
          payload: {
            threadId: THREAD_ID,
            followUpId: "follow-up-1",
            text: "actually, stop after the tests",
            updatedAt: NOW,
          },
        }),
        makeEvent({
          sequence: 4,
          type: "thread.follow-up-reordered",
          payload: {
            threadId: THREAD_ID,
            followUpId: "follow-up-1",
            orderKey: "z",
            updatedAt: NOW,
          },
        }),
      ]);
      const queue = model.threads[0]?.queuedFollowUps ?? [];
      expect(queue.map((followUp) => followUp.id)).toEqual(["follow-up-2", "follow-up-1"]);
      expect(queue.find((followUp) => followUp.id === "follow-up-1")?.text).toBe(
        "actually, stop after the tests",
      );
    }),
  );

  it.effect("pauses pending follow-ups when the queue is paused", () =>
    Effect.gen(function* () {
      const interrupted = yield* applyEvents([
        queuedEvent({ sequence: 1, id: "follow-up-1", orderKey: "b" }),
        makeEvent({
          sequence: 2,
          type: "thread.follow-up-paused",
          payload: { threadId: THREAD_ID, pausedAt: NOW },
        }),
      ]);
      expect(interrupted.threads[0]?.queuedFollowUps?.[0]?.status).toBe("paused");

      const stopped = yield* applyEvents([
        queuedEvent({ sequence: 1, id: "follow-up-1", orderKey: "b" }),
        makeEvent({
          sequence: 2,
          type: "thread.follow-up-paused",
          payload: { threadId: THREAD_ID, pausedAt: NOW },
        }),
      ]);
      expect(stopped.threads[0]?.queuedFollowUps?.[0]?.status).toBe("paused");
    }),
  );

  it.effect("resumes a paused queue when the user queues something new", () =>
    Effect.gen(function* () {
      const model = yield* applyEvents([
        queuedEvent({ sequence: 1, id: "follow-up-1", orderKey: "b" }),
        makeEvent({
          sequence: 2,
          type: "thread.follow-up-paused",
          payload: { threadId: THREAD_ID, pausedAt: NOW },
        }),
        queuedEvent({ sequence: 3, id: "follow-up-2", orderKey: "m" }),
      ]);
      expect(model.threads[0]?.queuedFollowUps?.map((followUp) => followUp.status)).toEqual([
        "pending",
        "pending",
      ]);
    }),
  );

  it.effect("resumes a paused queue on a dispatch, but not on a cancellation", () =>
    Effect.gen(function* () {
      const paused = yield* applyEvents([
        queuedEvent({ sequence: 1, id: "follow-up-1", orderKey: "b" }),
        queuedEvent({ sequence: 2, id: "follow-up-2", orderKey: "m" }),
        makeEvent({
          sequence: 3,
          type: "thread.follow-up-paused",
          payload: { threadId: THREAD_ID, pausedAt: NOW },
        }),
      ]);
      expect(paused.threads[0]?.queuedFollowUps?.map((followUp) => followUp.status)).toEqual([
        "paused",
        "paused",
      ]);

      const afterCancel = yield* projectEvent(
        paused,
        makeEvent({
          sequence: 4,
          type: "thread.follow-up-removed",
          payload: {
            threadId: THREAD_ID,
            followUpId: "follow-up-1",
            reason: "user",
            removedAt: NOW,
          },
        }),
      );
      expect(afterCancel.threads[0]?.queuedFollowUps?.map((followUp) => followUp.status)).toEqual([
        "paused",
      ]);

      const afterDispatch = yield* projectEvent(
        paused,
        makeEvent({
          sequence: 4,
          type: "thread.follow-up-removed",
          payload: {
            threadId: THREAD_ID,
            followUpId: "follow-up-1",
            reason: "dispatched",
            removedAt: NOW,
          },
        }),
      );
      expect(afterDispatch.threads[0]?.queuedFollowUps?.map((followUp) => followUp.status)).toEqual(
        ["pending"],
      );
    }),
  );

  it.effect("keeps a failed follow-up queued with its error, and never resumes it", () =>
    Effect.gen(function* () {
      const model = yield* applyEvents([
        queuedEvent({ sequence: 1, id: "follow-up-1", orderKey: "b" }),
        makeEvent({
          sequence: 2,
          type: "thread.follow-up-failed",
          payload: {
            threadId: THREAD_ID,
            followUpId: "follow-up-1",
            error: "thread was archived",
            updatedAt: NOW,
          },
        }),
        queuedEvent({ sequence: 3, id: "follow-up-2", orderKey: "m" }),
      ]);
      const queue = model.threads[0]?.queuedFollowUps ?? [];
      expect(queue.find((followUp) => followUp.id === "follow-up-1")).toMatchObject({
        status: "failed",
        lastError: "thread was archived",
      });
    }),
  );
});
