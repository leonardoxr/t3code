import { describe, expect, it } from "vite-plus/test";

import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  QueuedFollowUpId,
  ThreadId,
} from "@t3tools/contracts";
import type { OrchestrationQueuedFollowUp, OrchestrationThread } from "@t3tools/contracts";

import { applyThreadDetailEvent } from "./threadReducer.ts";

const NOW = "2026-04-01T00:00:00.000Z";
const LATER = "2026-04-01T01:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

const baseEventFields = {
  eventId: EventId.make("event-1"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  sequence: 1,
  occurredAt: LATER,
  aggregateKind: "thread",
  aggregateId: THREAD_ID,
} as const;

function makeFollowUp(
  overrides?: Partial<OrchestrationQueuedFollowUp>,
): OrchestrationQueuedFollowUp {
  return {
    id: QueuedFollowUpId.make("follow-up-1"),
    text: "keep going",
    attachments: [],
    runtimeMode: "full-access",
    interactionMode: "default",
    orderKey: "m",
    status: "pending",
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeThread(queuedFollowUps?: ReadonlyArray<OrchestrationQueuedFollowUp>) {
  const thread: OrchestrationThread = {
    id: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    title: "Test Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...(queuedFollowUps === undefined ? {} : { queuedFollowUps }),
  };
  return thread;
}

function expectUpdated(result: ReturnType<typeof applyThreadDetailEvent>): OrchestrationThread {
  if (result.kind !== "updated") {
    throw new Error(`Expected an updated thread, got "${result.kind}".`);
  }
  return result.thread;
}

describe("applyThreadDetailEvent: queued follow-ups", () => {
  it("appends a queued follow-up in order-key order", () => {
    const thread = expectUpdated(
      applyThreadDetailEvent(makeThread([makeFollowUp({ orderKey: "z" })]), {
        ...baseEventFields,
        type: "thread.follow-up-queued",
        payload: {
          threadId: THREAD_ID,
          followUp: makeFollowUp({ id: QueuedFollowUpId.make("follow-up-head"), orderKey: "b" }),
        },
      }),
    );
    expect(thread.queuedFollowUps?.map((followUp) => followUp.id)).toEqual([
      "follow-up-head",
      "follow-up-1",
    ]);
  });

  it("edits and reorders the named follow-up", () => {
    const edited = expectUpdated(
      applyThreadDetailEvent(makeThread([makeFollowUp()]), {
        ...baseEventFields,
        type: "thread.follow-up-edited",
        payload: {
          threadId: THREAD_ID,
          followUpId: QueuedFollowUpId.make("follow-up-1"),
          text: "changed my mind",
          updatedAt: LATER,
        },
      }),
    );
    expect(edited.queuedFollowUps?.[0]).toMatchObject({
      text: "changed my mind",
      updatedAt: LATER,
    });

    const reordered = expectUpdated(
      applyThreadDetailEvent(
        makeThread([
          makeFollowUp({ id: QueuedFollowUpId.make("follow-up-1"), orderKey: "b" }),
          makeFollowUp({ id: QueuedFollowUpId.make("follow-up-2"), orderKey: "m" }),
        ]),
        {
          ...baseEventFields,
          type: "thread.follow-up-reordered",
          payload: {
            threadId: THREAD_ID,
            followUpId: QueuedFollowUpId.make("follow-up-1"),
            orderKey: "z",
            updatedAt: LATER,
          },
        },
      ),
    );
    expect(reordered.queuedFollowUps?.map((followUp) => followUp.id)).toEqual([
      "follow-up-2",
      "follow-up-1",
    ]);
  });

  it("pauses pending follow-ups when the user interrupts or stops", () => {
    const interrupted = expectUpdated(
      applyThreadDetailEvent(makeThread([makeFollowUp()]), {
        ...baseEventFields,
        type: "thread.turn-interrupt-requested",
        payload: { threadId: THREAD_ID, createdAt: LATER },
      }),
    );
    expect(interrupted.queuedFollowUps?.[0]?.status).toBe("paused");

    const stopped = expectUpdated(
      applyThreadDetailEvent(makeThread([makeFollowUp()]), {
        ...baseEventFields,
        type: "thread.session-stop-requested",
        payload: { threadId: THREAD_ID, createdAt: LATER },
      }),
    );
    expect(stopped.queuedFollowUps?.[0]?.status).toBe("paused");
  });

  it("reports unchanged for an interrupt that touches neither turn nor queue", () => {
    const result = applyThreadDetailEvent(makeThread([makeFollowUp({ status: "paused" })]), {
      ...baseEventFields,
      type: "thread.turn-interrupt-requested",
      payload: { threadId: THREAD_ID, createdAt: LATER },
    });
    expect(result.kind).toBe("unchanged");
  });

  it("resumes paused siblings on a dispatch, but not on a cancellation", () => {
    const queue = [
      makeFollowUp({ id: QueuedFollowUpId.make("follow-up-1"), status: "paused", orderKey: "b" }),
      makeFollowUp({ id: QueuedFollowUpId.make("follow-up-2"), status: "paused", orderKey: "m" }),
    ];

    const afterDispatch = expectUpdated(
      applyThreadDetailEvent(makeThread(queue), {
        ...baseEventFields,
        type: "thread.follow-up-removed",
        payload: {
          threadId: THREAD_ID,
          followUpId: QueuedFollowUpId.make("follow-up-1"),
          reason: "dispatched",
          removedAt: LATER,
        },
      }),
    );
    expect(afterDispatch.queuedFollowUps?.map((followUp) => followUp.status)).toEqual(["pending"]);

    const afterCancel = expectUpdated(
      applyThreadDetailEvent(makeThread(queue), {
        ...baseEventFields,
        type: "thread.follow-up-removed",
        payload: {
          threadId: THREAD_ID,
          followUpId: QueuedFollowUpId.make("follow-up-1"),
          reason: "user",
          removedAt: LATER,
        },
      }),
    );
    expect(afterCancel.queuedFollowUps?.map((followUp) => followUp.status)).toEqual(["paused"]);
  });

  it("marks a follow-up failed with its error", () => {
    const thread = expectUpdated(
      applyThreadDetailEvent(makeThread([makeFollowUp()]), {
        ...baseEventFields,
        type: "thread.follow-up-failed",
        payload: {
          threadId: THREAD_ID,
          followUpId: QueuedFollowUpId.make("follow-up-1"),
          error: "thread was archived",
          updatedAt: LATER,
        },
      }),
    );
    expect(thread.queuedFollowUps?.[0]).toMatchObject({
      status: "failed",
      lastError: "thread was archived",
    });
  });
});
