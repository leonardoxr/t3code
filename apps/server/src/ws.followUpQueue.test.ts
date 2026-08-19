import {
  CommandId,
  EventId,
  OrchestrationEventType,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isThreadDetailEvent } from "./ws.ts";

const THREAD_ID = ThreadId.make("thread-1");

function makeEvent(type: OrchestrationEvent["type"]): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.make("evt-1"),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: "2026-01-01T00:00:00.000Z",
    commandId: CommandId.make("cmd-1"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload: { threadId: THREAD_ID } as never,
  } as OrchestrationEvent;
}

describe("isThreadDetailEvent", () => {
  // Regression: the queue lives on the thread detail, so every follow-up event
  // has to reach a live subscription. Missing one is invisible in tests that
  // only exercise the snapshot path — the queue simply never updates until the
  // page is reloaded. Driven off the event-type union so a new follow-up event
  // fails here instead of silently not rendering.
  it("delivers every queued follow-up event to thread subscriptions", () => {
    const followUpEventTypes = OrchestrationEventType.literals.filter((type) =>
      type.startsWith("thread.follow-up"),
    );
    expect(followUpEventTypes.length).toBeGreaterThan(0);
    for (const type of followUpEventTypes) {
      expect(isThreadDetailEvent(makeEvent(type)), type).toBe(true);
    }
  });

  it("still refuses intent events the thread detail does not render", () => {
    expect(isThreadDetailEvent(makeEvent("thread.turn-start-requested"))).toBe(false);
    expect(isThreadDetailEvent(makeEvent("thread.approval-response-requested"))).toBe(false);
  });
});
