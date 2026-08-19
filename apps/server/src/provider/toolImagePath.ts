import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";

/**
 * Keys under which the providers' file-reading tools carry their target path:
 * Claude's `Read` uses `file_path`, OpenCode's `read` uses `filePath`, ACP
 * agents (Cursor, Grok) put it under `path` in `rawInput`.
 */
const TOOL_INPUT_PATH_KEYS = ["file_path", "filePath", "path"] as const;

/**
 * The path of the image a tool call looked at, if it looked at one. Adapters
 * put this on the item payload so clients can render the image inline from a
 * signed asset URL instead of the provider's base64 blob.
 *
 * The extension test is the same predicate the asset endpoint signs against,
 * so a path this accepts is a path the client can actually fetch. Paths are
 * passed through verbatim — the asset endpoint resolves relative ones against
 * the thread's workspace root and rejects anything that escapes it.
 */
export function imagePathFromToolInput(input: unknown): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of TOOL_INPUT_PATH_KEYS) {
    const value = record[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0 && isWorkspaceImagePreviewPath(trimmed)) {
      return trimmed;
    }
  }
  return undefined;
}
