import {
  CommandId,
  ProviderInstanceId,
  QueuedFollowUpId,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
// 1x1 transparent PNG.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

const TestLayer = WorkspacePaths.layer.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-follow-up-queue-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(TestLayer)("normalizeDispatchCommand: queued follow-ups", (it) => {
  it.effect("writes a queued follow-up's image uploads to disk before it becomes an event", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const command: ClientOrchestrationCommand = {
        type: "thread.follow-up.queue",
        commandId: CommandId.make("cmd-queue"),
        threadId: THREAD_ID,
        followUpId: QueuedFollowUpId.make("follow-up-1"),
        text: "look at this screenshot next",
        attachments: [
          {
            type: "image",
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: 68,
            dataUrl: PNG_DATA_URL,
          },
        ],
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: NOW,
      };

      const normalized = yield* normalizeDispatchCommand(command);
      if (normalized.type !== "thread.follow-up.queue") {
        throw new Error("Expected a thread.follow-up.queue command.");
      }

      // A queued follow-up may not be sent for minutes, so its bytes cannot ride
      // along in the payload — the canonical command carries only metadata.
      const attachment = normalized.attachments[0];
      expect(normalized.attachments).toHaveLength(1);
      expect(attachment).toMatchObject({ type: "image", name: "shot.png", mimeType: "image/png" });
      expect(attachment).not.toHaveProperty("dataUrl");
      if (attachment === undefined || attachment.type !== "image") {
        throw new Error("Expected a persisted image attachment.");
      }

      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      expect(attachmentPath).not.toBeNull();
      expect(yield* fileSystem.exists(attachmentPath ?? "")).toBe(true);
    }),
  );
});
