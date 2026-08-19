import type { FollowUpBehavior } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { resolveFollowUpDelivery } from "./composerSubmission";

const BEHAVIORS: ReadonlyArray<FollowUpBehavior> = ["queue", "steer", "interrupt"];

describe("resolveFollowUpDelivery", () => {
  it("just sends when no turn is running, whatever the setting says", () => {
    for (const behavior of BEHAVIORS) {
      expect(
        resolveFollowUpDelivery({ behavior, isRunning: false, override: false }),
        behavior,
      ).toBe("send");
      expect(
        resolveFollowUpDelivery({ behavior, isRunning: false, override: true }),
        behavior,
      ).toBe("send");
    }
  });

  it("applies the configured behavior while a turn is running", () => {
    expect(resolveFollowUpDelivery({ behavior: "steer", isRunning: true, override: false })).toBe(
      "send",
    );
    expect(resolveFollowUpDelivery({ behavior: "queue", isRunning: true, override: false })).toBe(
      "queue",
    );
    expect(
      resolveFollowUpDelivery({ behavior: "interrupt", isRunning: true, override: false }),
    ).toBe("interrupt");
  });

  it("flips between queueing and sending now for one message", () => {
    // Sending immediately by default → the override queues.
    expect(resolveFollowUpDelivery({ behavior: "steer", isRunning: true, override: true })).toBe(
      "queue",
    );
    expect(
      resolveFollowUpDelivery({ behavior: "interrupt", isRunning: true, override: true }),
    ).toBe("queue");
    // Queueing by default → the override sends now, and "now" steers rather
    // than interrupts: of the two immediates it destroys no work.
    expect(resolveFollowUpDelivery({ behavior: "queue", isRunning: true, override: true })).toBe(
      "send",
    );
  });

  it("never resolves the override to the same delivery as the default", () => {
    for (const behavior of BEHAVIORS) {
      const plain = resolveFollowUpDelivery({ behavior, isRunning: true, override: false });
      const overridden = resolveFollowUpDelivery({ behavior, isRunning: true, override: true });
      expect(overridden, behavior).not.toBe(plain);
    }
  });
});
