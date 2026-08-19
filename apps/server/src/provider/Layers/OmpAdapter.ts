/**
 * OmpAdapterLive — Oh My Pi CLI (`omp acp`) via ACP.
 *
 * Standards-only ACP integration: permissions ride
 * `session/request_permission`, plans ride `plan` session updates, thinking
 * chunks ride `agent_thought_chunk`, and omp's plan-approval / extension-UI
 * dialogs ride form-mode `elicitation/create`, which this adapter routes
 * into T3 user-input events.
 *
 * @module OmpAdapterLive
 */
import {
  ApprovalRequestId,
  type OmpSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  type AcpSessionMode,
  type AcpSessionModeState,
  type AcpToolCallState,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  makeOmpElicitationAcceptedResponse,
  makeOmpElicitationCancelledResponse,
  parseOmpElicitationForm,
} from "../acp/OmpAcpElicitation.ts";
import {
  applyOmpAcpModelSelection,
  currentOmpModelIdFromSessionSetup,
  makeOmpAcpRuntime,
  resolveOmpAcpBaseModelId,
} from "../acp/OmpAcpSupport.ts";
import { type OmpAdapterShape } from "../Services/OmpAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("omp");
const OMP_RESUME_VERSION = 1 as const;
const ACP_PLAN_MODE_ALIASES = ["plan"];
const OMP_REASONING_TEXT_LIMIT = 8_000;
const ACP_IMPLEMENT_MODE_ALIASES = ["default", "code", "agent", "implement"];

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface OmpAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

type PendingUserInputResolution =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: "cancelled" };

interface PendingUserInput {
  readonly resolution: Deferred.Deferred<PendingUserInputResolution>;
}

interface OmpSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  /** Streaming thought segment: omp emits agent_thought_chunk deltas with a
   * per-segment item id; the buffer settles into a `reasoning` item when the
   * segment ends (other work starts, the id changes, or the prompt settles). */
  reasoningItemId: string | undefined;
  reasoningText: string;
  /**
   * Subtask roster per task-tool call id. Populated on the first frame (the
   * only one carrying `rawInput`); later async ticks lose their merge state
   * once the runtime evicts the completed call, so this map is the identity
   * source for post-ack progress.
   */
  readonly taskToolSubtasks: Map<string, ReadonlyArray<OmpTaskToolSubtask>>;
  /** Last emitted progress fingerprint per `${toolCallId}:${subtaskIndex}`. */
  readonly taskProgressFingerprints: Map<string, string>;
  /** Subtasks whose terminal task.completed already went out. */
  readonly completedTaskIds: Set<string>;
  /** Millis when the latest sendTurn bound its prompt; silence baseline. */
  turnStartedAtMillis: number | undefined;
  /** True while the silence watchdog has flagged the session quiet. */
  providerQuietMarked: boolean;
  /** Millis the session was first marked quiet; drives the give-up timer.
   * Undefined whenever providerQuietMarked is false. */
  providerQuietSinceMillis: number | undefined;
  activeTurnId: TurnId | undefined;
  /** Turns already interrupted; late prompt RPCs must not resurrect them. */
  interruptedTurnIds: Set<TurnId>;
  /** Number of sendTurn prompts currently in flight or being prepared.
   * >0 means a turn is actively running, so a new sendTurn is a steer that
   * continues it, and only the last remaining prompt settles the turn. */
  promptsInFlight: number;
  currentModelId: string | undefined;
  /**
   * Head of the assistant message being streamed, capped at
   * OMP_RATE_LIMIT_SCAN_LIMIT, so a rate-limit report split across content
   * deltas is still recognized. Reset per assistant item.
   */
  rateLimitScan: { turnId: TurnId; head: string } | undefined;
  /** Rate-limit report seen in this turn; settles the turn as failed. */
  rateLimitedTurn:
    | { turnId: TurnId; errorMessage: string; resetsAt: string | undefined }
    | undefined;
  stopped: boolean;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsCancelled(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.resolution, { _tag: "cancelled" }).pipe(Effect.ignore),
    { discard: true },
  );
}

function appendPromptResultToTurn(
  ctx: OmpSessionContext,
  turnId: TurnId,
  promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  result: EffectAcpSchema.PromptResponse,
): void {
  const existingTurnRecord = ctx.turns.find((turn) => turn.id === turnId);
  ctx.turns = existingTurnRecord
    ? ctx.turns.map((turn) =>
        turn.id === turnId
          ? { ...turn, items: [...turn.items, { prompt: promptParts, result }] }
          : turn,
      )
    : [...ctx.turns, { id: turnId, items: [{ prompt: promptParts, result }] }];
}

const resolveNotificationTurnId = (ctx: OmpSessionContext): TurnId | undefined => ctx.activeTurnId;

const resolveSessionCallbackTurnId = (
  sessions: ReadonlyMap<ThreadId, OmpSessionContext>,
  threadId: ThreadId,
): TurnId | undefined => sessions.get(threadId)?.activeTurnId;

function parseOmpResume(raw: unknown): { sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as { schemaVersion?: unknown; sessionId?: unknown };
  if (record.schemaVersion !== OMP_RESUME_VERSION) return undefined;
  if (typeof record.sessionId !== "string" || !record.sessionId.trim()) return undefined;
  return { sessionId: record.sessionId.trim() };
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find(
      (mode) => mode.id.toLowerCase() === alias || mode.name.toLowerCase() === alias,
    );
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

export function resolveOmpRequestedModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }
  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }
  return (
    findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
    modeState.availableModes.find(
      (mode) => findModeByAliases([mode], ACP_PLAN_MODE_ALIASES) === undefined,
    )?.id ??
    modeState.currentModeId
  );
}

function applyRequestedSessionConfiguration<E>(input: {
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly currentModelId: string | undefined;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: ReadonlyArray<ProviderOptionSelection> | null;
      }
    | undefined;
  readonly mapError: (context: {
    readonly cause: EffectAcpErrors.AcpError;
    readonly method: "session/set_config_option" | "session/set_mode";
  }) => E;
}): Effect.Effect<string | undefined, E> {
  return Effect.gen(function* () {
    const requestedModelId = input.modelSelection?.model
      ? resolveOmpAcpBaseModelId(input.modelSelection.model)
      : undefined;
    const effectiveModelId = yield* applyOmpAcpModelSelection({
      runtime: input.runtime,
      currentModelId: input.currentModelId,
      requestedModelId,
      selections: input.modelSelection?.options,
      mapError: ({ cause }) =>
        input.mapError({
          cause,
          method: "session/set_config_option",
        }),
    });

    const requestedModeId = resolveOmpRequestedModeId({
      interactionMode: input.interactionMode,
      modeState: yield* input.runtime.getModeState,
    });
    if (requestedModeId) {
      yield* input.runtime.setMode(requestedModeId).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            method: "session/set_mode",
          }),
        ),
      );
    }
    return effectiveModelId;
  });
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const option = request.options.find((entry) => entry.kind === kind);
  return option?.optionId.trim() || undefined;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "acceptForSession") ??
    selectPermissionOptionId(request, "accept")
  );
}

const OMP_TOOL_CALL_FILE_LIMIT = 12;

/**
 * Surfaces omp's edited-file paths on file-change tool calls. The ACP
 * mapping carries them as `data.locations`, which the activity wire
 * projection strips; the projection's `files: [{path}]` channel is kept
 * and renders as the changed-file list on the work row.
 */
export function enrichOmpToolCallFiles(toolCall: AcpToolCallState): AcpToolCallState {
  if (toolCall.kind !== "edit" && toolCall.kind !== "delete" && toolCall.kind !== "move") {
    return toolCall;
  }
  const locations = toolCall.data.locations;
  if (!Array.isArray(locations) || locations.length === 0) {
    return toolCall;
  }
  const seen = new Set<string>();
  const files: Array<{ readonly path: string }> = [];
  for (const location of locations) {
    if (files.length >= OMP_TOOL_CALL_FILE_LIMIT) {
      break;
    }
    if (typeof location !== "object" || location === null || !("path" in location)) {
      continue;
    }
    const path = location.path;
    if (typeof path !== "string" || !path.trim() || seen.has(path)) {
      continue;
    }
    seen.add(path);
    files.push({ path });
  }
  if (files.length === 0) {
    return toolCall;
  }
  return {
    ...toolCall,
    data: { ...toolCall.data, files },
  };
}

export interface OmpTaskToolSubtask {
  readonly taskId: string;
  readonly title: string;
  readonly role?: string;
  readonly description: string;
}

/**
 * Recognizes omp's subagent `task` tool from its args shape — a `context`
 * string plus a `tasks` array of `{task, name?, agent?}` records — and maps
 * each subtask to a stable task id derived from the tool call. Subagent
 * lifecycle never crosses the ACP wire, so these synthesized entries are the
 * only way the Agents surface lights up for omp.
 */
export function parseOmpTaskToolCall(
  toolCall: AcpToolCallState,
): ReadonlyArray<OmpTaskToolSubtask> | undefined {
  const rawInput = toolCall.data.rawInput;
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
    return undefined;
  }
  if (!("context" in rawInput) || typeof rawInput.context !== "string") {
    return undefined;
  }
  if (!("tasks" in rawInput) || !Array.isArray(rawInput.tasks)) {
    return undefined;
  }
  const subtasks: OmpTaskToolSubtask[] = [];
  for (const [index, taskValue] of rawInput.tasks.entries()) {
    if (typeof taskValue !== "object" || taskValue === null || Array.isArray(taskValue)) {
      continue;
    }
    const description =
      "task" in taskValue && typeof taskValue.task === "string" ? taskValue.task.trim() : "";
    if (description.length === 0) {
      continue;
    }
    const name =
      "name" in taskValue && typeof taskValue.name === "string" ? taskValue.name.trim() : "";
    const agent =
      "agent" in taskValue && typeof taskValue.agent === "string" ? taskValue.agent.trim() : "";
    const firstLine = description.split("\n", 1)[0]?.trim() ?? description;
    subtasks.push({
      taskId: `${toolCall.toolCallId}:${index}`,
      title:
        name.length > 0 ? name : firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine,
      ...(agent.length > 0 ? { role: agent } : {}),
      description,
    });
  }
  return subtasks.length > 0 ? subtasks : undefined;
}

const OMP_TASK_STATUS_MAP: Record<
  string,
  "pending" | "running" | "completed" | "failed" | "cancelled"
> = {
  pending: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
  aborted: "cancelled",
};

export interface OmpTaskProgressSnapshot {
  readonly index: number;
  readonly status: "pending" | "running" | "completed" | "failed" | "cancelled";
  readonly lastIntent?: string;
  readonly currentTool?: string;
  readonly toolCount?: number;
  readonly tokens?: number;
  readonly durationMs?: number;
  readonly resolvedModel?: string;
}

function ompTaskDetails(toolCall: AcpToolCallState): Record<string, unknown> | undefined {
  const rawOutput = toolCall.data.rawOutput;
  if (typeof rawOutput !== "object" || rawOutput === null || !("details" in rawOutput)) {
    return undefined;
  }
  const details = rawOutput.details;
  return typeof details === "object" && details !== null && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readCount(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/**
 * Live per-subagent progress from the task tool's streaming `rawOutput.details.progress`
 * (`AgentProgress[]` in omp). This is the same data omp's RPC-only
 * `subagent_progress` frames carry — over ACP it rides the tool update.
 */
export function parseOmpTaskToolProgress(
  toolCall: AcpToolCallState,
): ReadonlyArray<OmpTaskProgressSnapshot> | undefined {
  const details = ompTaskDetails(toolCall);
  if (!details || !Array.isArray(details.progress)) {
    return undefined;
  }
  const snapshots: OmpTaskProgressSnapshot[] = [];
  for (const entryValue of details.progress) {
    if (typeof entryValue !== "object" || entryValue === null || Array.isArray(entryValue)) {
      continue;
    }
    const entry = entryValue as Record<string, unknown>;
    const index = readCount(entry, "index");
    const status = OMP_TASK_STATUS_MAP[readString(entry, "status") ?? ""];
    if (index === undefined || status === undefined) {
      continue;
    }
    const lastIntent = readString(entry, "lastIntent");
    const currentTool = readString(entry, "currentTool");
    const toolCount = readCount(entry, "toolCount");
    const tokens = readCount(entry, "tokens");
    const durationMs = readCount(entry, "durationMs");
    const resolvedModel = readString(entry, "resolvedModel");
    snapshots.push({
      index,
      status,
      ...(lastIntent !== undefined ? { lastIntent } : {}),
      ...(currentTool !== undefined ? { currentTool } : {}),
      ...(toolCount !== undefined ? { toolCount } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(resolvedModel !== undefined ? { resolvedModel } : {}),
    });
  }
  return snapshots.length > 0 ? snapshots : undefined;
}

export interface OmpTaskResultSnapshot {
  readonly index: number;
  readonly status: "completed" | "failed" | "stopped";
  readonly summary?: string;
  readonly tokens?: number;
  readonly durationMs?: number;
  readonly resolvedModel?: string;
}

/** Terminal per-subagent outcomes from the task tool's final `rawOutput.details.results`. */
export function parseOmpTaskToolResults(
  toolCall: AcpToolCallState,
): ReadonlyArray<OmpTaskResultSnapshot> | undefined {
  const details = ompTaskDetails(toolCall);
  if (!details || !Array.isArray(details.results)) {
    return undefined;
  }
  const results: OmpTaskResultSnapshot[] = [];
  for (const entryValue of details.results) {
    if (typeof entryValue !== "object" || entryValue === null || Array.isArray(entryValue)) {
      continue;
    }
    const entry = entryValue as Record<string, unknown>;
    const index = readCount(entry, "index");
    if (index === undefined) {
      continue;
    }
    const error = readString(entry, "error");
    const exitCode = typeof entry.exitCode === "number" ? entry.exitCode : 0;
    const aborted = entry.aborted === true;
    const status = aborted
      ? "stopped"
      : error !== undefined || exitCode !== 0
        ? "failed"
        : "completed";
    const output = readString(entry, "output");
    const summarySource = error ?? output;
    const firstLine = summarySource?.split("\n", 1)[0]?.trim();
    const tokens = readCount(entry, "tokens");
    const durationMs = readCount(entry, "durationMs");
    const resolvedModel = readString(entry, "resolvedModel");
    results.push({
      index,
      status,
      ...(firstLine ? { summary: firstLine } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(resolvedModel !== undefined ? { resolvedModel } : {}),
    });
  }
  return results.length > 0 ? results : undefined;
}

/**
 * The task tool's async-job mode acks the tool call as "completed" while
 * subagents are still running; the job state rides in `details.async`.
 * Callers must not treat the call status as subtask completion while this
 * reports "running".
 */
export function parseOmpTaskAsyncState(
  toolCall: AcpToolCallState,
): "running" | "completed" | "failed" | undefined {
  const details = ompTaskDetails(toolCall);
  const asyncValue = details?.async;
  if (typeof asyncValue !== "object" || asyncValue === null || Array.isArray(asyncValue)) {
    return undefined;
  }
  // Guarded record read; the shape is omp's TaskToolDetails.async.
  const asyncRecord = asyncValue as Record<string, unknown>;
  const state = readString(asyncRecord, "state");
  return state === "running" || state === "completed" || state === "failed" ? state : undefined;
}

/**
 * How long a running turn may go without a single inbound native frame
 * before the session is flagged quiet. The observed failure mode is omp
 * retrying upstream 529s internally every ~60-105s without reporting;
 * normal streaming gaps are seconds and worst-case first-token latency on
 * huge prompts stays under ~60s, so 75s avoids false positives while
 * flagging a real stall within ~90s.
 */
export const OMP_PROVIDER_QUIET_THRESHOLD_MILLIS = 75_000;

export type OmpQuietTransition =
  | { readonly _tag: "mark"; readonly quietSinceMillis: number }
  | { readonly _tag: "clear" }
  | { readonly _tag: "none" };

/**
 * Decides whether the silence watchdog should flag or unflag the session.
 * Silence only counts while a turn is running with nothing legitimately
 * outstanding: an in-flight tool call, a pending approval, or a pending
 * user-input question all suppress it — those states wait on the tool or
 * the human, not on the provider.
 */
export function resolveOmpQuietTransition(input: {
  readonly nowMillis: number;
  readonly turnActive: boolean;
  readonly turnStartedAtMillis: number | undefined;
  readonly lastInboundFrameAtMillis: number | undefined;
  readonly openToolCallCount: number;
  readonly pendingApprovalCount: number;
  readonly pendingUserInputCount: number;
  readonly quietAlreadyMarked: boolean;
  readonly thresholdMillis: number;
}): OmpQuietTransition {
  if (!input.turnActive) {
    // Settlement clears the session field through its own session update.
    return { _tag: "none" };
  }
  const baselineMillis = Math.max(
    input.turnStartedAtMillis ?? 0,
    input.lastInboundFrameAtMillis ?? 0,
  );
  const eligible =
    baselineMillis > 0 &&
    input.openToolCallCount === 0 &&
    input.pendingApprovalCount === 0 &&
    input.pendingUserInputCount === 0;
  const silent = eligible && input.nowMillis - baselineMillis >= input.thresholdMillis;
  if (silent) {
    return input.quietAlreadyMarked
      ? { _tag: "none" }
      : { _tag: "mark", quietSinceMillis: baselineMillis };
  }
  return input.quietAlreadyMarked ? { _tag: "clear" } : { _tag: "none" };
}

/**
 * How long a session may stay flagged quiet before the watchdog gives up on
 * the turn instead of leaving it "Working" forever. Distinct from — and much
 * larger than — the quiet-mark threshold above: marking only informs the
 * user something looks stalled (with a manual Stop still available); this
 * is the point past which nobody is realistically still watching a banner,
 * so the turn is failed automatically. Ten minutes of total silence is far
 * beyond any legitimate non-streaming generation gap, so it only fires on a
 * genuinely stuck provider (see the module doc for the retrying-forever
 * failure mode this whole watchdog exists for).
 */
export const OMP_PROVIDER_SILENCE_GIVE_UP_THRESHOLD_MILLIS = 10 * 60_000;

/**
 * Decides whether sustained silence, tracked from the moment the watchdog
 * first marked the session quiet, has crossed the give-up threshold.
 */
export function resolveOmpSilenceGiveUp(input: {
  readonly nowMillis: number;
  readonly quietSinceMillis: number | undefined;
  readonly thresholdMillis: number;
}): boolean {
  return (
    input.quietSinceMillis !== undefined &&
    input.nowMillis - input.quietSinceMillis >= input.thresholdMillis
  );
}

export function ompPromptSettlementBelongsToContext(input: {
  readonly liveAcpSessionId: string;
  readonly expectedAcpSessionId: string;
  readonly liveActiveTurnId: TurnId | undefined;
  readonly liveSessionActiveTurnId: TurnId | undefined;
  readonly turnId: TurnId;
}): boolean {
  return (
    input.liveAcpSessionId === input.expectedAcpSessionId &&
    (input.liveActiveTurnId === input.turnId || input.liveSessionActiveTurnId === input.turnId)
  );
}

/**
 * Parsed shape of the upstream rate-limit error omp reports as assistant text,
 * e.g. `429 {"type":"error","error":{"type":"rate_limit_error","message":"…"},
 * "request_id":"req_…"} retry-after-ms=4300000`.
 */
export interface OmpRateLimitNotice {
  /** Milliseconds the provider asked us to wait, when it reported one. */
  readonly retryAfterMs: number | undefined;
  readonly requestId: string | undefined;
  readonly providerMessage: string | undefined;
}

/** Longest assistant-message head scanned for a rate-limit notice. */
export const OMP_RATE_LIMIT_SCAN_LIMIT = 512;

/**
 * Recognizes omp's raw rate-limit report, which arrives as the whole assistant
 * message: omp prints the upstream HTTP error verbatim and ends the turn with
 * `end_turn`, so without this the turn is recorded as a success whose only
 * content is a 429 blob.
 *
 * Deliberately strict — the notice must BE the message, not appear inside it.
 * An agent quoting a 429 while discussing rate limits is prose, not a failure.
 */
export function parseOmpRateLimitNotice(text: string): OmpRateLimitNotice | undefined {
  const trimmed = text.trim();
  if (!/^429\b/.test(trimmed) || !trimmed.includes("rate_limit_error")) {
    return undefined;
  }
  const retryAfter = /retry-after-ms=(\d{1,15})\b/.exec(trimmed);
  const requestId = /"request_id"\s*:\s*"([^"]{1,128})"/.exec(trimmed);
  const providerMessage = /"message"\s*:\s*"([^"]{1,400})"/.exec(trimmed);
  return {
    retryAfterMs: retryAfter ? Number(retryAfter[1]) : undefined,
    requestId: requestId?.[1],
    providerMessage: providerMessage?.[1],
  };
}

/**
 * Turn error text for a rate-limit notice. Carries the absolute instant (the
 * client renders it in local time) plus the wait in minutes, so the banner
 * answers "when can I retry" without the user decoding `retry-after-ms`.
 */
export function formatOmpRateLimitTurnError(
  notice: OmpRateLimitNotice,
  resetsAt: string | undefined,
): string {
  const detail = notice.providerMessage ?? "The model provider rate-limited this account.";
  if (resetsAt === undefined || notice.retryAfterMs === undefined) {
    return `Rate limited by the model provider. ${detail}`;
  }
  const minutes = Math.max(1, Math.round(notice.retryAfterMs / 60_000));
  return `Rate limited by the model provider. ${detail} Retry after ${resetsAt} (about ${minutes} min).`;
}

export function makeOmpAdapter(ompSettings: OmpSettings, options?: OmpAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("omp");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, OmpSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Oh My Pi runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Oh My Pi ACP callback.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    /**
     * Settles the buffered thinking segment as a completed `reasoning` item so
     * ingestion can append a "Thought" activity. Nothing on the ACP wire marks
     * a thought segment's end, so callers flush when other work starts, the
     * segment id changes, or the prompt settles.
     */
    const flushReasoningBuffer = (ctx: OmpSessionContext, turnId: TurnId | undefined) =>
      Effect.gen(function* () {
        const text = ctx.reasoningText.trim();
        const itemId = ctx.reasoningItemId;
        ctx.reasoningItemId = undefined;
        ctx.reasoningText = "";
        if (text.length === 0 || turnId === undefined) {
          return;
        }
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.completed",
          ...stamp,
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          itemId: RuntimeItemId.make(itemId ?? `reasoning:${stamp.eventId}`),
          payload: {
            itemType: "reasoning",
            status: "completed",
            data: {
              text:
                text.length > OMP_REASONING_TEXT_LIMIT
                  ? `${text.slice(0, OMP_REASONING_TEXT_LIMIT).trimEnd()}…`
                  : text,
            },
          },
        });
      });

    /**
     * Synthesizes subagent lifecycle from omp's `task` tool call. ACP carries
     * no subagent frames — the roster rides in the call's streaming
     * `rawOutput.details`. Async-job mode acks the CALL as completed while
     * agents still run, so per-subtask terminality comes from the streamed
     * `progress[].status`, never from the call status alone.
     */
    const emitTaskToolLifecycle = (
      ctx: OmpSessionContext,
      turnId: TurnId,
      toolCall: AcpToolCallState,
      subtasks: ReadonlyArray<OmpTaskToolSubtask>,
    ) =>
      Effect.gen(function* () {
        if (!ctx.taskToolSubtasks.has(toolCall.toolCallId)) {
          ctx.taskToolSubtasks.set(toolCall.toolCallId, subtasks);
          for (const subtask of subtasks) {
            yield* offerRuntimeEvent({
              type: "task.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId,
              payload: {
                taskId: RuntimeTaskId.make(subtask.taskId),
                description: subtask.description,
                agentKind: "agent",
                title: subtask.title,
                ...(subtask.role !== undefined ? { role: subtask.role } : {}),
                toolUseId: toolCall.toolCallId,
              },
            });
          }
        }

        const taskLinkage = (subtask: OmpTaskToolSubtask) =>
          ({
            agentKind: "agent",
            title: subtask.title,
            ...(subtask.role !== undefined ? { role: subtask.role } : {}),
            toolUseId: toolCall.toolCallId,
          }) as const;

        const snapshots = parseOmpTaskToolProgress(toolCall) ?? [];
        for (const snapshot of snapshots) {
          const subtask = subtasks[snapshot.index];
          if (!subtask || ctx.completedTaskIds.has(subtask.taskId)) {
            continue;
          }
          const typedUsage =
            snapshot.tokens !== undefined
              ? {
                  typedUsage: {
                    totalTokens: snapshot.tokens,
                    ...(snapshot.toolCount !== undefined ? { toolUses: snapshot.toolCount } : {}),
                    ...(snapshot.durationMs !== undefined
                      ? { durationMs: snapshot.durationMs }
                      : {}),
                  },
                }
              : {};
          if (
            snapshot.status === "completed" ||
            snapshot.status === "failed" ||
            snapshot.status === "cancelled"
          ) {
            ctx.completedTaskIds.add(subtask.taskId);
            yield* offerRuntimeEvent({
              type: "task.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              turnId,
              payload: {
                taskId: RuntimeTaskId.make(subtask.taskId),
                status: snapshot.status === "cancelled" ? "stopped" : snapshot.status,
                ...(snapshot.lastIntent !== undefined ? { summary: snapshot.lastIntent } : {}),
                ...typedUsage,
                ...(snapshot.resolvedModel !== undefined ? { model: snapshot.resolvedModel } : {}),
                ...taskLinkage(subtask),
              },
            });
            continue;
          }
          // One progress event per observable change — omp re-sends the whole
          // roster on every tick, so a fingerprint keeps the event stream (and
          // persisted activities) proportional to real work.
          const fingerprintKey = `${toolCall.toolCallId}:${snapshot.index}`;
          const fingerprint = [
            snapshot.status,
            snapshot.toolCount ?? "",
            snapshot.currentTool ?? "",
            snapshot.lastIntent ?? "",
          ].join("\u001f");
          if (ctx.taskProgressFingerprints.get(fingerprintKey) === fingerprint) {
            continue;
          }
          ctx.taskProgressFingerprints.set(fingerprintKey, fingerprint);
          yield* offerRuntimeEvent({
            type: "task.progress",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: {
              taskId: RuntimeTaskId.make(subtask.taskId),
              description: snapshot.lastIntent ?? subtask.title,
              ...(snapshot.lastIntent !== undefined ? { summary: snapshot.lastIntent } : {}),
              ...(snapshot.currentTool !== undefined ? { lastToolName: snapshot.currentTool } : {}),
              status: snapshot.status,
              ...typedUsage,
              ...(snapshot.resolvedModel !== undefined ? { model: snapshot.resolvedModel } : {}),
              ...taskLinkage(subtask),
            },
          });
        }

        // The call itself settling only closes subtasks when the roster is
        // truly done: sync-mode results, or a non-running async job. An
        // async-mode ack (job still running) keeps rows live for later ticks.
        const asyncState = parseOmpTaskAsyncState(toolCall);
        const callTerminal =
          (toolCall.status === "completed" || toolCall.status === "failed") &&
          asyncState !== "running";
        if (!callTerminal) {
          return;
        }
        const results = parseOmpTaskToolResults(toolCall);
        for (const [index, subtask] of subtasks.entries()) {
          if (ctx.completedTaskIds.has(subtask.taskId)) {
            continue;
          }
          const result = results?.find((entry) => entry.index === index);
          if (!result && asyncState !== undefined) {
            // Async job without a per-subtask outcome yet — completion will
            // arrive via a later progress tick.
            continue;
          }
          ctx.completedTaskIds.add(subtask.taskId);
          yield* offerRuntimeEvent({
            type: "task.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: {
              taskId: RuntimeTaskId.make(subtask.taskId),
              status: result?.status ?? (toolCall.status === "failed" ? "failed" : "completed"),
              ...(result?.summary !== undefined ? { summary: result.summary } : {}),
              ...(result?.tokens !== undefined
                ? {
                    typedUsage: {
                      totalTokens: result.tokens,
                      ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
                    },
                  }
                : {}),
              ...(result?.resolvedModel !== undefined ? { model: result.resolvedModel } : {}),
              ...taskLinkage(subtask),
            },
          });
        }
      });

    /**
     * Terminal payload for a turn whose outcome was omp echoing an upstream
     * rate-limit error: `end_turn` from omp would otherwise record a success
     * whose only content is the 429 blob. Consumes the notice so a second
     * settle for the same turn cannot re-report it.
     */
    const takeRateLimitFailurePayload = (ctx: OmpSessionContext, turnId: TurnId) => {
      const rateLimited = ctx.rateLimitedTurn;
      if (rateLimited === undefined || rateLimited.turnId !== turnId) {
        return undefined;
      }
      ctx.rateLimitedTurn = undefined;
      return {
        state: "failed" as const,
        errorMessage: rateLimited.errorMessage,
        ...(rateLimited.resetsAt !== undefined ? { rateLimitResetsAt: rateLimited.resetsAt } : {}),
      };
    };

    const settlePromptInFlight = (
      threadId: ThreadId,
      turnId: TurnId,
      expectedAcpSessionId: string,
      options?: {
        readonly errorMessage?: string;
        readonly completedStopReason?: EffectAcpSchema.StopReason | null;
        readonly emitTurnCompletion?: boolean;
        /** Interrupt/cancel: drop every outstanding prompt slot and settle once. */
        readonly settleAllPrompts?: boolean;
      },
    ) =>
      Effect.gen(function* () {
        const liveCtx = sessions.get(threadId);
        if (!liveCtx) {
          return;
        }
        const settlementBelongsToLiveContext = ompPromptSettlementBelongsToContext({
          liveAcpSessionId: liveCtx.acpSessionId,
          expectedAcpSessionId,
          liveActiveTurnId: liveCtx.activeTurnId,
          liveSessionActiveTurnId: liveCtx.session.activeTurnId,
          turnId,
        });
        if (!settlementBelongsToLiveContext) {
          // interruptTurn already consumed every prompt slot for this turn. A
          // late prompt result must neither emit a second terminal event nor
          // consume a slot belonging to a newer turn on the same ACP session.
          if (
            liveCtx.acpSessionId !== expectedAcpSessionId ||
            liveCtx.interruptedTurnIds.has(turnId)
          ) {
            return;
          }
          if (options?.emitTurnCompletion !== false) {
            if (options?.errorMessage !== undefined) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId,
                turnId,
                payload: {
                  state: "failed",
                  errorMessage: options.errorMessage,
                },
              });
            } else if (options?.completedStopReason !== undefined) {
              const rateLimitFailure =
                options.completedStopReason === "cancelled"
                  ? undefined
                  : takeRateLimitFailurePayload(liveCtx, turnId);
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId,
                turnId,
                payload: rateLimitFailure ?? {
                  state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
                  stopReason: options.completedStopReason ?? null,
                },
              });
            }
          }
          return;
        }
        let settleTurnId = turnId;
        if (options?.settleAllPrompts) {
          liveCtx.promptsInFlight = 0;
          if (liveCtx.activeTurnId !== turnId && liveCtx.session.activeTurnId !== turnId) {
            const fallbackTurnId = liveCtx.activeTurnId ?? liveCtx.session.activeTurnId;
            if (!fallbackTurnId) {
              if (liveCtx.session.status === "running" || liveCtx.session.status === "connecting") {
                const updatedAt = yield* nowIso;
                const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
                liveCtx.activeTurnId = undefined;
                liveCtx.session = {
                  ...readySession,
                  status: "ready",
                  updatedAt,
                };
              }
              return;
            }
            settleTurnId = fallbackTurnId;
          }
        } else {
          const remainingPrompts = Math.max(0, liveCtx.promptsInFlight - 1);
          if (
            remainingPrompts > 0 ||
            liveCtx.activeTurnId !== settleTurnId ||
            liveCtx.session.activeTurnId !== settleTurnId
          ) {
            liveCtx.promptsInFlight = remainingPrompts;
            return;
          }
          liveCtx.promptsInFlight = remainingPrompts;
        }
        // The turn is settling: surface any trailing thought segment before
        // the terminal event so its activity lands inside the turn.
        yield* flushReasoningBuffer(liveCtx, settleTurnId);
        // The settlement's own session update clears providerQuietSince in
        // the read model; only the local watchdog state needs resetting.
        liveCtx.providerQuietMarked = false;
        liveCtx.providerQuietSinceMillis = undefined;
        liveCtx.turnStartedAtMillis = undefined;
        // Async task jobs can outlive the turn inside omp, but the wire can
        // no longer update their rows once the turn is gone — mark them
        // backgrounded instead of leaving a live "working" state behind.
        for (const [toolCallId, subtasks] of liveCtx.taskToolSubtasks) {
          for (const subtask of subtasks) {
            if (liveCtx.completedTaskIds.has(subtask.taskId)) {
              continue;
            }
            yield* offerRuntimeEvent({
              type: "task.updated",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId,
              turnId: settleTurnId,
              payload: {
                taskId: RuntimeTaskId.make(subtask.taskId),
                status: "idle",
                isBackgrounded: true,
                agentKind: "agent",
                title: subtask.title,
                ...(subtask.role !== undefined ? { role: subtask.role } : {}),
                toolUseId: toolCallId,
              },
            });
          }
        }
        const updatedAt = yield* nowIso;
        const canEmitTurnCompletion =
          liveCtx.session.status === "running" || liveCtx.session.status === "connecting";
        const shouldEmitFailedTurn = options?.errorMessage !== undefined && canEmitTurnCompletion;
        const shouldEmitCompletedTurn =
          options?.completedStopReason !== undefined && canEmitTurnCompletion;
        const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
        liveCtx.activeTurnId = undefined;
        liveCtx.session = {
          ...readySession,
          status: "ready",
          updatedAt,
        };
        if (options?.emitTurnCompletion === false) {
          return;
        }
        if (shouldEmitFailedTurn) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: "failed",
              errorMessage: options.errorMessage,
            },
          });
        } else if (shouldEmitCompletedTurn) {
          const rateLimitFailure =
            options?.completedStopReason === "cancelled"
              ? undefined
              : takeRateLimitFailurePayload(liveCtx, settleTurnId);
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: rateLimitFailure ?? {
              state: options?.completedStopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: options?.completedStopReason ?? null,
            },
          });
        }
      });

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write native Oh My Pi notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const emitPlanUpdate = (
      ctx: OmpSessionContext,
      turnId: TurnId | undefined,
      stamp: { readonly eventId: EventId; readonly createdAt: string },
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${turnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload,
            source: "acp.jsonrpc",
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<OmpSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: OmpSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: OmpAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const ompModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const resumeSessionId = parseOmpResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          // Shared with the session context below: the suppression override
          // must recognize post-ack async ticks whose merge state (and thus
          // rawInput) the runtime already evicted.
          const taskToolSubtasks = new Map<string, ReadonlyArray<OmpTaskToolSubtask>>();
          const acp = yield* makeOmpAcpRuntime({
            ompSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            advertiseElicitation: true,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            // Task-tool progress rides in rawOutput with an unchanged title;
            // without this the default gate drops every live subagent update.
            shouldEmitSuppressedToolCallUpdate: (previous, next) =>
              (taskToolSubtasks.has(next.toolCallId) || parseOmpTaskToolCall(next) !== undefined) &&
              previous?.data.rawOutput !== next.data.rawOutput,
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "t3-code",
                      url: mcpSession.endpoint,
                      headers: [
                        {
                          name: "Authorization",
                          value: mcpSession.authorizationHeader,
                        },
                      ],
                    },
                  ],
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          const started = yield* Effect.gen(function* () {
            yield* acp.handleElicitation((params) =>
              mapAcpCallbackFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "elicitation/create", params);
                  const fields = parseOmpElicitationForm(params);
                  if (!fields || fields.length === 0) {
                    return makeOmpElicitationCancelledResponse();
                  }
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const resolution = yield* Deferred.make<PendingUserInputResolution>();
                  const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
                  pendingUserInputs.set(requestId, { resolution });
                  yield* offerRuntimeEvent({
                    type: "user-input.requested",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    requestId: runtimeRequestId,
                    payload: { questions: fields.map((field) => field.question) },
                    raw: {
                      source: "acp.jsonrpc",
                      method: "elicitation/create",
                      payload: params,
                    },
                  });
                  const resolved = yield* Deferred.await(resolution);
                  pendingUserInputs.delete(requestId);
                  const resolvedAnswers = resolved._tag === "answered" ? resolved.answers : {};
                  yield* offerRuntimeEvent({
                    type: "user-input.resolved",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    requestId: runtimeRequestId,
                    payload: { answers: resolvedAnswers },
                    raw: {
                      source: "acp.jsonrpc",
                      method: "elicitation/create",
                      payload: params,
                    },
                  });
                  if (resolved._tag === "cancelled") {
                    return makeOmpElicitationCancelledResponse();
                  }
                  return (
                    makeOmpElicitationAcceptedResponse(fields, resolved.answers) ??
                    makeOmpElicitationCancelledResponse()
                  );
                }),
              ),
            );
            yield* acp.handleRequestPermission((params) =>
              mapAcpCallbackFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "session/request_permission", params);
                  if (input.runtimeMode === "full-access") {
                    const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                    if (autoApprovedOptionId !== undefined) {
                      return {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: autoApprovedOptionId,
                        },
                      };
                    }
                  }
                  const permissionRequest = parsePermissionRequest(params);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
                  pendingApprovals.set(requestId, { decision });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  const selectedOptionId =
                    resolved === "cancel" ? undefined : selectPermissionOptionId(params, resolved);
                  return {
                    outcome: selectedOptionId
                      ? {
                          outcome: "selected" as const,
                          optionId: selectedOptionId,
                        }
                      : ({ outcome: "cancelled" } as const),
                  };
                }),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          const boundModelId = yield* applyRequestedSessionConfiguration({
            runtime: acp,
            interactionMode: undefined,
            currentModelId: currentOmpModelIdFromSessionSetup(started.sessionSetupResult),
            modelSelection: ompModelSelection?.model
              ? {
                  model: ompModelSelection.model,
                  ...(ompModelSelection.options !== undefined
                    ? { options: ompModelSelection.options }
                    : {}),
                }
              : undefined,
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(boundModelId ? { model: boundModelId } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: OMP_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          const ctx: OmpSessionContext = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            reasoningItemId: undefined,
            reasoningText: "",
            taskToolSubtasks,
            taskProgressFingerprints: new Map(),
            completedTaskIds: new Set(),
            turnStartedAtMillis: undefined,
            providerQuietMarked: false,
            providerQuietSinceMillis: undefined,
            activeTurnId: undefined,
            interruptedTurnIds: new Set(),
            promptsInFlight: 0,
            currentModelId: boundModelId,
            rateLimitScan: undefined,
            rateLimitedTurn: undefined,
            stopped: false,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                if (event._tag === "EventStreamBarrier") {
                  yield* Deferred.succeed(event.acknowledge, undefined);
                  return;
                }
                if (
                  event._tag === "PlanUpdated" ||
                  event._tag === "ToolCallUpdated" ||
                  event._tag === "ContentDelta" ||
                  event._tag === "ThoughtDelta" ||
                  event._tag === "UsageUpdated"
                ) {
                  yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                }

                if (event._tag === "ModeChanged" || event._tag === "AvailableCommandsChanged") {
                  return;
                }

                if (event._tag === "UsageUpdated") {
                  yield* offerRuntimeEvent({
                    type: "thread.token-usage.updated",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    payload: {
                      usage: {
                        usedTokens: event.usedTokens,
                        ...(event.maxTokens !== undefined ? { maxTokens: event.maxTokens } : {}),
                      },
                    },
                  });
                  return;
                }

                const notificationTurnId = resolveNotificationTurnId(ctx);
                if (
                  notificationTurnId === undefined ||
                  ctx.interruptedTurnIds.has(notificationTurnId)
                ) {
                  return;
                }
                const stamp = yield* makeEventStamp();

                // Any non-thought notification means the thinking segment is
                // over; settle it first so the "Thought" row precedes the work
                // it led to.
                if (event._tag !== "ThoughtDelta" && ctx.reasoningText.length > 0) {
                  yield* flushReasoningBuffer(ctx, notificationTurnId);
                }

                switch (event._tag) {
                  case "AssistantItemStarted":
                    ctx.rateLimitScan = { turnId: notificationTurnId, head: "" };
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* emitPlanUpdate(
                      ctx,
                      notificationTurnId,
                      stamp,
                      event.payload,
                      event.rawPayload,
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated": {
                    // omp's subagent `task` tool renders as the Agents
                    // surface (spawn CTA + panel), not a generic tool row.
                    const taskSubtasks =
                      ctx.taskToolSubtasks.get(event.toolCall.toolCallId) ??
                      parseOmpTaskToolCall(event.toolCall);
                    if (taskSubtasks) {
                      yield* emitTaskToolLifecycle(
                        ctx,
                        notificationTurnId,
                        event.toolCall,
                        taskSubtasks,
                      );
                      return;
                    }
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        toolCall: enrichOmpToolCallFiles(event.toolCall),
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                  case "ContentDelta": {
                    const scanned =
                      ctx.rateLimitScan?.turnId === notificationTurnId
                        ? ctx.rateLimitScan.head
                        : "";
                    if (scanned.length < OMP_RATE_LIMIT_SCAN_LIMIT) {
                      const head = `${scanned}${event.text}`.slice(0, OMP_RATE_LIMIT_SCAN_LIMIT);
                      ctx.rateLimitScan = { turnId: notificationTurnId, head };
                      const notice = parseOmpRateLimitNotice(head);
                      if (notice) {
                        const resetsAt =
                          notice.retryAfterMs === undefined
                            ? undefined
                            : DateTime.formatIso(
                                DateTime.addDuration(
                                  yield* DateTime.now,
                                  Duration.millis(notice.retryAfterMs),
                                ),
                              );
                        ctx.rateLimitedTurn = {
                          turnId: notificationTurnId,
                          errorMessage: formatOmpRateLimitTurnError(notice, resetsAt),
                          resetsAt,
                        };
                      }
                    }
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  }
                  case "ThoughtDelta":
                    if (
                      ctx.reasoningItemId !== undefined &&
                      event.itemId !== undefined &&
                      event.itemId !== ctx.reasoningItemId
                    ) {
                      yield* flushReasoningBuffer(ctx, notificationTurnId);
                    }
                    if (event.itemId !== undefined) {
                      ctx.reasoningItemId = event.itemId;
                    }
                    ctx.reasoningText += event.text;
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        streamKind: "reasoning_text",
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Oh My Pi runtime notification.", { cause }),
            ),
            // Fork into the session scope, not the calling fiber: Effect
            // interrupts a fiber's children when it completes, so a forkChild
            // consumer would die as soon as startSession returned.
            Effect.forkIn(ctx.scope),
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          // Silence watchdog: flags the session quiet when a running turn has
          // produced no inbound native frame for the threshold, and clears the
          // flag when frames resume. Transition-only — two events per stall
          // episode, nothing per tick.
          yield* Effect.gen(function* () {
            const liveCtx = sessions.get(input.threadId);
            if (!liveCtx || liveCtx.stopped) {
              return;
            }
            const snapshot = yield* liveCtx.acp.getActivitySnapshot;
            const nowMillis = yield* Clock.currentTimeMillis;
            const transition = resolveOmpQuietTransition({
              nowMillis,
              turnActive: liveCtx.activeTurnId !== undefined && liveCtx.promptsInFlight > 0,
              turnStartedAtMillis: liveCtx.turnStartedAtMillis,
              lastInboundFrameAtMillis: snapshot.lastInboundFrameAtMillis,
              openToolCallCount: snapshot.openToolCallCount,
              pendingApprovalCount: liveCtx.pendingApprovals.size,
              pendingUserInputCount: liveCtx.pendingUserInputs.size,
              quietAlreadyMarked: liveCtx.providerQuietMarked,
              thresholdMillis: OMP_PROVIDER_QUIET_THRESHOLD_MILLIS,
            });
            if (transition._tag === "mark" || transition._tag === "clear") {
              liveCtx.providerQuietMarked = transition._tag === "mark";
              liveCtx.providerQuietSinceMillis =
                transition._tag === "mark" ? transition.quietSinceMillis : undefined;
              yield* offerRuntimeEvent({
                type: "session.state.changed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: liveCtx.threadId,
                payload: {
                  state: "running",
                  providerQuietSince:
                    transition._tag === "mark"
                      ? DateTime.formatIso(DateTime.makeUnsafe(transition.quietSinceMillis))
                      : null,
                },
              });
            }
            // Give-up: the session has stayed quiet-marked past the much
            // larger give-up threshold, independent of this tick's mark/clear
            // transition — most ticks while stuck are steady-state "none".
            // Fails the turn automatically instead of leaving it "Working"
            // forever with nobody watching the quiet banner (review finding).
            if (
              !resolveOmpSilenceGiveUp({
                nowMillis,
                quietSinceMillis: liveCtx.providerQuietSinceMillis,
                thresholdMillis: OMP_PROVIDER_SILENCE_GIVE_UP_THRESHOLD_MILLIS,
              })
            ) {
              return;
            }
            const threadId = liveCtx.threadId;
            yield* withThreadLock(
              threadId,
              Effect.gen(function* () {
                const freshCtx = yield* requireSession(threadId);
                const activeTurnId = freshCtx.activeTurnId ?? freshCtx.session.activeTurnId;
                if (activeTurnId === undefined) {
                  return;
                }
                freshCtx.interruptedTurnIds.add(activeTurnId);
                freshCtx.providerQuietMarked = false;
                freshCtx.providerQuietSinceMillis = undefined;
                yield* Effect.ignore(
                  freshCtx.acp.cancel.pipe(
                    Effect.mapError((error) =>
                      mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
                    ),
                  ),
                );
                yield* settlePromptInFlight(threadId, activeTurnId, freshCtx.acpSessionId, {
                  errorMessage: `Oh My Pi stopped responding: no output for ${
                    OMP_PROVIDER_SILENCE_GIVE_UP_THRESHOLD_MILLIS / 60_000
                  } minutes. The turn was stopped automatically — you can try again.`,
                  settleAllPrompts: true,
                });
              }),
            );
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Oh My Pi silence watchdog tick failed.", { cause }),
            ),
            Effect.repeat(Schedule.spaced("15 seconds")),
            Effect.forkIn(ctx.scope),
          );

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Oh My Pi ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: OmpAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            // A sendTurn while a prompt is in flight is a steer: the agent
            // folds the new prompt into the ongoing work, so the active turn
            // id is reused instead of opening a new turn.
            const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
            const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
            // Count this prompt immediately so a superseded in-flight prompt
            // resolving from here on does not settle the turn; decremented on
            // preparation failure here, and after the prompt below otherwise.
            ctx.promptsInFlight += 1;
            // Every prompt (new turn or steer) resets the silence baseline;
            // also clears a stale quiet-mark from a turn that settled
            // without an intervening notification (e.g. a bare stopReason).
            ctx.turnStartedAtMillis = yield* Clock.currentTimeMillis;
            ctx.providerQuietMarked = false;
            ctx.providerQuietSinceMillis = undefined;
            // Bind the turn id before cooperative yields so interruptTurn can
            // settle this prompt even if stop arrives during preparation.
            ctx.activeTurnId = turnId;
            ctx.session = {
              ...ctx.session,
              status: steeringTurnId === undefined ? "connecting" : "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            };

            return yield* Effect.gen(function* () {
              const turnModelSelection =
                input.modelSelection?.instanceId === boundInstanceId
                  ? input.modelSelection
                  : undefined;
              const currentModelId = yield* applyRequestedSessionConfiguration({
                runtime: ctx.acp,
                interactionMode: input.interactionMode,
                currentModelId: ctx.currentModelId,
                modelSelection: turnModelSelection?.model
                  ? {
                      model: turnModelSelection.model,
                      ...(turnModelSelection.options !== undefined
                        ? { options: turnModelSelection.options }
                        : {}),
                    }
                  : undefined,
                mapError: ({ cause, method }) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
              });

              const text = input.input?.trim();
              const imagePromptParts = yield* Effect.forEach(
                input.attachments ?? [],
                (attachment) =>
                  Effect.gen(function* () {
                    const attachmentPath = resolveAttachmentPath({
                      attachmentsDir: serverConfig.attachmentsDir,
                      attachment,
                    });
                    if (!attachmentPath) {
                      return yield* new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "session/prompt",
                        detail: `Invalid attachment id '${attachment.id}'.`,
                      });
                    }
                    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderAdapterRequestError({
                            provider: PROVIDER,
                            method: "session/prompt",
                            detail: cause.message,
                            cause,
                          }),
                      ),
                    );
                    return {
                      type: "image",
                      data: Buffer.from(bytes).toString("base64"),
                      mimeType: attachment.mimeType,
                    } satisfies EffectAcpSchema.ContentBlock;
                  }),
              );
              const promptParts: Array<EffectAcpSchema.ContentBlock> = [
                ...(text ? [{ type: "text" as const, text }] : []),
                ...imagePromptParts,
              ];

              if (promptParts.length === 0) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Turn requires non-empty text or attachments.",
                });
              }

              ctx.currentModelId = currentModelId;
              const displayModel = currentModelId;
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }
              if (ctx.interruptedTurnIds.has(turnId)) {
                yield* settlePromptInFlight(input.threadId, turnId, ctx.acpSessionId, {
                  completedStopReason: "cancelled",
                  emitTurnCompletion: false,
                  settleAllPrompts: true,
                });
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Oh My Pi prompt was interrupted during preparation.",
                });
              }
              if (steeringTurnId === undefined) {
                ctx.lastPlanFingerprint = undefined;
                // A fresh turn must not inherit a stale thought segment from
                // an interrupted predecessor.
                ctx.reasoningItemId = undefined;
                ctx.reasoningText = "";
                // Task bookkeeping is per-turn: a fresh turn's task tool calls
                // get new ids, and stale entries would only leak.
                ctx.taskToolSubtasks.clear();
                ctx.taskProgressFingerprints.clear();
                ctx.completedTaskIds.clear();
              }
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
                ...(displayModel ? { model: displayModel } : {}),
              };

              if (steeringTurnId === undefined) {
                yield* offerRuntimeEvent({
                  type: "turn.started",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: displayModel ? { model: displayModel } : {},
                });
              }

              return {
                acp: ctx.acp,
                acpSessionId: ctx.acpSessionId,
                displayModel,
                promptParts,
                turnId,
              };
            }).pipe(
              Effect.tapCause(() =>
                Effect.gen(function* () {
                  const liveCtx = sessions.get(input.threadId);
                  if (!liveCtx) {
                    return;
                  }
                  yield* settlePromptInFlight(input.threadId, turnId, liveCtx.acpSessionId, {
                    errorMessage: "Oh My Pi prompt preparation failed.",
                    emitTurnCompletion: false,
                  });
                }),
              ),
            );
          }),
        );
        const promptSettled = yield* Ref.make(false);
        const promptRpcSucceeded = yield* Ref.make(false);
        const promptResultRef = yield* Ref.make<EffectAcpSchema.PromptResponse | undefined>(
          undefined,
        );

        const promptFailureMessageRef = yield* Ref.make<string | undefined>(undefined);

        return yield* Effect.gen(function* () {
          const result = yield* prepared.acp
            .prompt({
              prompt: prepared.promptParts,
            })
            .pipe(
              Effect.tap((promptResult) =>
                Effect.all([
                  Ref.set(promptRpcSucceeded, true),
                  Ref.set(promptResultRef, promptResult),
                ]),
              ),
              Effect.tapError((error) =>
                Ref.set(
                  promptFailureMessageRef,
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error).message,
                ).pipe(Effect.andThen(prepared.acp.drainEvents)),
              ),
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
              ),
            );

          return yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const ctx = yield* requireSession(input.threadId);
              if (ctx.acpSessionId !== prepared.acpSessionId) {
                yield* settlePromptInFlight(
                  input.threadId,
                  prepared.turnId,
                  prepared.acpSessionId,
                  {
                    errorMessage: "Oh My Pi session changed before the turn completed.",
                    settleAllPrompts: true,
                  },
                );
                yield* Ref.set(promptSettled, true);
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Oh My Pi session changed before the turn completed.",
                });
              }
              // Keep prompt settlement atomic with respect to Stop and steering.
              // interruptTurn marks its target before waiting for this lock, so
              // cancellation can still win while queued ACP events are drained.
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }
              yield* prepared.acp.drainEvents;
              if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              if (
                ctx.promptsInFlight <= 0 ||
                ctx.activeTurnId !== prepared.turnId ||
                ctx.session.activeTurnId !== prepared.turnId
              ) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              appendPromptResultToTurn(ctx, prepared.turnId, prepared.promptParts, result);
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: prepared.turnId,
                updatedAt: yield* nowIso,
                ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
              };
              const remainingPrompts = Math.max(0, ctx.promptsInFlight - 1);
              ctx.promptsInFlight = remainingPrompts;

              // Only the last remaining prompt settles the turn. A steer-
              // superseded prompt resolving while another is in flight or
              // pending must leave the merged turn running.
              if (
                remainingPrompts === 0 &&
                ctx.activeTurnId === prepared.turnId &&
                ctx.session.activeTurnId === prepared.turnId
              ) {
                if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                  yield* Ref.set(promptSettled, true);
                  return {
                    threadId: input.threadId,
                    turnId: prepared.turnId,
                    resumeCursor: ctx.session.resumeCursor,
                  };
                }
                const completedAt = yield* nowIso;
                const { activeTurnId: _completedTurnId, ...readySession } = ctx.session;
                ctx.activeTurnId = undefined;
                ctx.session = {
                  ...readySession,
                  status: "ready",
                  updatedAt: completedAt,
                  ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
                };
                const rateLimitFailure =
                  result.stopReason === "cancelled"
                    ? undefined
                    : takeRateLimitFailurePayload(ctx, prepared.turnId);
                yield* offerRuntimeEvent({
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  payload: rateLimitFailure ?? {
                    state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                    stopReason: result.stopReason,
                  },
                });
                ctx.interruptedTurnIds.delete(prepared.turnId);
                yield* Ref.set(promptSettled, true);
              } else if (remainingPrompts > 0) {
                yield* Ref.set(promptSettled, true);
              }

              return {
                threadId: input.threadId,
                turnId: prepared.turnId,
                resumeCursor: ctx.session.resumeCursor,
              };
            }),
          );
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (yield* Ref.get(promptSettled)) {
                return;
              }

              if (yield* Ref.get(promptRpcSucceeded)) {
                const promptResult = yield* Ref.get(promptResultRef);
                if (promptResult === undefined) {
                  return;
                }
                yield* withThreadLock(
                  input.threadId,
                  Effect.gen(function* () {
                    const ctx = yield* requireSession(input.threadId);
                    if (ctx.acpSessionId !== prepared.acpSessionId) {
                      yield* settlePromptInFlight(
                        input.threadId,
                        prepared.turnId,
                        prepared.acpSessionId,
                        {
                          errorMessage: "Oh My Pi session changed before the turn completed.",
                          settleAllPrompts: true,
                        },
                      );
                      return;
                    }
                    if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                      return;
                    }
                    if (
                      ctx.promptsInFlight <= 0 ||
                      ctx.activeTurnId !== prepared.turnId ||
                      ctx.session.activeTurnId !== prepared.turnId
                    ) {
                      return;
                    }
                    appendPromptResultToTurn(
                      ctx,
                      prepared.turnId,
                      prepared.promptParts,
                      promptResult,
                    );
                    yield* settlePromptInFlight(
                      input.threadId,
                      prepared.turnId,
                      prepared.acpSessionId,
                      {
                        completedStopReason: promptResult.stopReason,
                      },
                    );
                  }),
                );
                return;
              }

              const errorMessage = yield* Ref.get(promptFailureMessageRef);
              yield* withThreadLock(
                input.threadId,
                settlePromptInFlight(input.threadId, prepared.turnId, prepared.acpSessionId, {
                  errorMessage: errorMessage ?? "Oh My Pi prompt request failed.",
                }),
              );
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        );
      });

    const interruptTurn: OmpAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const observed = yield* Effect.sync(() => {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped) {
            return {
              _tag: "Proceed" as const,
              acpSessionId: undefined,
              interruptedTurnId: turnId,
            };
          }
          const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
          if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
            return { _tag: "Ignore" as const };
          }
          const interruptedTurnId = turnId ?? activeTurnId;
          if (interruptedTurnId !== undefined) {
            ctx.interruptedTurnIds.add(interruptedTurnId);
          }
          return {
            _tag: "Proceed" as const,
            acpSessionId: ctx.acpSessionId,
            interruptedTurnId,
          };
        });
        if (observed._tag === "Ignore") {
          return;
        }

        yield* withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            if (observed.acpSessionId !== undefined && ctx.acpSessionId !== observed.acpSessionId) {
              return;
            }
            const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
            if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
              return;
            }
            if (
              observed.interruptedTurnId !== undefined &&
              activeTurnId !== undefined &&
              activeTurnId !== observed.interruptedTurnId
            ) {
              return;
            }
            const interruptedTurnId =
              observed.interruptedTurnId ?? turnId ?? activeTurnId ?? ctx.session.activeTurnId;
            yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
            yield* Effect.ignore(
              ctx.acp.cancel.pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
                ),
              ),
            );
            if (interruptedTurnId) {
              ctx.interruptedTurnIds.add(interruptedTurnId);
              yield* settlePromptInFlight(threadId, interruptedTurnId, ctx.acpSessionId, {
                completedStopReason: "cancelled",
                settleAllPrompts: true,
              });
            } else if (
              ctx.promptsInFlight > 0 ||
              ctx.session.status === "running" ||
              ctx.session.status === "connecting"
            ) {
              const updatedAt = yield* nowIso;
              ctx.promptsInFlight = 0;
              ctx.activeTurnId = undefined;
              const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
              ctx.session = {
                ...readySession,
                status: "ready",
                updatedAt,
              };
            }
          }),
        );
      });

    const respondToRequest: OmpAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: OmpAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "elicitation/create",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.resolution, { _tag: "answered", answers });
      });

    const readThread: OmpAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: OmpAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Oh My Pi ACP sessions do not support provider-side rollback yet.",
        });
      });

    const stopSession: OmpAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: OmpAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: OmpAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: OmpAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies OmpAdapterShape;
  });
}
