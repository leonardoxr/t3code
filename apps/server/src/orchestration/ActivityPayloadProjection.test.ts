import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { extractActivityOutput, projectActivityPayload } from "./ActivityPayloadProjection.ts";

function activity(
  payload: Record<string, unknown>,
  kind: "tool.completed" | "tool.updated" = "tool.completed",
): OrchestrationThreadActivity {
  return {
    id: "activity-1",
    tone: "tool",
    kind,
    summary: "Tool",
    payload,
    turnId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}

function projectedData(projected: OrchestrationThreadActivity): Record<string, unknown> {
  // Payload is `unknown` on the wire; tests own the fixture shape.
  const payload = projected.payload as Record<string, unknown>;
  return payload.data as Record<string, unknown>;
}

/**
 * Wire-survival regression: the slimming pass rewrites payload.data but must
 * never strip the top-level per-agent fields the subagent fold depends on.
 * If slimming ever moves to an allowlist over the whole payload, these
 * assertions are the tripwire.
 */
describe("projectActivityPayload agent-field survival", () => {
  it("preserves tool attribution (agentId/parentToolUseId) through data slimming", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        agentId: "task-123",
        parentToolUseId: "toolu_abc",
        data: {
          toolName: "Bash",
          input: { command: "ls" },
          command: "ls",
          rawOutput: { content: "x".repeat(10) },
          somethingClientNeverReads: { big: "blob" },
        },
      }),
    );
    const payload = projected.payload as Record<string, unknown>;
    expect(payload.agentId).toBe("task-123");
    expect(payload.parentToolUseId).toBe("toolu_abc");
    // Slimming itself still applies to data.
    const data = payload.data as Record<string, unknown>;
    expect(data.somethingClientNeverReads).toBeUndefined();
  });

  it("keeps a bounded Codex command output summary and nothing else", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          item: {
            command: "/bin/zsh -lc 'printf hello'",
            aggregatedOutput: `hello from codex\n${"x".repeat(5000)}`,
          },
        },
      }),
    );
    const data = projectedData(projected);
    expect(data.item).toEqual({
      command: "/bin/zsh -lc 'printf hello'",
      aggregatedOutput: "hello from codex",
    });
    // The 5000-char body stays in persistence for the expanded row to fetch.
    expect(JSON.stringify(projected.payload)).not.toContain("xxxx");
    expect(JSON.stringify(projected.payload).length).toBeLessThan(300);
  });

  it("keeps in-flight tool.updated rows slim", () => {
    const projected = projectActivityPayload(
      activity(
        {
          itemType: "command_execution",
          data: {
            item: {
              command: "/bin/zsh -lc 'printf hello'",
              aggregatedOutput: `hello from codex\n${"x".repeat(5000)}`,
            },
            content: [{ type: "diff", path: "/tmp/a.ts", oldText: "old", newText: "new" }],
          },
        },
        "tool.updated",
      ),
    );
    const data = projectedData(projected);
    expect(data.rawOutput).toBeUndefined();
    expect(data.diffs).toBeUndefined();
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("leaves ACP diff content blocks off the wire on completed tools", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "file_change",
        data: {
          content: [
            { type: "diff", path: "/tmp/a.ts", oldText: "const a = 1;", newText: "const a = 2;" },
            { type: "content", content: { type: "text", text: "wrote 2 files" } },
          ],
        },
      }),
    );
    const data = projectedData(projected);
    expect(data.diffs).toBeUndefined();
    // The row still knows which files changed, so it still offers to expand.
    expect(data.files).toEqual([{ path: "/tmp/a.ts" }]);
  });

  it("derives compact toolInfo from xd device writes and eval args", () => {
    const lsp = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          rawInput: {
            path: "xd://lsp",
            content: JSON.stringify({
              action: "definition",
              file: "src/foo.ts",
              line: 42,
              symbol: "deriveThing",
            }),
          },
        },
      }),
    );
    const lspData = projectedData(lsp);
    expect(lspData.toolInfo).toEqual({
      name: "lsp",
      action: "definition",
      args: { file: "src/foo.ts", line: 42, symbol: "deriveThing" },
    });

    const evalCall = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          rawInput: {
            language: "py",
            title: "compute checksum",
            code: "print(sha256(data))",
          },
        },
      }),
    );
    const evalData = projectedData(evalCall);
    expect(evalData.toolInfo).toEqual({
      args: { language: "py", title: "compute checksum" },
      code: { language: "py", text: "print(sha256(data))" },
    });
  });

  it("keeps bounded Claude and ACP command output summaries", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          rawOutput: { stdout: `hello from claude\n${"y".repeat(5000)}` },
        },
      }),
    );
    const acp = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          content: [
            {
              type: "content",
              content: { type: "text", text: `hello from acp\n${"z".repeat(5000)}` },
            },
          ],
        },
      }),
    );

    const claudeRawOutput = projectedData(claude).rawOutput as Record<string, unknown>;
    const acpRawOutput = projectedData(acp).rawOutput as Record<string, unknown>;
    expect(claudeRawOutput).toEqual({ content: "hello from claude" });
    expect(acpRawOutput).toEqual({ content: "hello from acp" });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(300);
    expect(JSON.stringify(acp.payload).length).toBeLessThan(300);
  });

  it("slims Codex-shaped mcp_tool_call items to rendered fields plus a result summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            id: "item-1",
            tool: "fetch_pr",
            server: "github",
            status: "completed",
            arguments: { pr: 42 },
            durationMs: 1200,
            result: {
              content: [{ type: "text", text: `PR body line one\n${"x".repeat(5000)}` }],
              structuredContent: { huge: "y".repeat(5000) },
            },
            _meta: { internal: true },
          },
        },
      }),
    );
    const data = projectedData(projected);
    const item = data.item as Record<string, unknown>;
    expect(item.tool).toBe("fetch_pr");
    expect(item.server).toBe("github");
    expect(item.arguments).toEqual({ pr: 42 });
    expect(item._meta).toBeUndefined();
    expect(item.result).toEqual({ content: "PR body line one" });
    expect(data.rawOutput).toBeUndefined();
    expect(JSON.stringify(projected.payload).length).toBeLessThan(400);
  });

  it("slims Claude-shaped mcp_tool_call data (toolName/input/result block)", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__github__fetch_pr",
          input: { pr: 42 },
          result: {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: `first line of output\n${"z".repeat(5000)}` }],
          },
        },
      }),
    );
    const data = projectedData(projected);
    expect(data.toolName).toBe("mcp__github__fetch_pr");
    expect(data.input).toEqual({ pr: 42 });
    expect(data.result).toEqual({ content: "first line of output" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(400);
  });

  it("passes task lifecycle payloads (no data field) through untouched", () => {
    const source = activity({
      taskId: "task-9",
      title: "Audit auth",
      role: "explorer",
      model: "opus",
      effort: "high",
      workflowName: "audit-flow",
      phases: [{ index: 0, title: "Audit" }],
      typedUsage: { totalTokens: 1200 },
      runHandles: { runId: "run-1", scriptPath: "/tmp/wf.js" },
      timelineBypass: true,
    });
    const projected = projectActivityPayload(source);
    expect(projected.payload).toEqual(source.payload);
  });
});

describe("extractActivityOutput", () => {
  it("returns the uncapped Codex output the wire payload summarized away", () => {
    const output = extractActivityOutput({
      itemType: "command_execution",
      data: {
        item: {
          command: "/bin/zsh -lc 'printf hello'",
          aggregatedOutput: `hello from codex\n${"x".repeat(5000)}`,
        },
      },
    });
    expect(output.text).toContain("hello from codex");
    expect(output.text).toContain("x".repeat(5000));
    expect(output.truncated).toBe(false);
    expect(output.diffs).toEqual([]);
  });

  it("reads Claude, ACP, and MCP result shapes", () => {
    expect(
      extractActivityOutput({
        itemType: "command_execution",
        data: { rawOutput: { stdout: "hello from claude\nsecond line" } },
      }).text,
    ).toBe("hello from claude\nsecond line");
    expect(
      extractActivityOutput({
        itemType: "command_execution",
        data: {
          content: [{ type: "content", content: { type: "text", text: "hello from acp\nmore" } }],
        },
      }).text,
    ).toBe("hello from acp\nmore");
    expect(
      extractActivityOutput({
        itemType: "mcp_tool_call",
        data: { item: { result: { content: [{ type: "text", text: "PR body\nline two" }] } } },
      }).text,
    ).toBe("PR body\nline two");
  });

  it("returns diffs a completed file-change tool reported, dropping oversized sides", () => {
    const output = extractActivityOutput({
      itemType: "file_change",
      data: {
        content: [
          { type: "diff", path: "/tmp/a.ts", oldText: "const a = 1;", newText: "const a = 2;" },
          { type: "diff", path: "/tmp/new.ts", oldText: null, newText: "export {};" },
          { type: "diff", path: "/tmp/huge.ts", oldText: "x".repeat(30_000), newText: "y" },
        ],
      },
    });
    expect(output.diffs).toEqual([
      { path: "/tmp/a.ts", oldText: "const a = 1;", newText: "const a = 2;" },
      { path: "/tmp/new.ts", oldText: null, newText: "export {};" },
    ]);
  });

  it("caps a runaway body and says so", () => {
    const output = extractActivityOutput({
      itemType: "command_execution",
      data: { rawOutput: { stdout: `first line\n${"y".repeat(400_000)}` } },
    });
    expect(output.truncated).toBe(true);
    expect(output.text).toContain("⋯ output truncated ⋯");
    expect(output.text!.length).toBeLessThan(200_100);
  });

  it("says nothing when the output adds nothing to the row's summary", () => {
    expect(
      extractActivityOutput({
        itemType: "command_execution",
        data: { command: "printf hello", rawOutput: { stdout: "hello" } },
      }),
    ).toEqual({ text: null, truncated: false, diffs: [] });
    expect(extractActivityOutput({ taskId: "task-9" })).toEqual({
      text: null,
      truncated: false,
      diffs: [],
    });
  });
});
