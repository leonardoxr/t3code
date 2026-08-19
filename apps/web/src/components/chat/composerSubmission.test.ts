import type { FollowUpBehavior } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { resolveFollowUpDelivery } from "./composerSubmission";

const BEHAVIORS: ReadonlyArray<FollowUpBehavior> = ["queue", "steer", "interrupt"];

describe("resolveFollowUpDelivery", () => {
  it("just sends when no turn is running, whatever the setting says", () => {
    for (const behavior of BEHAVIORS) {
      for (const intent of ["default", "send", "queue"] as const) {
        expect(
          resolveFollowUpDelivery({ behavior, isRunning: false, intent }),
          `${behavior}/${intent}`,
        ).toBe("send");
      }
    }
  });

  it("applies the configured behavior while a turn is running", () => {
    expect(resolveFollowUpDelivery({ behavior: "steer", isRunning: true, intent: "default" })).toBe(
      "send",
    );
    expect(resolveFollowUpDelivery({ behavior: "queue", isRunning: true, intent: "default" })).toBe(
      "queue",
    );
    expect(
      resolveFollowUpDelivery({ behavior: "interrupt", isRunning: true, intent: "default" }),
    ).toBe("interrupt");
  });

  it("sends now for an explicit send, whatever the setting says", () => {
    for (const behavior of BEHAVIORS) {
      // "Now" steers rather than interrupts: of the two immediates it destroys
      // no work.
      expect(resolveFollowUpDelivery({ behavior, isRunning: true, intent: "send" }), behavior).toBe(
        "send",
      );
    }
  });

  it("queues for an explicit queue, whatever the setting says", () => {
    for (const behavior of BEHAVIORS) {
      expect(
        resolveFollowUpDelivery({ behavior, isRunning: true, intent: "queue" }),
        behavior,
      ).toBe("queue");
    }
  });

  it("never resolves a mid-turn send on a provider whose transport cannot steer", () => {
    // omp over ACP: a concurrent prompt would cancel or silently trail the
    // running turn, so every would-be "send" becomes an honest queue.
    expect(
      resolveFollowUpDelivery({
        behavior: "steer",
        isRunning: true,
        intent: "default",
        midTurnSteering: "queued",
      }),
    ).toBe("queue");
    expect(
      resolveFollowUpDelivery({
        behavior: "steer",
        isRunning: true,
        intent: "send",
        midTurnSteering: "queued",
      }),
    ).toBe("queue");
    // Interrupt still works: stop + fresh prompt needs no steering.
    expect(
      resolveFollowUpDelivery({
        behavior: "interrupt",
        isRunning: true,
        intent: "default",
        midTurnSteering: "queued",
      }),
    ).toBe("interrupt");
    // Idle threads send normally — nothing to steer behind.
    expect(
      resolveFollowUpDelivery({
        behavior: "steer",
        isRunning: false,
        intent: "default",
        midTurnSteering: "queued",
      }),
    ).toBe("send");
    // Native steering is untouched.
    expect(
      resolveFollowUpDelivery({
        behavior: "steer",
        isRunning: true,
        intent: "default",
        midTurnSteering: "native",
      }),
    ).toBe("send");
  });
});
