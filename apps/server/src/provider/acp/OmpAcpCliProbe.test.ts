/**
 * Optional integration check against a real `omp acp` install.
 * Enable with: T3_OMP_ACP_PROBE=1 bun run test OmpAcpCliProbe
 *
 * The probe assumes a working local Oh My Pi install (`omp` on PATH with
 * provider credentials already configured). Without one the runtime's
 * `initialize`/`authenticate` handshake will fail and the test will
 * surface the error.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { makeOmpAcpRuntime } from "./OmpAcpSupport.ts";

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeOmpAcpRuntime({
    ompSettings: { binaryPath: "omp" },
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-omp-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_OMP_ACP_PROBE === "1")("Omp ACP CLI probe", () => {
  it.effect("initialize and authenticate against real omp acp", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/new advertises a model select config option with at least one value", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const result = started.sessionSetupResult;

      expect(typeof started.sessionId).toBe("string");

      // omp advertises models through a `configOptions` entry with
      // category "model" (values like "anthropic/claude-sonnet-4-5"),
      // not the typed `SessionModelState` field. If this assertion fails
      // the upstream surface has regressed.
      const modelOption = (result.configOptions ?? []).find(
        (option) => option.category === "model",
      );
      expect(modelOption).toBeDefined();
      expect(modelOption?.type).toBe("select");
      if (modelOption?.type !== "select") return;
      expect(typeof modelOption.currentValue).toBe("string");
      expect(modelOption.options.length).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/set_config_option accepts a no-op switch to the current model", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const modelOption = (started.sessionSetupResult.configOptions ?? []).find(
        (option) => option.category === "model",
      );
      const currentModelId =
        modelOption?.type === "select" ? modelOption.currentValue.trim() : undefined;
      expect(currentModelId).toBeDefined();
      if (!currentModelId) return;

      // No-op switch — selecting the model the session already runs on must
      // succeed against every omp build that implements the config-option
      // surface.
      yield* runtime.setModel(currentModelId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
