// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  OmpSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import type { AcpSessionModeState } from "../acp/AcpRuntimeModel.ts";
import { ChildProcessSpawner } from "effect/unstable/process";
import { makeOmpAcpRuntime } from "../acp/OmpAcpSupport.ts";
import {
  enrichOmpToolCallFiles,
  formatOmpRateLimitTurnError,
  makeOmpAdapter,
  ompPromptSettlementBelongsToContext,
  parseOmpRateLimitNotice,
  parseOmpTaskToolCall,
  parseOmpTaskToolProgress,
  parseOmpTaskToolResults,
  resolveOmpQuietTransition,
  resolveOmpRequestedModeId,
  resolveOmpSilenceGiveUp,
} from "./OmpAdapter.ts";
const decodeOmpSettings = Schema.decodeSync(OmpSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockOmpWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-omp.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function waitForFileContent(
  filePath: string,
  attempts = 40,
  expectedContent?: string,
): Effect.Effect<string> {
  const readAttempt = (remainingAttempts: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remainingAttempts <= 0) {
        return yield* Effect.die(new Error(`Timed out waiting for file content at ${filePath}`));
      }
      const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (
        raw.trim().length > 0 &&
        (expectedContent === undefined || raw.includes(expectedContent))
      ) {
        return raw;
      }
      yield* Effect.sleep("25 millis");
      return yield* readAttempt(remainingAttempts - 1);
    });
  return readAttempt(attempts);
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const ompAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-omp-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeOmpAdapter>[1]) =>
  makeOmpAdapter(decodeOmpSettings({ binaryPath }), options).pipe(Effect.orDie);

it("requires a settlement to match the live Oh My Pi turn", () => {
  const staleTurnId = TurnId.make("stale-turn");
  const replacementTurnId = TurnId.make("replacement-turn");

  assert.isFalse(
    ompPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: replacementTurnId,
      liveSessionActiveTurnId: replacementTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isFalse(
    ompPromptSettlementBelongsToContext({
      liveAcpSessionId: "replacement-session",
      expectedAcpSessionId: "stale-session",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isTrue(
    ompPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
});

const RATE_LIMIT_NOTICE =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_011CeBMhQkPKvK4okSKtsEEL"} retry-after-ms=4300000';

it("reads the retry window out of an omp rate-limit report", () => {
  const notice = parseOmpRateLimitNotice(RATE_LIMIT_NOTICE);
  assert.isDefined(notice);
  if (!notice) {
    return;
  }

  assert.equal(notice.retryAfterMs, 4_300_000);
  assert.equal(notice.requestId, "req_011CeBMhQkPKvK4okSKtsEEL");
  assert.include(notice.providerMessage ?? "", "would exceed your account's rate limit");
  assert.include(
    formatOmpRateLimitTurnError(notice, "2026-08-19T05:22:33.000Z"),
    "Retry after 2026-08-19T05:22:33.000Z (about 72 min).",
  );
});

it("treats a rate limit reported without a retry window as an open-ended wait", () => {
  const notice = parseOmpRateLimitNotice(
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"Slow down."}}',
  );
  assert.isDefined(notice);
  if (!notice) {
    return;
  }

  assert.isUndefined(notice.retryAfterMs);
  assert.equal(
    formatOmpRateLimitTurnError(notice, undefined),
    "Rate limited by the model provider. Slow down.",
  );
});

it("does not read a rate-limit report out of an agent discussing one", () => {
  // The agent quoting a 429 while explaining rate limits is prose, not a
  // failure: only a message that IS the raw report may fail the turn.
  assert.isUndefined(
    parseOmpRateLimitNotice(`Here is what the provider returned:\n\n${RATE_LIMIT_NOTICE}\n`),
  );
  assert.isUndefined(parseOmpRateLimitNotice("429s are rate_limit_error responses."));
  assert.isUndefined(parseOmpRateLimitNotice(RATE_LIMIT_NOTICE.replace("rate_limit_error", "x")));
});

it("resolves the requested Oh My Pi session mode from interaction mode", () => {
  const modeState: AcpSessionModeState = {
    currentModeId: "ask",
    availableModes: [
      { id: "ask", name: "Ask" },
      { id: "plan-mode", name: "Plan", description: "Plan before making changes" },
      { id: "code-mode", name: "Code", description: "Write and modify code" },
    ],
  };

  assert.equal(resolveOmpRequestedModeId({ interactionMode: "plan", modeState }), "plan-mode");
  assert.equal(resolveOmpRequestedModeId({ interactionMode: "default", modeState }), "code-mode");
  assert.equal(resolveOmpRequestedModeId({ interactionMode: undefined, modeState }), "code-mode");

  // Without an implement alias, default falls back to the first non-plan mode.
  assert.equal(
    resolveOmpRequestedModeId({
      interactionMode: "default",
      modeState: {
        currentModeId: "plan-only",
        availableModes: [
          { id: "plan-only", name: "Plan" },
          { id: "review", name: "Review" },
        ],
      },
    }),
    "review",
  );

  // Plan never forces a bogus mode when the agent advertises none.
  assert.isUndefined(
    resolveOmpRequestedModeId({
      interactionMode: "plan",
      modeState: {
        currentModeId: "code-mode",
        availableModes: [{ id: "code-mode", name: "Code" }],
      },
    }),
  );

  assert.isUndefined(resolveOmpRequestedModeId({ interactionMode: "plan", modeState: undefined }));
  assert.isUndefined(
    resolveOmpRequestedModeId({ interactionMode: undefined, modeState: undefined }),
  );
});

it("enrichOmpToolCallFiles surfaces edit locations as a files list", () => {
  const enriched = enrichOmpToolCallFiles({
    toolCallId: "tool-1",
    kind: "edit",
    data: {
      toolCallId: "tool-1",
      locations: [
        { path: "/repo/src/a.ts", line: 3 },
        { path: "/repo/src/a.ts" },
        { path: "/repo/src/b.ts" },
        { path: "   " },
        { notAPath: true },
      ],
    },
  });
  assert.deepEqual(enriched.data.files, [{ path: "/repo/src/a.ts" }, { path: "/repo/src/b.ts" }]);

  // Non-file-change kinds and location-free calls pass through untouched.
  const readCall = {
    toolCallId: "tool-2",
    kind: "read",
    data: { toolCallId: "tool-2", locations: [{ path: "/repo/src/a.ts" }] },
  };
  assert.strictEqual(enrichOmpToolCallFiles(readCall), readCall);
  const bareEdit = { toolCallId: "tool-3", kind: "edit", data: { toolCallId: "tool-3" } };
  assert.strictEqual(enrichOmpToolCallFiles(bareEdit), bareEdit);
});

it("parseOmpTaskToolCall maps subagent task tool args to synthesized subtasks", () => {
  const subtasks = parseOmpTaskToolCall({
    toolCallId: "tool-task-1",
    kind: "other",
    data: {
      toolCallId: "tool-task-1",
      rawInput: {
        context: "# Goal\nMigrate the settings screens.",
        tasks: [
          { name: "AuthScreen", agent: "coder", task: "Migrate the auth screen.\nDetails…" },
          { task: "Review the auth screen migration for regressions." },
          { agent: "scout" },
        ],
      },
    },
  });
  assert.deepEqual(subtasks, [
    {
      taskId: "tool-task-1:0",
      title: "AuthScreen",
      role: "coder",
      description: "Migrate the auth screen.\nDetails…",
    },
    {
      taskId: "tool-task-1:1",
      title: "Review the auth screen migration for regressions.",
      description: "Review the auth screen migration for regressions.",
    },
  ]);

  // Non-task tools with similar-looking args never synthesize subtasks.
  assert.isUndefined(
    parseOmpTaskToolCall({
      toolCallId: "tool-x",
      kind: "execute",
      data: { toolCallId: "tool-x", rawInput: { command: "ls" } },
    }),
  );
  assert.isUndefined(
    parseOmpTaskToolCall({
      toolCallId: "tool-y",
      kind: "other",
      data: { toolCallId: "tool-y", rawInput: { context: "ctx", tasks: [] } },
    }),
  );
});

it("resolveOmpQuietTransition flags sustained silence and nothing else", () => {
  const base = {
    nowMillis: 200_000,
    turnActive: true,
    turnStartedAtMillis: 10_000,
    lastInboundFrameAtMillis: 100_000,
    openToolCallCount: 0,
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
    quietAlreadyMarked: false,
    thresholdMillis: 75_000,
  };

  // 100s without a frame → quiet, anchored at the last observed activity.
  assert.deepEqual(resolveOmpQuietTransition(base), { _tag: "mark", quietSinceMillis: 100_000 });
  // Already flagged → no repeat event.
  assert.deepEqual(resolveOmpQuietTransition({ ...base, quietAlreadyMarked: true }), {
    _tag: "none",
  });
  // Below the threshold → nothing.
  assert.deepEqual(resolveOmpQuietTransition({ ...base, nowMillis: 174_999 }), { _tag: "none" });
  // A frame arriving after the flag → clear.
  assert.deepEqual(
    resolveOmpQuietTransition({
      ...base,
      quietAlreadyMarked: true,
      lastInboundFrameAtMillis: 190_000,
    }),
    { _tag: "clear" },
  );

  // A long-running tool call is not provider silence.
  assert.deepEqual(resolveOmpQuietTransition({ ...base, openToolCallCount: 1 }), {
    _tag: "none",
  });
  assert.deepEqual(
    resolveOmpQuietTransition({ ...base, openToolCallCount: 1, quietAlreadyMarked: true }),
    { _tag: "clear" },
  );
  // Waiting on the human (approval / user input) is not provider silence.
  assert.deepEqual(resolveOmpQuietTransition({ ...base, pendingApprovalCount: 1 }), {
    _tag: "none",
  });
  assert.deepEqual(resolveOmpQuietTransition({ ...base, pendingUserInputCount: 1 }), {
    _tag: "none",
  });

  // No frames yet: the prompt dispatch time is the baseline.
  assert.deepEqual(resolveOmpQuietTransition({ ...base, lastInboundFrameAtMillis: undefined }), {
    _tag: "mark",
    quietSinceMillis: 10_000,
  });
  // A prompt newer than the last frame resets the baseline (steer).
  assert.deepEqual(resolveOmpQuietTransition({ ...base, turnStartedAtMillis: 150_000 }), {
    _tag: "none",
  });
  // No turn running → settlement owns the clear; the watchdog stays silent.
  assert.deepEqual(
    resolveOmpQuietTransition({ ...base, turnActive: false, quietAlreadyMarked: true }),
    { _tag: "none" },
  );
});

it("resolveOmpSilenceGiveUp fires only once total silence crosses the give-up threshold", () => {
  assert.isFalse(
    resolveOmpSilenceGiveUp({
      nowMillis: 100_000,
      quietSinceMillis: undefined,
      thresholdMillis: 600_000,
    }),
  );
  // Marked quiet, but not for long enough yet.
  assert.isFalse(
    resolveOmpSilenceGiveUp({
      nowMillis: 609_999,
      quietSinceMillis: 10_000,
      thresholdMillis: 600_000,
    }),
  );
  // Exactly at the threshold → gives up.
  assert.isTrue(
    resolveOmpSilenceGiveUp({
      nowMillis: 610_000,
      quietSinceMillis: 10_000,
      thresholdMillis: 600_000,
    }),
  );
  assert.isTrue(
    resolveOmpSilenceGiveUp({
      nowMillis: 700_000,
      quietSinceMillis: 10_000,
      thresholdMillis: 600_000,
    }),
  );
});

it("parseOmpTaskToolProgress and parseOmpTaskToolResults read streamed task details", () => {
  const baseCall = {
    toolCallId: "tool-task-2",
    kind: "other",
    data: {
      toolCallId: "tool-task-2",
      rawInput: {
        context: "ctx",
        tasks: [{ name: "Scout", agent: "scout", task: "Map the module." }],
      },
    },
  };

  const progress = parseOmpTaskToolProgress({
    ...baseCall,
    status: "inProgress",
    data: {
      ...baseCall.data,
      rawOutput: {
        details: {
          progress: [
            {
              index: 0,
              id: "sub-1",
              agent: "scout",
              status: "running",
              task: "Map the module.",
              lastIntent: "Reading adapter entry points",
              currentTool: "grep",
              toolCount: 7,
              tokens: 15_320.4,
              durationMs: 42_000,
              resolvedModel: "anthropic/claude-sonnet-4-5",
            },
            { index: 3, status: "sideways" },
          ],
        },
      },
    },
  });
  assert.deepEqual(progress, [
    {
      index: 0,
      status: "running",
      lastIntent: "Reading adapter entry points",
      currentTool: "grep",
      toolCount: 7,
      tokens: 15320,
      durationMs: 42000,
      resolvedModel: "anthropic/claude-sonnet-4-5",
    },
  ]);

  const results = parseOmpTaskToolResults({
    ...baseCall,
    status: "completed",
    data: {
      ...baseCall.data,
      rawOutput: {
        details: {
          results: [
            {
              index: 0,
              exitCode: 0,
              output: "Report ready.\nDetails follow…",
              tokens: 90_000,
              durationMs: 61_000,
            },
            { index: 1, exitCode: 1, output: "", error: "budget exhausted" },
            { index: 2, exitCode: 0, output: "n/a", aborted: true },
          ],
        },
      },
    },
  });
  assert.deepEqual(results, [
    {
      index: 0,
      status: "completed",
      summary: "Report ready.",
      tokens: 90000,
      durationMs: 61000,
    },
    { index: 1, status: "failed", summary: "budget exhausted" },
    { index: 2, status: "stopped", summary: "n/a" },
  ]);

  // No details on the wire → no synthesized frames.
  assert.isUndefined(parseOmpTaskToolProgress(baseCall));
  assert.isUndefined(parseOmpTaskToolResults(baseCall));
});

it.layer(ompAdapterTestLayer)("OmpAdapterLive", (it) => {
  it.effect("stamps inbound native frames for the silence watchdog", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockOmpWrapper());
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtime = yield* makeOmpAcpRuntime({
        ompSettings: decodeOmpSettings({ binaryPath: wrapperPath }),
        environment: process.env,
        childProcessSpawner,
        cwd: process.cwd(),
        clientInfo: { name: "t3-omp-test", version: "0.0.0" },
      }).pipe(Effect.orDie);

      const before = yield* runtime.getActivitySnapshot;
      assert.isUndefined(before.lastInboundFrameAtMillis);
      assert.equal(before.openToolCallCount, 0);

      yield* runtime.start().pipe(Effect.orDie);
      // The prompt settles only after the mock streamed its message frames,
      // so the snapshot deterministically reflects inbound activity.
      yield* runtime.prompt({ prompt: [{ type: "text", text: "hello" }] }).pipe(Effect.orDie);

      const after = yield* runtime.getActivitySnapshot;
      assert.isDefined(after.lastInboundFrameAtMillis);
      assert.equal(after.openToolCallCount, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-mock-thread");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-start-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "composer-2" },
      });

      assert.equal(session.provider, "omp");
      assert.equal(session.model, "composer-2");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello omp",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((e) => e.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      const turnCompletedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      assert.equal(turnCompletedEvent?.payload.state, "completed");
      assert.equal(turnCompletedEvent?.payload.stopReason, "end_turn");

      // omp binds the model through the config-option surface, not session/set_model.
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(
        requests.some((entry) => {
          if (entry.method !== "session/set_config_option") {
            return false;
          }
          const params = entry.params;
          return (
            typeof params === "object" &&
            params !== null &&
            "configId" in params &&
            params.configId === "model" &&
            "value" in params &&
            params.value === "composer-2"
          );
        }),
      );
      assert.isFalse(requests.some((entry) => entry.method === "session/set_model"));

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-adapter-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(threadId);

      const exitLog = yield* waitForFileContent(exitLogPath);
      assert.include(exitLog, "SIGTERM");
    }),
  );

  it.effect("reports an Oh My Pi session running only while the prompt is in flight", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-session-ready-after-prompt");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const requestOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "request.opened"
              ? Deferred.succeed(requestOpened, event).pipe(Effect.asVoid)
              : event.type === "turn.completed"
                ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
                : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "check lifecycle", attachments: [] })
        .pipe(Effect.forkChild);
      const requestOpenedEvent = yield* Deferred.await(requestOpened);

      const runningSessions = yield* adapter.listSessions();
      const runningSession = runningSessions.find((session) => session.threadId === threadId);
      assert.equal(runningSession?.status, "running");
      assert.isDefined(runningSession?.activeTurnId);

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(requestOpenedEvent.requestId)),
        "accept",
      );
      yield* Fiber.join(sendTurnFiber);
      yield* Deferred.await(turnCompleted);

      const requestResolvedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "request.resolved" }> =>
          event.type === "request.resolved",
      );
      assert.equal(String(requestResolvedEvent?.requestId), String(requestOpenedEvent.requestId));
      assert.equal(requestResolvedEvent?.payload.decision, "accept");

      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("auto-approves tool permission requests in full-access mode", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-full-access-auto-approve");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-auto-approve-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "run the tool", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const requestOpenedEvents = runtimeEvents.filter((event) => event.type === "request.opened");
      const toolItemEvents = runtimeEvents.filter(
        (event) =>
          (event.type === "item.updated" || event.type === "item.completed") &&
          String(event.itemId) === "tool-call-1",
      );
      const completedToolEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> =>
          event.type === "item.completed" && String(event.itemId) === "tool-call-1",
      );
      const turnCompletedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );

      assert.deepEqual(requestOpenedEvents, []);
      assert.isAtLeast(toolItemEvents.length, 2);
      assert.equal(completedToolEvent?.payload.itemType, "command_execution");
      assert.equal(completedToolEvent?.payload.status, "completed");
      assert.equal(turnCompletedEvent?.payload.state, "completed");
      assert.equal(turnCompletedEvent?.payload.stopReason, "end_turn");

      // Full-access auto-approval prefers the agent's allow_always option.
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(
        requests.some(
          (entry) =>
            !("method" in entry) &&
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "optionId" in entry.result.outcome &&
            entry.result.outcome.optionId === "allow-always",
        ),
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("restores ready without completing an unstarted turn when preparation fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-preparation-failure-while-connecting");
      const wrapperPath = yield* Effect.promise(() => makeMockOmpWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "prepare invalid attachment",
          attachments: [
            {
              type: "image",
              id: "missing-image",
              name: "missing.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
        }),
      );
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const turnCompletedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.isUndefined(turnCompletedEvent);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("maps agent thought chunks to reasoning content deltas", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-thought-chunk");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          T3_ACP_EMIT_THOUGHT_CHUNK: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "think first", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const deltas = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
          event.type === "content.delta",
      );
      const reasoningDelta = deltas.find((event) => event.payload.streamKind === "reasoning_text");
      const assistantDelta = deltas.find((event) => event.payload.streamKind === "assistant_text");

      assert.equal(reasoningDelta?.payload.delta, "pondering the mock");
      assert.isTrue(String(reasoningDelta?.itemId ?? "").startsWith("reasoning:"));
      assert.equal(assistantDelta?.payload.delta, "hello from mock");
      assert.notEqual(String(reasoningDelta?.itemId), String(assistantDelta?.itemId));

      // The buffered thought settles as a completed reasoning item once the
      // assistant message starts, carrying the full text for the chat row.
      const reasoningItem = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> =>
          event.type === "item.completed" &&
          typeof event.payload === "object" &&
          event.payload !== null &&
          "itemType" in event.payload &&
          event.payload.itemType === "reasoning",
      );
      assert.isDefined(reasoningItem);
      const reasoningData =
        reasoningItem?.payload.data &&
        typeof reasoningItem.payload.data === "object" &&
        "text" in reasoningItem.payload.data
          ? reasoningItem.payload.data.text
          : undefined;
      assert.equal(reasoningData, "pondering the mock");
      const reasoningItemIndex = runtimeEvents.findIndex((event) => event === reasoningItem);
      const assistantDeltaIndex = runtimeEvents.findIndex((event) => event === assistantDelta);
      assert.isBelow(reasoningItemIndex, assistantDeltaIndex);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("projects usage updates into thread token usage events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-usage-update");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          T3_ACP_EMIT_USAGE_UPDATE: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "report usage", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const usageEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }> =>
          event.type === "thread.token-usage.updated",
      );

      assert.isDefined(usageEvent);
      assert.equal(String(usageEvent?.threadId), String(threadId));
      assert.equal(usageEvent?.payload.usage.usedTokens, 1234);
      assert.equal(usageEvent?.payload.usage.maxTokens, 8192);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("lets Stop unblock a fully silent Oh My Pi prompt and accept a follow-up turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-stop-after-full-silence");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* Effect.gen(function* () {
        yield* Effect.sleep("500 millis");
        yield* adapter.interruptTurn(threadId);
      }).pipe(Effect.forkChild({ startImmediately: true }));

      yield* adapter.sendTurn({
        threadId,
        input: "hang forever",
        attachments: [],
      });
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const cancelledEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.lengthOf(cancelledEvents, 1);
      assert.equal(cancelledEvents[0]?.payload.state, "cancelled");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      const followUpEventsBefore = runtimeEvents.length;
      yield* adapter.sendTurn({
        threadId,
        input: "continue after stop",
        attachments: [],
      });
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const followUpCompletedEvents = runtimeEvents
        .slice(followUpEventsBefore)
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
            event.type === "turn.completed" && String(event.threadId) === String(threadId),
        );
      assert.lengthOf(followUpCompletedEvents, 1);
      assert.equal(followUpCompletedEvents[0]?.payload.state, "completed");

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect(
    "settles the turn as failed when the Oh My Pi process dies mid-prompt, instead of hanging",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("omp-process-dies-mid-prompt");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockOmpWrapper({
            T3_ACP_EXIT_DURING_PROMPT: "1",
          }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);

        const runtimeEvents: ProviderRuntimeEvent[] = [];
        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        yield* adapter
          .sendTurn({
            threadId,
            input: "trigger a crash",
            attachments: [],
          })
          .pipe(Effect.ignore);

        const completedEvent = yield* Effect.gen(function* () {
          while (true) {
            const found = runtimeEvents.find(
              (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
                event.type === "turn.completed" && String(event.threadId) === String(threadId),
            );
            if (found) {
              return found;
            }
            yield* Effect.sleep("25 millis");
          }
        }).pipe(Effect.timeout("5 seconds"));

        assert.equal(completedEvent.payload.state, "failed");

        const sessionsAfter = yield* adapter.listSessions();
        const sessionAfter = sessionsAfter.find((session) => session.threadId === threadId);
        assert.notEqual(sessionAfter?.status, "running");

        yield* Fiber.interrupt(runtimeEventsFiber);
        yield* adapter.stopSession(threadId).pipe(Effect.ignore);
      }).pipe(TestClock.withLive),
  );

  it.effect("does not let a cancelled prompt settlement consume the follow-up prompt slot", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-cancelled-settlement-before-follow-up");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-cancel-race-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const firstTurnStarted = yield* Deferred.make<TurnId>();
      const twoTurnsCompleted = yield* Deferred.make<void>();
      const completedCountRef = yield* Ref.make(0);
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.ignore);
            return;
          }
          if (event.type !== "turn.completed") {
            return;
          }
          const completedCount = yield* Ref.updateAndGet(completedCountRef, (count) => count + 1);
          if (completedCount === 2) {
            yield* Deferred.succeed(twoTurnsCompleted, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "cancel this prompt", attachments: [] })
        .pipe(Effect.forkChild);
      const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(Effect.timeout("2 seconds"));
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');

      yield* adapter.interruptTurn(threadId, firstTurnId).pipe(Effect.timeout("2 seconds"));
      const followUp = yield* adapter
        .sendTurn({ threadId, input: "complete the follow-up", attachments: [] })
        .pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(firstSendTurnFiber).pipe(Effect.timeout("2 seconds"));
      yield* Deferred.await(twoTurnsCompleted).pipe(Effect.timeout("2 seconds"));

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.notEqual(String(followUp.turnId), String(firstTurnId));
      assert.deepEqual(
        turnCompletedEvents.map((event) => [String(event.turnId), event.payload.state]),
        [
          [String(firstTurnId), "cancelled"],
          [String(followUp.turnId), "completed"],
        ],
      );
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("drops late ACP notifications after a turn is cancelled", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-drop-late-cancelled-notifications");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          T3_ACP_HANG_PROMPT_FOREVER: "1",
          T3_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL: "1",
        }),
      );
      const lateNativeUpdate = yield* Deferred.make<void>();
      const adapter = yield* makeTestAdapter(wrapperPath, {
        nativeEventLogger: {
          filePath: "memory://omp-cancelled-native-events",
          write: (record: unknown) =>
            JSON.stringify(record).includes("late after cancel")
              ? Deferred.succeed(lateNativeUpdate, undefined).pipe(Effect.asVoid)
              : Effect.void,
          close: () => Effect.void,
        },
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnStarted = yield* Deferred.make<TurnId>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.started" &&
              event.turnId !== undefined &&
              String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnStarted, event.turnId).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "cancel before the late update", attachments: [] })
        .pipe(Effect.forkChild);
      const turnId = yield* Deferred.await(turnStarted).pipe(Effect.timeout("2 seconds"));
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("2 seconds"));
      yield* Deferred.await(lateNativeUpdate).pipe(Effect.timeout("2 seconds"));
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const cancelledIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "turn.completed" &&
          String(event.threadId) === String(threadId) &&
          String(event.turnId) === String(turnId) &&
          event.payload.state === "cancelled",
      );
      const turnOutputTypes = new Set([
        "content.delta",
        "item.started",
        "item.updated",
        "item.completed",
        "turn.plan.updated",
      ]);
      const outputAfterCancellation = runtimeEvents
        .slice(cancelledIndex + 1)
        .filter(
          (event) => String(event.threadId) === String(threadId) && turnOutputTypes.has(event.type),
        );

      assert.isAtLeast(cancelledIndex, 0);
      assert.deepEqual(outputAfterCancellation, []);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("settles the in-flight prompt before emitting completion", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-completion-before-next-turn");
      const wrapperPath = yield* Effect.promise(() => makeMockOmpWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const completedCountRef = yield* Ref.make(0);
      const secondTurnCompleted = yield* Deferred.make<void>();

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.type !== "turn.completed" || String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }

        return Ref.modify(completedCountRef, (count) => {
          const nextCount = count + 1;
          return [nextCount, nextCount] as const;
        }).pipe(
          Effect.flatMap((count) => {
            if (count === 1) {
              return adapter
                .sendTurn({
                  threadId,
                  input: "second turn after completion",
                  attachments: [],
                })
                .pipe(Effect.forkChild, Effect.asVoid);
            }
            if (count === 2) {
              return Deferred.succeed(secondTurnCompleted, undefined).pipe(Effect.asVoid);
            }
            return Effect.void;
          }),
        );
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });
      yield* Deferred.await(secondTurnCompleted);

      const completedCount = yield* Ref.get(completedCountRef);
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.equal(completedCount, 2);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("restores an Oh My Pi session to ready when the prompt RPC fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-prompt-failure-ready");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          T3_ACP_FAIL_PROMPT: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "fail prompt",
          attachments: [],
        }),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      const failedTurnCompleted = runtimeEvents.find(
        (event) => event.type === "turn.completed" && event.threadId === threadId,
      );

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);
      assert.equal(failedTurnCompleted?.type, "turn.completed");
      if (failedTurnCompleted?.type === "turn.completed") {
        assert.equal(failedTurnCompleted.payload.state, "failed");
        assert.isString(failedTurnCompleted.payload.errorMessage);
      }

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores replayed session/load updates when resuming an Oh My Pi session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-load-replay-filter");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          T3_ACP_EMIT_LOAD_REPLAY: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "after resume",
        attachments: [],
      });

      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      assert.isFalse(
        runtimeEvents.some(
          (event) => event.type === "item.completed" && event.payload.title === "Replay tool",
        ),
      );
      assert.isFalse(
        runtimeEvents.some(
          (event) =>
            event.type === "content.delta" && event.payload.delta === "replayed assistant text",
        ),
      );

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects startSession when provider mismatches", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockOmpWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("omp-provider-mismatch");

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
    }),
  );

  it.effect("rejects sendTurn with empty input and no attachments", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-empty-turn");

      const wrapperPath = yield* Effect.promise(() => makeMockOmpWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "   ",
          attachments: [],
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("responds to ACP approvals using provider-supplied option ids", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-custom-approval-option-id");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_ALLOW_ONCE_OPTION_ID: "agent-defined-approval-id",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "accept",
            )
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "approve this", attachments: [] });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(
        requests.some(
          (entry) =>
            !("method" in entry) &&
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "optionId" in entry.result.outcome &&
            entry.result.outcome.optionId === "agent-defined-approval-id",
        ),
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("continues streaming events when native notification logging fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-native-log-failure");
      const wrapperPath = yield* Effect.promise(() => makeMockOmpWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath, {
        nativeEventLogger: {
          filePath: "memory://omp-native-events",
          write: (record: unknown) =>
            typeof record === "object" &&
            record !== null &&
            "event" in record &&
            typeof record.event === "object" &&
            record.event !== null &&
            "kind" in record.event &&
            record.event.kind === "notification"
              ? Effect.die(new Error("native log write failed"))
              : Effect.void,
          close: () => Effect.void,
        },
      });
      const contentDelta = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "content.delta" ? Deferred.succeed(contentDelta, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "keep streaming", attachments: [] });
      yield* Deferred.await(contentDelta);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  // Production calls startSession from a request fiber that finishes as soon as
  // the session exists. `Effect.forkChild` made the notification consumer a
  // child of that fiber, and Effect interrupts a fiber's children when it
  // completes, so the consumer died on return and every later session/update
  // was dropped: the thread sat on "Working" forever while the provider
  // streamed its whole turn. Every other test here calls startSession directly
  // from the test fiber, which never completes, so the consumer survived and
  // the bug stayed invisible. Running it in a fiber that finishes is what
  // reproduces production.
  it.effect("keeps consuming notifications after the startSession fiber completes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-consumer-outlives-start-session");
      const wrapperPath = yield* Effect.promise(() => makeMockOmpWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed" && String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const startSessionFiber = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("omp"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Fiber.join(startSessionFiber).pipe(Effect.timeout("10 seconds"));

      // Forked, and the assertion waits on the projected event rather than on
      // sendTurn: with the consumer dead the turn never settles, so awaiting it
      // directly would hang until the suite timeout instead of failing here.
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hello omp", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("10 seconds"));

      const delta = runtimeEvents.find(
        (event) => event.type === "content.delta" && String(event.threadId) === String(threadId),
      );
      assert.isDefined(
        delta,
        "no content.delta was projected after the startSession fiber completed",
      );
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
      // Live clock so the timeouts above are real: under the default test clock
      // they wait on virtual time that never advances, and a regression would
      // hang until the suite timeout instead of failing here.
    }).pipe(TestClock.withLive),
  );

  it.effect("settles an omp rate-limit report as a failed turn carrying its reset instant", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-rate-limited");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({
          // Exactly what omp prints when the upstream provider answers 429: the
          // raw error as the whole assistant message, then a normal end_turn.
          T3_ACP_PROMPT_RESPONSE_TEXT:
            '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_011CeBMhQkPKvK4okSKtsEEL"} retry-after-ms=4300000',
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sentAtMs = yield* Clock.currentTimeMillis;
      yield* adapter.sendTurn({ threadId, input: "keep going", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const completed = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );

      assert.equal(completed?.payload.state, "failed");
      assert.include(completed?.payload.errorMessage ?? "", "Rate limited by the model provider");
      assert.include(completed?.payload.errorMessage ?? "", "about 72 min");
      const resetsAtMs = Date.parse(completed?.payload.rateLimitResetsAt ?? "");
      assert.isFalse(Number.isNaN(resetsAtMs), "rateLimitResetsAt must be an ISO instant");
      assert.isAbove(resetsAtMs, sentAtMs);
      // The notice text still reaches the timeline: the raw upstream error is
      // the evidence, the failed turn is the classification.
      const delta = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
          event.type === "content.delta",
      );
      assert.include(delta?.payload.delta ?? "", "rate_limit_error");

      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("keeps a normal turn completed when no rate-limit report was streamed", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-not-rate-limited");
      const wrapperPath = yield* Effect.promise(() => makeMockOmpWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("omp"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "hello omp", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const completed = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );

      assert.equal(completed?.payload.state, "completed");
      assert.isUndefined(completed?.payload.rateLimitResetsAt);

      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );
});
