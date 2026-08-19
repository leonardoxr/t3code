import type { OrchestrationQueuedFollowUp } from "@t3tools/contracts";
import { QueuedFollowUpId } from "@t3tools/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerQueuedFollowUps } from "./ComposerQueuedFollowUps";

const NOW = "2026-04-01T00:00:00.000Z";

function makeFollowUp(
  overrides?: Partial<OrchestrationQueuedFollowUp>,
): OrchestrationQueuedFollowUp {
  return {
    id: QueuedFollowUpId.make("follow-up-1"),
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

function render(input: {
  readonly followUps: ReadonlyArray<OrchestrationQueuedFollowUp>;
  readonly isRunning?: boolean;
  readonly sendNowStopsRun?: boolean;
}) {
  return renderToStaticMarkup(
    createElement(ComposerQueuedFollowUps, {
      followUps: input.followUps,
      isRunning: input.isRunning ?? false,
      sendNowStopsRun: input.sendNowStopsRun ?? false,
      onEdit: () => {},
      onRemove: () => {},
      onReorder: () => {},
      onPromote: () => {},
    }),
  );
}

describe("ComposerQueuedFollowUps", () => {
  it("renders nothing when the queue is empty", () => {
    expect(render({ followUps: [] })).toBe("");
  });

  it("shows the queued count and each follow-up's first line", () => {
    const markup = render({
      followUps: [
        makeFollowUp({ text: "run the tests\nsecond line", orderKey: "b" }),
        makeFollowUp({
          id: QueuedFollowUpId.make("follow-up-2"),
          text: "then push",
          orderKey: "m",
        }),
      ],
    });
    expect(markup).toContain("2 queued");
    expect(markup).toContain("run the tests");
    expect(markup).not.toContain("second line");
    expect(markup.indexOf("run the tests")).toBeLessThan(markup.indexOf("then push"));
  });

  it("marks a stopped queue as paused and explains how to resume it", () => {
    const markup = render({ followUps: [makeFollowUp({ status: "paused" })] });
    expect(markup).toContain("Paused");
    expect(markup).toContain("send one to resume the queue");
  });

  it("surfaces a failed follow-up's error and says the queue is blocked", () => {
    const markup = render({
      followUps: [makeFollowUp({ status: "failed", lastError: "thread was archived" })],
    });
    expect(markup).toContain("Failed");
    expect(markup).toContain("thread was archived");
    expect(markup).toContain("Blocked until you retry or remove");
  });

  it("labels the promote action as steering while a turn is running", () => {
    expect(render({ followUps: [makeFollowUp()], isRunning: true })).toContain(
      "Steer with this follow-up now",
    );
    expect(render({ followUps: [makeFollowUp()], isRunning: false })).toContain(
      'aria-label="Send now"',
    );
  });

  it("says sending now stops the run when the provider cannot steer", () => {
    // The button used to promise a steer and then silently wait for the turn
    // to end; on omp the server stops the run to deliver it now.
    expect(
      render({ followUps: [makeFollowUp()], isRunning: true, sendNowStopsRun: true }),
    ).toContain("Stop the run and send this now");
  });

  it("offers edit and remove actions per follow-up", () => {
    const markup = render({ followUps: [makeFollowUp()] });
    expect(markup).toContain('aria-label="Edit queued follow-up"');
    expect(markup).toContain('aria-label="Remove queued follow-up"');
  });
});
