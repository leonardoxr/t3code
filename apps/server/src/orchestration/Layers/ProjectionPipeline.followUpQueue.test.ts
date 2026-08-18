import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  QueuedFollowUpId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-follow-up-queue");

const engineLayer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-projection-pipeline-follow-up-queue-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const seedThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-queue-project"),
      projectId: PROJECT_ID,
      title: "Queue Project",
      workspaceRoot: "/tmp/project-follow-up-queue",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      createdAt: NOW,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-queue-thread-${threadId}`),
      threadId,
      projectId: PROJECT_ID,
      title: "Queue Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
    });
  });

engineLayer("queued follow-up projection", (it) => {
  it.effect("persists a queued follow-up and reads it back on the thread detail", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-queue-persist");
      yield* seedThread(threadId);

      yield* engine.dispatch({
        type: "thread.follow-up.queue",
        commandId: CommandId.make("cmd-queue-follow-up"),
        threadId,
        followUpId: QueuedFollowUpId.make("follow-up-1"),
        text: "then run the tests",
        attachments: [],
        modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet-9" },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        orderKey: "m",
        createdAt: NOW,
      });

      const rows = yield* sql<{
        readonly followUpId: string;
        readonly status: string;
        readonly runtimeMode: string;
        readonly interactionMode: string;
        readonly modelSelectionJson: string | null;
      }>`
        SELECT
          follow_up_id AS "followUpId",
          status,
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          model_selection_json AS "modelSelectionJson"
        FROM projection_thread_queued_follow_ups
        WHERE thread_id = ${threadId}
      `;
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0], {
        followUpId: "follow-up-1",
        status: "pending",
        runtimeMode: "approval-required",
        interactionMode: "plan",
        modelSelectionJson: '{"instanceId":"claude","model":"sonnet-9"}',
      });

      // Read-back through the query the clients use: this is what makes the
      // queue survive a reload, a reconnect, and a server restart.
      const detail = yield* snapshotQuery.getThreadDetailById(threadId);
      assert.isTrue(Option.isSome(detail));
      const queue = Option.isSome(detail) ? (detail.value.queuedFollowUps ?? []) : [];
      assert.equal(queue.length, 1);
      assert.deepInclude(queue[0], {
        id: "follow-up-1",
        text: "then run the tests",
        runtimeMode: "approval-required",
        interactionMode: "plan",
        status: "pending",
      });
    }),
  );

  it.effect("pauses the queue on a session stop and resumes it on a dispatch", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const threadId = ThreadId.make("thread-queue-pause");
      yield* seedThread(threadId);

      for (const [index, orderKey] of ["b", "m"].entries()) {
        yield* engine.dispatch({
          type: "thread.follow-up.queue",
          commandId: CommandId.make(`cmd-queue-pause-${index}`),
          threadId,
          followUpId: QueuedFollowUpId.make(`follow-up-pause-${index}`),
          text: `follow-up ${index}`,
          attachments: [],
          runtimeMode: "full-access",
          interactionMode: "default",
          orderKey,
          createdAt: NOW,
        });
      }

      yield* engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-queue-stop"),
        threadId,
        createdAt: NOW,
      });

      const paused = yield* snapshotQuery.getThreadDetailById(threadId);
      assert.deepEqual(
        (Option.isSome(paused) ? (paused.value.queuedFollowUps ?? []) : []).map(
          (followUp) => followUp.status,
        ),
        ["paused", "paused"],
      );

      // Sending one (steer now / resume) lifts the pause for the rest.
      yield* engine.dispatch({
        type: "thread.follow-up.promote",
        commandId: CommandId.make("cmd-queue-promote"),
        threadId,
        followUpId: QueuedFollowUpId.make("follow-up-pause-0"),
        createdAt: NOW,
      });

      const resumed = yield* snapshotQuery.getThreadDetailById(threadId);
      const resumedQueue = Option.isSome(resumed) ? (resumed.value.queuedFollowUps ?? []) : [];
      assert.deepEqual(
        resumedQueue.map((followUp) => ({ id: followUp.id, status: followUp.status })),
        [{ id: "follow-up-pause-1", status: "pending" }],
      );

      // The promoted follow-up became a real user message on the thread.
      const messages = Option.isSome(resumed) ? resumed.value.messages : [];
      assert.deepEqual(
        messages.map((message) => message.text),
        ["follow-up 0"],
      );
    }),
  );

  it.effect("drops a cancelled follow-up from the projection", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const threadId = ThreadId.make("thread-queue-cancel");
      yield* seedThread(threadId);

      yield* engine.dispatch({
        type: "thread.follow-up.queue",
        commandId: CommandId.make("cmd-queue-cancel"),
        threadId,
        followUpId: QueuedFollowUpId.make("follow-up-cancel"),
        text: "never mind",
        attachments: [],
        runtimeMode: "full-access",
        interactionMode: "default",
        orderKey: "m",
        createdAt: NOW,
      });
      yield* engine.dispatch({
        type: "thread.follow-up.remove",
        commandId: CommandId.make("cmd-queue-cancel-remove"),
        threadId,
        followUpId: QueuedFollowUpId.make("follow-up-cancel"),
        createdAt: NOW,
      });

      const detail = yield* snapshotQuery.getThreadDetailById(threadId);
      assert.deepEqual(Option.isSome(detail) ? (detail.value.queuedFollowUps ?? []) : [], []);
    }),
  );
});
