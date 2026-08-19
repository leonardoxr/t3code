import { describe, expect, it } from "vite-plus/test";

import { deriveToolActivityPresentation } from "./toolActivity.ts";

describe("toolActivity", () => {
  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "bun run lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "bun run lint",
    });
  });

  it("uses structured file paths for read-file tools when available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/tmp/app.ts",
    });
  });

  it("drops duplicated generic read-file detail when no path is available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          rawInput: {},
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
    });
  });

  it("surfaces an informative title over the flattened command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "[js] compute checksum\nconst hash = sha256(data);",
        data: {
          kind: "execute",
          rawInput: { command: "bun run checksum.ts" },
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "[js] compute checksum",
      detail: "bun run checksum.ts",
    });
  });

  it("keeps the flattened label when the title merely repeats the command", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "$ bun run lint",
        data: {
          kind: "execute",
          rawInput: { command: "bun run lint" },
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "bun run lint",
    });
  });

  it("surfaces intent titles on read and file-change tools", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Reading wire projection",
        data: {
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Reading wire projection",
      }),
    ).toEqual({
      summary: "Reading wire projection",
      detail: "/tmp/app.ts",
    });
    expect(
      deriveToolActivityPresentation({
        itemType: "file_change",
        title: "Fixing null handling",
        data: {
          kind: "edit",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Fixing null handling",
      }),
    ).toEqual({
      summary: "Fixing null handling",
      detail: "/tmp/app.ts",
    });
  });
});
