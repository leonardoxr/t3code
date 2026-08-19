import {
  CommandId,
  MAX_QUEUED_FOLLOW_UPS_PER_THREAD,
  ProjectId,
  ProviderInstanceId,
  QueuedFollowUpId,
  ThreadId,
  type OrchestrationQueuedFollowUp,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

function makeQueuedFollowUp(
  input: Partial<OrchestrationQueuedFollowUp> & { readonly id: string },
): OrchestrationQueuedFollowUp {
  return {
    id: QueuedFollowUpId.make(input.id),
    text: input.text ?? "keep going",
    attachments: input.attachments ?? [],
    ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: input.interactionMode ?? "default",
    orderKey: input.orderKey ?? "m",
    status: input.status ?? "pending",
    lastError: input.lastError ?? null,
    createdAt: input.createdAt ?? NOW,
    updatedAt: input.updatedAt ?? NOW,
  };
}

function makeReadModel(input: {
  readonly queuedFollowUps?: ReadonlyArray<OrchestrationQueuedFollowUp>;
  readonly runtimeMode?: OrchestrationThread["runtimeMode"];
  readonly interactionMode?: OrchestrationThread["interactionMode"];
  readonly session?: OrchestrationSession | null;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: input.runtimeMode ?? "full-access",
        interactionMode: input.interactionMode ?? "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: input.session ?? null,
        ...(input.queuedFollowUps !== undefined ? { queuedFollowUps: input.queuedFollowUps } : {}),
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("queued follow-up decider", (it) => {
  it.effect("queues a follow-up as pending", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.follow-up.queue",
          commandId: CommandId.make("cmd-queue"),
          threadId: THREAD_ID,
          followUpId: QueuedFollowUpId.make("follow-up-1"),
          text: "then run the tests",
          attachments: [],
          runtimeMode: "auto",
          interactionMode: "plan",
          createdAt: NOW,
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.follow-up-queued");
      expect(events[0]?.payload).toMatchObject({
        threadId: THREAD_ID,
        followUp: {
          id: "follow-up-1",
          text: "then run the tests",
          runtimeMode: "auto",
          interactionMode: "plan",
          status: "pending",
          lastError: null,
        },
      });
    }),
  );

  // Regression: the client used to compute the append key from its own copy of
  // the queue, so a burst of follow-ups (or a client that had not received the
  // queue yet) landed several items on the same key and the order went to the
  // id tiebreak. The decider owns queue position now.
  it.effect("appends past the current tail instead of trusting a client key", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.follow-up.queue",
          commandId: CommandId.make("cmd-queue-append"),
          threadId: THREAD_ID,
          followUpId: QueuedFollowUpId.make("follow-up-new"),
          text: "and then deploy",
          attachments: [],
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel({
          queuedFollowUps: [
            makeQueuedFollowUp({ id: "follow-up-1", orderKey: "b" }),
            makeQueuedFollowUp({ id: "follow-up-2", orderKey: "n" }),
          ],
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      if (events[0]?.type !== "thread.follow-up-queued") {
        throw new Error("Expected a thread.follow-up-queued event.");
      }
      const orderKey = events[0].payload.followUp.orderKey;
      expect(orderKey.localeCompare("n")).toBeGreaterThan(0);
    }),
  );

  it.effect("rejects a queue past the per-thread cap", () =>
    Effect.gen(function* () {
      const queuedFollowUps = Array.from({ length: MAX_QUEUED_FOLLOW_UPS_PER_THREAD }, (_, index) =>
        makeQueuedFollowUp({ id: `follow-up-${index}`, orderKey: `m${index}` }),
      );
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.follow-up.queue",
          commandId: CommandId.make("cmd-queue-overflow"),
          threadId: THREAD_ID,
          followUpId: QueuedFollowUpId.make("follow-up-overflow"),
          text: "one too many",
          attachments: [],
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel({ queuedFollowUps }),
      }).pipe(Effect.flip);
      expect(result._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects commands naming a follow-up the queue no longer holds", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.follow-up.remove",
          commandId: CommandId.make("cmd-remove-missing"),
          threadId: THREAD_ID,
          followUpId: QueuedFollowUpId.make("follow-up-gone"),
          createdAt: NOW,
        },
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(result._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("removes a follow-up as a user cancellation", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.follow-up.remove",
          commandId: CommandId.make("cmd-remove"),
          threadId: THREAD_ID,
          followUpId: QueuedFollowUpId.make("follow-up-1"),
          createdAt: NOW,
        },
        readModel: makeReadModel({
          queuedFollowUps: [makeQueuedFollowUp({ id: "follow-up-1" })],
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events[0]?.type).toBe("thread.follow-up-removed");
      expect(events[0]?.payload).toMatchObject({ followUpId: "follow-up-1", reason: "user" });
    }),
  );

  it.effect(
    "promotes a follow-up into a turn that reproduces its queued model and modes, then dequeues it",
    () =>
      Effect.gen(function* () {
        const decided = yield* decideOrchestrationCommand({
          command: {
            type: "thread.follow-up.promote",
            commandId: CommandId.make("cmd-promote"),
            threadId: THREAD_ID,
            followUpId: QueuedFollowUpId.make("follow-up-1"),
            createdAt: NOW,
          },
          readModel: makeReadModel({
            runtimeMode: "full-access",
            interactionMode: "default",
            queuedFollowUps: [
              makeQueuedFollowUp({
                id: "follow-up-1",
                text: "keep going",
                runtimeMode: "approval-required",
                interactionMode: "plan",
                modelSelection: {
                  instanceId: ProviderInstanceId.make("claude"),
                  model: "sonnet-9",
                },
              }),
            ],
          }),
        });
        const events = Array.isArray(decided) ? decided : [decided];
        expect(events.map((event) => event.type)).toEqual([
          "thread.runtime-mode-set",
          "thread.interaction-mode-set",
          "thread.message-sent",
          "thread.turn-start-requested",
          "thread.follow-up-removed",
        ]);

        const messageSent = events.find((event) => event.type === "thread.message-sent");
        const turnStart = events.find((event) => event.type === "thread.turn-start-requested");
        const removed = events.find((event) => event.type === "thread.follow-up-removed");
        if (messageSent?.type !== "thread.message-sent") {
          throw new Error("Expected a thread.message-sent event.");
        }
        expect(messageSent.payload).toMatchObject({ role: "user", text: "keep going" });
        expect(turnStart?.payload).toMatchObject({
          runtimeMode: "approval-required",
          interactionMode: "plan",
          modelSelection: { instanceId: "claude", model: "sonnet-9" },
          // The turn starts from the message this command minted.
          messageId: messageSent.payload.messageId,
        });
        // Dequeue lands last: a crash mid-command can duplicate a visible send,
        // never silently swallow a follow-up.
        expect(removed?.payload).toMatchObject({ reason: "dispatched" });
      }),
  );

  it.effect("marks a follow-up failed without dropping it", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.follow-up.fail",
          commandId: CommandId.make("cmd-fail"),
          threadId: THREAD_ID,
          followUpId: QueuedFollowUpId.make("follow-up-1"),
          error: "thread was archived",
          createdAt: NOW,
        },
        readModel: makeReadModel({
          queuedFollowUps: [makeQueuedFollowUp({ id: "follow-up-1" })],
        }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events[0]?.type).toBe("thread.follow-up-failed");
      expect(events[0]?.payload).toMatchObject({
        followUpId: "follow-up-1",
        error: "thread was archived",
      });
    }),
  );
});
