import type {
  OrchestrationActivityOutputDiff,
  OrchestrationEvent,
  OrchestrationGetActivityOutputResult,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown): void {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(
  value: unknown,
  target: string[],
  seen: Set<string>,
  depth: number,
): void {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
    // ACP reports file changes as `content: [{type: "diff", path, ...}]`. The
    // diff bodies stay off the wire, so this path list is all a collapsed row
    // has to name the files a tool touched.
    "content",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function projectCommandData(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const item = asRecord(data.item);
  if (!item) {
    return undefined;
  }

  const projectedItem: Record<string, unknown> = {};
  if ("command" in item) {
    projectedItem.command = item.command;
  }

  const aggregatedOutput = asTrimmedString(item.aggregatedOutput);
  if (aggregatedOutput) {
    const summary = summarizeToolTextOutput(aggregatedOutput);
    if (summary) {
      projectedItem.aggregatedOutput = summary;
    }
  }

  const input = asRecord(item.input);
  if (input && "command" in input) {
    projectedItem.input = { command: input.command };
  }

  const result = asRecord(item.result);
  if (result) {
    const projectedResult: Record<string, unknown> = {};
    if ("command" in result) {
      projectedResult.command = result.command;
    }
    const content = asTrimmedString(result.content);
    if (content) {
      const summary = summarizeToolTextOutput(content);
      if (summary) {
        projectedResult.content = summary;
      }
    }
    if (Object.keys(projectedResult).length > 0) {
      projectedItem.result = projectedResult;
    }
  }

  return Object.keys(projectedItem).length > 0 ? projectedItem : undefined;
}

function summarizeToolTextOutput(value: string): string | null {
  const lines: string[] = [];
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (line.length > 0) {
      lines.push(line);
    }
  }

  const firstLine = lines.find((line) => line !== "```");
  if (firstLine) {
    return firstLine.length <= 84 ? firstLine : `${firstLine.slice(0, 83).trimEnd()}…`;
  }
  if (lines.length > 1) {
    return `${lines.length.toLocaleString()} lines`;
  }
  return null;
}

/**
 * Cap for the output text served to an expanded row. Generous: this text is
 * fetched for ONE activity a user asked to see, never broadcast with a thread,
 * so the only thing it has to stay under is a single reasonable WS frame.
 */
const ACTIVITY_OUTPUT_TEXT_LIMIT = 200_000;

function capActivityOutputText(value: string): { text: string; truncated: boolean } {
  if (value.length <= ACTIVITY_OUTPUT_TEXT_LIMIT) {
    return { text: value, truncated: false };
  }
  const half = ACTIVITY_OUTPUT_TEXT_LIMIT / 2;
  const head = value.slice(0, half).trimEnd();
  const tail = value.slice(-half).trimStart();
  return { text: `${head}\n⋯ output truncated ⋯\n${tail}`, truncated: true };
}

function extractAcpContentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const texts: string[] = [];
  for (const entryValue of value) {
    const entry = asRecord(entryValue);
    const content = asRecord(entry?.content);
    if (entry?.type === "content" && content?.type === "text") {
      const text = asTrimmedString(content.text);
      if (text) {
        texts.push(text);
      }
    }
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/**
 * Full renderable text of a tool result, across the payload shapes adapters
 * emit: ACP `rawOutput` (string | {content|stdout|stderr}), ACP `content`
 * blocks, and Codex/Claude item shapes.
 */
function fullToolOutputText(data: Record<string, unknown>): string | undefined {
  const direct = asTrimmedString(data.rawOutput);
  if (direct) {
    return direct;
  }
  const rawOutput = asRecord(data.rawOutput);
  if (rawOutput) {
    const content = asTrimmedString(rawOutput.content);
    if (content) {
      return content;
    }
    const streams = [asTrimmedString(rawOutput.stdout), asTrimmedString(rawOutput.stderr)].filter(
      (value): value is string => value !== null,
    );
    if (streams.length > 0) {
      return streams.join("\n");
    }
  }
  const acpText = extractAcpContentText(data.content);
  if (acpText) {
    return acpText;
  }
  const item = asRecord(data.item);
  const aggregatedOutput = asTrimmedString(item?.aggregatedOutput);
  if (aggregatedOutput) {
    return aggregatedOutput;
  }
  return asTrimmedString(asRecord(item?.result)?.content) ?? undefined;
}

/** True when the full text carries more than its one-line summary. */
function fullTextAddsInformation(fullText: string): boolean {
  return fullText.includes("\n") || fullText.length > 84;
}

const DIFF_FILE_LIMIT = 6;
const DIFF_TEXT_LIMIT = 20_000;

/**
 * Reads ACP `{type: "diff", path, oldText, newText}` content blocks so an
 * expanded row can render inline per-file diffs. Oversized sides are dropped
 * rather than truncated — a clipped diff lies.
 */
function extractDiffContent(value: unknown): Array<OrchestrationActivityOutputDiff> {
  if (!Array.isArray(value)) {
    return [];
  }
  const diffs: Array<OrchestrationActivityOutputDiff> = [];
  for (const entryValue of value) {
    const entry = asRecord(entryValue);
    if (entry?.type !== "diff") {
      continue;
    }
    const path = asTrimmedString(entry.path);
    if (!path || typeof entry.newText !== "string") {
      continue;
    }
    const oldText = typeof entry.oldText === "string" ? entry.oldText : null;
    if (entry.newText.length > DIFF_TEXT_LIMIT || (oldText?.length ?? 0) > DIFF_TEXT_LIMIT) {
      continue;
    }
    diffs.push({ path, oldText, newText: entry.newText });
    if (diffs.length >= DIFF_FILE_LIMIT) {
      break;
    }
  }
  return diffs;
}

const TOOL_INFO_ARG_LIMIT = 10;
const TOOL_INFO_STRING_LIMIT = 160;
const TOOL_INFO_CODE_LIMIT = 2_000;
/** Arg keys whose values are bulky payloads already surfaced elsewhere (command line, output, diffs). */
const TOOL_INFO_SKIPPED_ARG_KEYS = new Set([
  "code",
  "content",
  "command",
  "cmd",
  "input",
  "text",
  "task",
  "tasks",
  "context",
  "prompt",
  "i",
  "action",
  "op",
]);

function truncateToolInfoString(value: string): string {
  return value.length > TOOL_INFO_STRING_LIMIT
    ? `${value.slice(0, TOOL_INFO_STRING_LIMIT - 1).trimEnd()}…`
    : value;
}

/**
 * Compact, bounded tool identity derived from `rawInput` for the expanded
 * work-log row: device/tool name (omp mounts lsp/debug/browser/ast_edit as
 * `xd://<name>` device writes), the action verb, scalar args, and inline
 * code (eval). rawInput itself never ships — this is its renderable shadow.
 */
function projectToolInfo(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const rawInput = asRecord(data.rawInput);
  if (!rawInput) {
    return undefined;
  }

  let name: string | undefined;
  let argsSource = rawInput;
  const path = asTrimmedString(rawInput.path);
  const deviceMatch = path ? /^xd:\/\/([a-z0-9_-]+)/iu.exec(path) : null;
  if (deviceMatch?.[1]) {
    name = deviceMatch[1].toLowerCase();
    const content = asTrimmedString(rawInput.content);
    if (content) {
      try {
        const parsed: unknown = JSON.parse(content);
        const parsedRecord = asRecord(parsed);
        if (parsedRecord) {
          argsSource = parsedRecord;
        }
      } catch {
        // Non-JSON device payloads keep the outer args.
      }
    }
  }

  const action = asTrimmedString(argsSource.action) ?? asTrimmedString(argsSource.op) ?? undefined;

  const args: Record<string, string | number | boolean> = {};
  let argCount = 0;
  for (const [key, value] of Object.entries(argsSource)) {
    if (TOOL_INFO_SKIPPED_ARG_KEYS.has(key)) {
      continue;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        continue;
      }
      args[key] = truncateToolInfoString(trimmed);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      args[key] = value;
    } else if (typeof value === "boolean") {
      args[key] = value;
    } else {
      continue;
    }
    argCount += 1;
    if (argCount >= TOOL_INFO_ARG_LIMIT) {
      break;
    }
  }

  const codeText = typeof argsSource.code === "string" ? argsSource.code.trim() : "";
  const code =
    codeText.length > 0
      ? {
          language:
            asTrimmedString(argsSource.language) ?? asTrimmedString(argsSource.lang) ?? "text",
          text:
            codeText.length > TOOL_INFO_CODE_LIMIT
              ? `${codeText.slice(0, TOOL_INFO_CODE_LIMIT).trimEnd()}\n⋯`
              : codeText,
        }
      : undefined;

  if (!name && !action && argCount === 0 && !code) {
    return undefined;
  }
  return {
    ...(name ? { name } : {}),
    ...(action ? { action } : {}),
    ...(argCount > 0 ? { args } : {}),
    ...(code ? { code } : {}),
  };
}

/**
 * Fields of an MCP tool-call item both clients render in the expanded
 * work-log row. Everything else — notably `result`, which carries the full
 * tool output and dominates wire size on MCP-heavy threads — is summarized
 * or dropped. Full payloads remain in persistence.
 */
const MCP_ITEM_KEPT_FIELDS = [
  "type",
  "id",
  "tool",
  "server",
  "status",
  "arguments",
  "appContext",
  "error",
  "durationMs",
] as const;

/**
 * Pulls renderable text out of an MCP tool result: either a Codex-style
 * `{content: [{type: "text", text}, ...]}` record or a raw Claude
 * `tool_result` block whose `content` is a string or block array.
 */
function extractMcpResultText(result: unknown): string | null {
  const record = asRecord(result);
  if (!record) {
    return typeof result === "string" ? result : null;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (Array.isArray(record.content)) {
    const texts: string[] = [];
    for (const entry of record.content) {
      const text = asRecord(entry)?.text;
      if (typeof text === "string" && text.trim().length > 0) {
        texts.push(text);
      }
    }
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }
  return null;
}

function summarizeMcpResult(result: unknown): Record<string, unknown> | undefined {
  if (result === undefined || result === null) {
    return undefined;
  }
  const text = extractMcpResultText(result);
  const summary = text ? summarizeToolTextOutput(text) : null;
  return summary ? { content: summary } : undefined;
}

/**
 * MCP tool calls carry full tool results (`data.item.result` on Codex,
 * `data.result` on Claude/OpenCode) that used to bypass slimming entirely to
 * keep the expanded-row UI working. Keep the fields the UI actually renders
 * and summarize the result like regular tool output; the full result is served
 * by `extractActivityOutput` when a row is expanded.
 */
function projectMcpToolCallData(data: Record<string, unknown>): Record<string, unknown> {
  const projectedData: Record<string, unknown> = {};

  const item = asRecord(data.item);
  if (item) {
    const projectedItem: Record<string, unknown> = {};
    for (const key of MCP_ITEM_KEPT_FIELDS) {
      if (key in item) {
        projectedItem[key] = item[key];
      }
    }
    const result = summarizeMcpResult(item.result);
    if (result) {
      projectedItem.result = result;
    }
    projectedData.item = projectedItem;
  }

  if ("toolName" in data) {
    projectedData.toolName = data.toolName;
  }
  if ("input" in data) {
    projectedData.input = data.input;
  }
  if (!item) {
    const result = summarizeMcpResult(data.result);
    if (result) {
      projectedData.result = result;
    }
  }

  if ("toolCallId" in data) {
    projectedData.toolCallId = data.toolCallId;
  }
  if ("kind" in data) {
    projectedData.kind = data.kind;
  }

  const changedFiles: string[] = [];
  collectChangedFiles(data, changedFiles, new Set<string>(), 0);
  if (changedFiles.length > 0) {
    projectedData.files = changedFiles.map((path) => ({ path }));
  }

  return projectedData;
}

function projectRawOutput(value: unknown): Record<string, unknown> | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    const summary = summarizeToolTextOutput(direct);
    return summary ? { content: summary } : undefined;
  }

  const rawOutput = asRecord(value);
  if (!rawOutput) {
    return undefined;
  }

  if (typeof rawOutput.totalFiles === "number" && Number.isFinite(rawOutput.totalFiles)) {
    return {
      totalFiles: rawOutput.totalFiles,
      ...(rawOutput.truncated === true ? { truncated: true } : {}),
    };
  }

  const content = asTrimmedString(rawOutput.content);
  if (content) {
    const summary = summarizeToolTextOutput(content);
    return summary ? { content: summary } : undefined;
  }

  const stdout = asTrimmedString(rawOutput.stdout);
  if (stdout) {
    const summary = summarizeToolTextOutput(stdout);
    return summary ? { content: summary } : undefined;
  }

  const stderr = asTrimmedString(rawOutput.stderr);
  if (stderr) {
    const summary = summarizeToolTextOutput(stderr);
    return summary ? { content: summary } : undefined;
  }

  return undefined;
}

function projectAcpContent(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const text = value
    .map((entryValue) => {
      const entry = asRecord(entryValue);
      const content = asRecord(entry?.content);
      return entry?.type === "content" && content?.type === "text"
        ? asTrimmedString(content.text)
        : null;
    })
    .filter((entry): entry is string => entry !== null)
    .join("\n");
  const summary = summarizeToolTextOutput(text);
  return summary ? { content: summary } : undefined;
}

/**
 * Removes activity payload fields that no current client reads while retaining
 * the full payload in persistence and the event store.
 *
 * Every row leaves here summary-sized. Tool output and inline diffs are NOT
 * broadcast: a client fetches them for the one row a user expands, through
 * `extractActivityOutput`, so a thread's wire cost does not grow with the bytes
 * its tools happened to print.
 */
export function projectActivityPayload(
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity {
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  if (!payload || !data) {
    return activity;
  }

  if (payload.itemType === "mcp_tool_call") {
    return {
      ...activity,
      payload: {
        ...payload,
        data: projectMcpToolCallData(data),
      },
    };
  }

  const projectedData: Record<string, unknown> = {};
  const item = projectCommandData(data);
  if (item) {
    projectedData.item = item;
  }
  if ("command" in data) {
    projectedData.command = data.command;
  }

  const changedFiles: string[] = [];
  collectChangedFiles(data, changedFiles, new Set<string>(), 0);
  if (changedFiles.length > 0) {
    // Both clients discover file names by walking objects with path-like keys.
    projectedData.files = changedFiles.map((path) => ({ path }));
  }

  if ("toolCallId" in data) {
    projectedData.toolCallId = data.toolCallId;
  }
  if ("kind" in data) {
    projectedData.kind = data.kind;
  }

  const toolInfo = projectToolInfo(data);
  if (toolInfo) {
    projectedData.toolInfo = toolInfo;
  }

  const rawOutput = projectRawOutput(data.rawOutput) ?? projectAcpContent(data.content);
  if (rawOutput) {
    projectedData.rawOutput = rawOutput;
  }

  return {
    ...activity,
    payload: {
      ...payload,
      data: projectedData,
    },
  };
}

/**
 * Expanded-row body for ONE persisted activity payload: the output text the
 * tool printed plus any inline diffs it reported.
 *
 * Reads the same adapter shapes `projectActivityPayload` summarizes, so the
 * fetched body and the collapsed summary always describe the same output. Text
 * that adds nothing to that summary (a single short line) comes back as null —
 * the row already shows it.
 */
export function extractActivityOutput(payload: unknown): OrchestrationGetActivityOutputResult {
  const record = asRecord(payload);
  const data = asRecord(record?.data);
  if (!data) {
    return { text: null, truncated: false, diffs: [] };
  }

  const item = asRecord(data.item);
  const rawText =
    record?.itemType === "mcp_tool_call"
      ? extractMcpResultText(item ? item.result : data.result)
      : fullToolOutputText(data);
  const trimmed = rawText?.trim();
  const capped =
    trimmed && fullTextAddsInformation(trimmed) ? capActivityOutputText(trimmed) : undefined;

  return {
    text: capped?.text ?? null,
    truncated: capped?.truncated ?? false,
    diffs: extractDiffContent(data.content),
  };
}

/**
 * Matches the validity rule in the web client's
 * `deriveLatestContextWindowSnapshot`: rows without a finite, non-negative
 * `usedTokens` are skipped during its backward walk, so they must not shadow
 * an earlier resolvable row here.
 */
function isResolvableContextWindowActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "context-window.updated") {
    return false;
  }
  const payload = asRecord(activity.payload);
  const usedTokens = payload?.usedTokens;
  return typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0;
}

/**
 * Drops all but the last resolvable context-window activity per turn from a
 * snapshot. Clients only ever read the latest usage value (walking the array
 * backwards), so shipping the full history — often thousands of rows on long
 * threads — buys nothing. Retention is per turn rather than per thread because
 * a live `thread.reverted` makes the client discard whole turns; keeping each
 * turn's latest row means the meter can still resolve a value from the turns
 * that survive. Malformed rows pass through untouched rather than shadowing a
 * valid earlier row. Live `thread.activity-appended` events are untouched:
 * newer updates still stream through and supersede the retained rows on the
 * client.
 */
function dropStaleContextWindowActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const latestIndexByTurn = new Map<string | null, number>();
  for (let index = 0; index < activities.length; index += 1) {
    if (isResolvableContextWindowActivity(activities[index]!)) {
      latestIndexByTurn.set(activities[index]!.turnId, index);
    }
  }
  if (latestIndexByTurn.size === 0) {
    return activities;
  }
  return activities.filter(
    (activity, index) =>
      !isResolvableContextWindowActivity(activity) ||
      latestIndexByTurn.get(activity.turnId) === index,
  );
}

/**
 * Identity both clients use to fold a tool lifecycle row into the call it
 * belongs to (`deriveToolLifecycleCollapseKey` in web's `session-logic` and
 * mobile's `threadActivity`): an explicit `data.toolCallId` when the adapter
 * emits one, otherwise the itemType/title/detail triple. Returns null for rows
 * with no identity at all — those never collapse on the client either, so they
 * must not be dropped here.
 */
function toolLifecycleIdentity(activity: OrchestrationThreadActivity): string | null {
  const payload = asRecord(activity.payload);
  if (!payload) {
    return null;
  }

  const toolCallId = asTrimmedString(asRecord(payload.data)?.toolCallId);
  if (toolCallId) {
    return `id:${toolCallId}`;
  }

  const itemType = asTrimmedString(payload.itemType) ?? "";
  // Mirrors the clients' `normalizeCompactToolLabel`: a completion's title may
  // gain a trailing "complete"/"completed" the in-flight updates lack.
  const label = (asTrimmedString(payload.title) ?? activity.summary)
    .replace(/\s+(?:complete|completed)\s*$/iu, "")
    .trim();
  const detail = asTrimmedString(payload.detail) ?? "";
  if (itemType.length === 0 && label.length === 0 && detail.length === 0) {
    return null;
  }
  return [itemType, label, detail].join("");
}

/**
 * Drops `tool.updated` rows a `tool.completed` row already supersedes. An
 * update is the in-flight snapshot of a call; once the call completes, the
 * completion carries the final state and the clients fold every matching
 * update into it, so shipping the updates buys nothing — 47k such rows exist
 * in one real database, and a single thread carries 2,291 of them totalling
 * ~1MB post-slimming.
 *
 * Matching is per turn for the same reason `dropStaleContextWindowActivities`
 * retains per turn: a live `thread.reverted` makes the client discard whole
 * turns, so a completion in a different turn could vanish and leave the
 * dropped update unrepresented. The completion must also come *after* the
 * update within the turn — a later update belongs to a subsequent call that
 * reuses the same identity and is still in flight. Rows without a lifecycle
 * identity pass through, matching the clients, which never collapse them.
 * Live `thread.activity-appended` events are untouched: updates still stream
 * in real time and the completion supersedes them on the client as before.
 *
 * Deliberate divergence from client collapse: clients fold only *adjacent*
 * lifecycle rows, so a superseded update separated from its completion by an
 * interleaved parallel call renders as its own row today, and this drop
 * removes it. Measured against a real database, that affects 1.5% of dropped
 * rows (553 of 36,581), all pure in-flight state whose final result the
 * retained completion still shows. Dropping them is intentional; matching
 * adjacency server-side would forfeit most of the win for parallel-heavy
 * threads, which are exactly the heavy ones. Superseding completions always
 * carry a payload superset of their updates (verified across all 49,515
 * update rows: zero dropped rows held a client-merged field — detail, title,
 * command, item, kind, files — their completion lacked), so no expanded-row
 * content is lost.
 */
function dropSupersededToolUpdatedActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const completionIndicesByKey = new Map<string, number[]>();
  for (let index = 0; index < activities.length; index += 1) {
    const activity = activities[index]!;
    if (activity.kind !== "tool.completed") {
      continue;
    }
    const identity = toolLifecycleIdentity(activity);
    if (!identity) {
      continue;
    }
    const key = `${activity.turnId ?? ""} ${identity}`;
    const indices = completionIndicesByKey.get(key);
    if (indices) {
      indices.push(index);
    } else {
      completionIndicesByKey.set(key, [index]);
    }
  }
  if (completionIndicesByKey.size === 0) {
    return activities;
  }

  return activities.filter((activity, index) => {
    if (activity.kind !== "tool.updated") {
      return true;
    }
    const identity = toolLifecycleIdentity(activity);
    if (!identity) {
      return true;
    }
    const indices = completionIndicesByKey.get(`${activity.turnId ?? ""} ${identity}`);
    return !indices?.some((completionIndex) => completionIndex > index);
  });
}

export function projectThreadDetailSnapshot(
  snapshot: OrchestrationThreadDetailSnapshot,
): OrchestrationThreadDetailSnapshot {
  return {
    ...snapshot,
    thread: {
      ...snapshot.thread,
      activities: dropSupersededToolUpdatedActivities(
        dropStaleContextWindowActivities(snapshot.thread.activities),
      ).map(projectActivityPayload),
    },
  };
}

export function projectActivityEvent(event: OrchestrationEvent): OrchestrationEvent {
  if (event.type !== "thread.activity-appended") {
    return event;
  }
  return {
    ...event,
    payload: {
      ...event.payload,
      activity: projectActivityPayload(event.payload.activity),
    },
  };
}
