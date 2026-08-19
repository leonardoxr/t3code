import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import { acpPermissionOutcome, mapAcpToAdapterError } from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });

  it("surfaces the thrown message an agent hides in a generic internal error", () => {
    // omp's ACP transport wraps any unclassified handler throw as
    // `-32603 "Internal error"` and puts the real sentence in `data.details`.
    // Reporting the message alone left users with nothing to act on.
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("omp"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Internal error",
        data: { details: "ACP session closed before queued prompt could run" },
      }),
    );

    expect(error.message).toContain("Internal error");
    expect(error.message).toContain("ACP session closed before queued prompt could run");
  });

  it("keeps a detail-free error unchanged and never repeats itself", () => {
    const withoutData = mapAcpToAdapterError(
      ProviderDriverKind.make("omp"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({ code: -32603, errorMessage: "Internal error" }),
    );
    expect(withoutData.message).toContain("Internal error");
    expect(withoutData.message).not.toContain("Internal error: ");

    const echoed = mapAcpToAdapterError(
      ProviderDriverKind.make("omp"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32000,
        errorMessage: "Authentication required: log in first",
        data: { details: "log in first" },
      }),
    );
    expect(echoed.message).toContain("Authentication required: log in first");
    expect(echoed.message.endsWith("log in first")).toBe(true);
  });

  it("caps a runaway payload instead of pasting it whole into the timeline", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("omp"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Internal error",
        data: { details: "x".repeat(5_000) },
      }),
    );

    expect(error.message).toContain("…");
    expect(error.message.length).toBeLessThan(1_000);
  });
});
