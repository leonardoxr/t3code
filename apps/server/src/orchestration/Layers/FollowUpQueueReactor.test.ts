import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  QueuedFollowUpId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationQueuedFollowUp,
  type OrchestrationSession,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { FollowUpQueueReactor } from "../Services/FollowUpQueueReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { FollowUpQueueReactorLive } from "./FollowUpQueueReactor.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const FOLLOW_UP_ID = QueuedFollowUpId.make("follow-up-1");

function makeSession(status: OrchestrationSessionStatus): OrchestrationSession {
  return {
    threadId: THREAD_ID,
    status,
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access",
    activeTurnId: status === "running" ? TurnId.make("turn-1") : null,
    lastError: status === "error" ? "boom" : null,
    updatedAt: NOW,
  };
}

function makeFollowUp(
  overrides?: Partial<OrchestrationQueuedFollowUp>,
): OrchestrationQueuedFollowUp {
  return {
    id: FOLLOW_UP_ID,
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

function makeThread(input: {
  readonly queuedFollowUps: ReadonlyArray<OrchestrationQueuedFollowUp>;
  readonly session: OrchestrationSession | null;
  readonly archivedAt?: string | null;
}): OrchestrationThread {
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: input.archivedAt ?? null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: input.session,
    queuedFollowUps: input.queuedFollowUps,
  };
}

function makeShell(input: {
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
}): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: input.hasPendingApprovals ?? false,
    hasPendingUserInput: input.hasPendingUserInput ?? false,
    hasActionableProposedPlan: false,
  };
}

function makeEvent(input: {
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.make("evt-1"),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: NOW,
    commandId: CommandId.make("cmd-1"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: input.type,
    payload: input.payload as never,
  } as OrchestrationEvent;
}

const SESSION_SET_EVENT = makeEvent({
  type: "thread.session-set",
  payload: { threadId: THREAD_ID, session: makeSession("ready") },
});

function activityEvent(kind: string): OrchestrationEvent {
  return makeEvent({
    type: "thread.activity-appended",
    payload: {
      threadId: THREAD_ID,
      activity: {
        id: EventId.make("evt-activity"),
        tone: "tool",
        kind,
        summary: kind,
        payload: {},
        turnId: null,
        createdAt: NOW,
      },
    },
  });
}

/**
 * Per-test stub state. One layer serves the whole suite (the rule against
 * hand-rolled runtimes in tests), so each case rewrites this before starting
 * the reactor.
 */
interface GateScenario {
  thread: OrchestrationThread | null;
  shell: OrchestrationThreadShell;
  pendingTurnStart: boolean;
  events: ReadonlyArray<OrchestrationEvent>;
  promoteFails: boolean;
  dispatched: Array<OrchestrationCommand>;
  streamed: Deferred.Deferred<void> | null;
}

const scenario: GateScenario = {
  thread: null,
  shell: makeShell({}),
  pendingTurnStart: false,
  events: [SESSION_SET_EVENT],
  promoteFails: false,
  dispatched: [],
  streamed: null,
};

const engineStub = {
  readEvents: () => Stream.empty,
  dispatch: (command: OrchestrationCommand) => {
    scenario.dispatched.push(command);
    return scenario.promoteFails && command.type === "thread.follow-up.promote"
      ? Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "thread went away",
          }),
        )
      : Effect.succeed({ sequence: 1 });
  },
  // The reactor consumes this stream on a forked fiber, so draining its worker
  // only proves something once every event reached it. The stream's own end is
  // that barrier — no sleeps, no polling.
  get streamDomainEvents() {
    const streamed = scenario.streamed;
    return Stream.fromIterable(scenario.events).pipe(
      Stream.ensuring(streamed === null ? Effect.void : Deferred.succeed(streamed, undefined)),
    );
  },
  latestSequence: Effect.succeed(1),
} as unknown as OrchestrationEngineService["Service"];

const snapshotStub = {
  getThreadDetailById: () =>
    Effect.succeed(scenario.thread === null ? Option.none() : Option.some(scenario.thread)),
  getThreadShellById: () => Effect.succeed(Option.some(scenario.shell)),
} as unknown as ProjectionSnapshotQuery["Service"];

const turnRepositoryStub = {
  getPendingTurnStartByThreadId: () =>
    Effect.succeed(
      scenario.pendingTurnStart
        ? Option.some({
            threadId: THREAD_ID,
            messageId: MessageId.make("message-1"),
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            requestedAt: NOW,
          })
        : Option.none(),
    ),
} as unknown as ProjectionTurnRepository["Service"];

const TestLayer = FollowUpQueueReactorLive.pipe(
  Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engineStub)),
  Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, snapshotStub)),
  Layer.provideMerge(Layer.succeed(ProjectionTurnRepository, turnRepositoryStub)),
);

const runGate = Effect.fn("runGate")(function* (input: {
  readonly thread: OrchestrationThread | null;
  readonly shell?: OrchestrationThreadShell;
  readonly pendingTurnStart?: boolean;
  readonly events?: ReadonlyArray<OrchestrationEvent>;
  readonly promoteFails?: boolean;
}) {
  const streamed = yield* Deferred.make<void>();
  scenario.thread = input.thread;
  scenario.shell = input.shell ?? makeShell({});
  scenario.pendingTurnStart = input.pendingTurnStart ?? false;
  scenario.events = input.events ?? [SESSION_SET_EVENT];
  scenario.promoteFails = input.promoteFails ?? false;
  scenario.dispatched = [];
  scenario.streamed = streamed;

  const reactor = yield* FollowUpQueueReactor;
  const scope = yield* Scope.make("sequential");
  yield* reactor.start().pipe(Scope.provide(scope));
  yield* Deferred.await(streamed);
  yield* reactor.drain;
  yield* Scope.close(scope, Exit.void);
  return scenario.dispatched;
});

it.layer(TestLayer)("FollowUpQueueReactor dispatch gate", (it) => {
  it.effect("dispatches the queue head once the session is ready", () =>
    Effect.gen(function* () {
      const dispatched = yield* runGate({
        thread: makeThread({ queuedFollowUps: [makeFollowUp()], session: makeSession("ready") }),
      });
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: "thread.follow-up.promote",
        threadId: THREAD_ID,
        followUpId: FOLLOW_UP_ID,
      });
    }),
  );

  it.effect("dispatches the lowest order key, not arrival order", () =>
    Effect.gen(function* () {
      const dispatched = yield* runGate({
        thread: makeThread({
          queuedFollowUps: [
            makeFollowUp({ id: QueuedFollowUpId.make("follow-up-late"), orderKey: "z" }),
            makeFollowUp({ id: QueuedFollowUpId.make("follow-up-head"), orderKey: "b" }),
          ],
          session: makeSession("ready"),
        }),
      });
      expect(dispatched[0]).toMatchObject({ followUpId: "follow-up-head" });
    }),
  );

  it.effect("dispatches with no session yet, which boots one like a first send", () =>
    Effect.gen(function* () {
      const dispatched = yield* runGate({
        thread: makeThread({ queuedFollowUps: [makeFollowUp()], session: null }),
      });
      expect(dispatched).toHaveLength(1);
    }),
  );

  it.effect("holds while the session is starting, running, or errored", () =>
    Effect.gen(function* () {
      for (const status of ["starting", "running", "error"] as const) {
        const dispatched = yield* runGate({
          thread: makeThread({ queuedFollowUps: [makeFollowUp()], session: makeSession(status) }),
        });
        expect(dispatched, `session status ${status}`).toEqual([]);
      }
    }),
  );

  it.effect("holds while a turn start is still waiting for adoption", () =>
    Effect.gen(function* () {
      const dispatched = yield* runGate({
        thread: makeThread({ queuedFollowUps: [makeFollowUp()], session: makeSession("ready") }),
        pendingTurnStart: true,
      });
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("holds while an approval or a user-input request waits on the user", () =>
    Effect.gen(function* () {
      const withApproval = yield* runGate({
        thread: makeThread({ queuedFollowUps: [makeFollowUp()], session: makeSession("ready") }),
        shell: makeShell({ hasPendingApprovals: true }),
      });
      expect(withApproval).toEqual([]);

      const withUserInput = yield* runGate({
        thread: makeThread({ queuedFollowUps: [makeFollowUp()], session: makeSession("ready") }),
        shell: makeShell({ hasPendingUserInput: true }),
      });
      expect(withUserInput).toEqual([]);
    }),
  );

  it.effect("holds a paused head, so stop stops what happens next too", () =>
    Effect.gen(function* () {
      const dispatched = yield* runGate({
        thread: makeThread({
          queuedFollowUps: [makeFollowUp({ status: "paused" })],
          session: makeSession("ready"),
        }),
      });
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("stays blocked behind a failed head instead of skipping it", () =>
    Effect.gen(function* () {
      const dispatched = yield* runGate({
        thread: makeThread({
          queuedFollowUps: [
            makeFollowUp({ id: QueuedFollowUpId.make("follow-up-failed"), status: "failed" }),
            makeFollowUp({ id: QueuedFollowUpId.make("follow-up-next"), orderKey: "z" }),
          ],
          session: makeSession("ready"),
        }),
      });
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("holds on an archived thread", () =>
    Effect.gen(function* () {
      const dispatched = yield* runGate({
        thread: makeThread({
          queuedFollowUps: [makeFollowUp()],
          session: makeSession("ready"),
          archivedAt: NOW,
        }),
      });
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("ignores events that cannot open the gate", () =>
    Effect.gen(function* () {
      const dispatched = yield* runGate({
        thread: makeThread({ queuedFollowUps: [makeFollowUp()], session: makeSession("ready") }),
        events: [activityEvent("tool.started")],
      });
      expect(dispatched).toEqual([]);
    }),
  );

  it.effect("re-evaluates when a provider resolves an approval", () =>
    Effect.gen(function* () {
      const dispatched = yield* runGate({
        thread: makeThread({ queuedFollowUps: [makeFollowUp()], session: makeSession("ready") }),
        events: [activityEvent("approval.resolved")],
      });
      expect(dispatched).toHaveLength(1);
    }),
  );

  it.effect("marks a follow-up failed when the promote is rejected", () =>
    Effect.gen(function* () {
      const dispatched = yield* runGate({
        thread: makeThread({ queuedFollowUps: [makeFollowUp()], session: makeSession("ready") }),
        promoteFails: true,
      });
      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.follow-up.promote",
        "thread.follow-up.fail",
      ]);
    }),
  );
});
