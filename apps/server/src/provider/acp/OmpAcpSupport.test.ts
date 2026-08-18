import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import type { ProviderOptionSelection } from "@t3tools/contracts";

import {
  applyOmpAcpModelSelection,
  buildOmpAcpSpawnInput,
  currentOmpModelIdFromSessionSetup,
  resolveOmpAcpBaseModelId,
  resolveOmpAcpConfigUpdates,
} from "./OmpAcpSupport.ts";

const modelConfigOption: EffectAcpSchema.SessionConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "anthropic/claude-sonnet-4-5",
  options: [
    { value: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { value: "openai/gpt-5", name: "GPT-5" },
  ],
};

const modeConfigOption: EffectAcpSchema.SessionConfigOption = {
  id: "mode",
  name: "Mode",
  category: "mode",
  type: "select",
  currentValue: "implement",
  options: [
    { value: "plan", name: "Plan" },
    { value: "implement", name: "Implement" },
  ],
};

const thinkingConfigOption: EffectAcpSchema.SessionConfigOption = {
  id: "thinking",
  name: "Thinking",
  category: "thought_level",
  type: "select",
  currentValue: "medium",
  options: [
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
  ],
};

const verboseConfigOption: EffectAcpSchema.SessionConfigOption = {
  id: "verbose",
  name: "Verbose",
  category: "model_config",
  type: "boolean",
  currentValue: false,
};

describe("resolveOmpAcpBaseModelId", () => {
  it("returns undefined for empty selections so the session default is kept", () => {
    expect(resolveOmpAcpBaseModelId(undefined)).toBeUndefined();
    expect(resolveOmpAcpBaseModelId(null)).toBeUndefined();
    expect(resolveOmpAcpBaseModelId("   ")).toBeUndefined();
  });

  it("passes provider/model ids through with trimming", () => {
    expect(resolveOmpAcpBaseModelId("anthropic/claude-sonnet-4-5")).toBe(
      "anthropic/claude-sonnet-4-5",
    );
    expect(resolveOmpAcpBaseModelId("  openai/gpt-5  ")).toBe("openai/gpt-5");
  });
});

describe("buildOmpAcpSpawnInput", () => {
  it("defaults the command to omp and spawns the acp subcommand", () => {
    expect(buildOmpAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "omp",
      args: ["acp"],
      cwd: "/tmp/project",
    });
    expect(buildOmpAcpSpawnInput({ binaryPath: "" }, "/tmp/project")).toEqual({
      command: "omp",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("honors the configured binary path and passes the environment through untouched", () => {
    const environment = { PATH: "/usr/bin", OMP_HOME: "/tmp/omp-home" };
    expect(
      buildOmpAcpSpawnInput({ binaryPath: "/usr/local/bin/omp" }, "/tmp/project", environment),
    ).toEqual({
      command: "/usr/local/bin/omp",
      args: ["acp"],
      cwd: "/tmp/project",
      env: environment,
    });
  });
});

describe("currentOmpModelIdFromSessionSetup", () => {
  it("reads the current value from the model config option", () => {
    const setup: EffectAcpSchema.NewSessionResponse = {
      sessionId: "omp-session-1",
      configOptions: [modeConfigOption, modelConfigOption],
    };
    expect(currentOmpModelIdFromSessionSetup(setup)).toBe("anthropic/claude-sonnet-4-5");
  });

  it("returns undefined when no model config option is negotiated", () => {
    expect(
      currentOmpModelIdFromSessionSetup({
        sessionId: "omp-session-1",
        configOptions: [modeConfigOption],
      }),
    ).toBeUndefined();
    expect(currentOmpModelIdFromSessionSetup({ sessionId: "omp-session-1" })).toBeUndefined();
  });

  it("returns undefined when the model option has a blank current value", () => {
    const setup: EffectAcpSchema.NewSessionResponse = {
      sessionId: "omp-session-1",
      configOptions: [{ ...modelConfigOption, currentValue: "   " }],
    };
    expect(currentOmpModelIdFromSessionSetup(setup)).toBeUndefined();
  });
});

describe("resolveOmpAcpConfigUpdates", () => {
  const configOptions = [
    modeConfigOption,
    modelConfigOption,
    thinkingConfigOption,
    verboseConfigOption,
  ];

  it("returns no updates without selections", () => {
    expect(resolveOmpAcpConfigUpdates(configOptions, undefined)).toEqual([]);
    expect(resolveOmpAcpConfigUpdates(configOptions, [])).toEqual([]);
  });

  it("applies a valid select value", () => {
    expect(resolveOmpAcpConfigUpdates(configOptions, [{ id: "thinking", value: "high" }])).toEqual([
      { configId: "thinking", value: "high" },
    ]);
  });

  it("drops unknown ids and values outside the negotiated options", () => {
    expect(
      resolveOmpAcpConfigUpdates(configOptions, [
        { id: "thinking", value: "ultra" },
        { id: "nonexistent", value: "high" },
        { id: "thinking", value: true },
      ]),
    ).toEqual([]);
  });

  it("skips mode and model category options", () => {
    expect(
      resolveOmpAcpConfigUpdates(configOptions, [
        { id: "mode", value: "plan" },
        { id: "model", value: "openai/gpt-5" },
      ]),
    ).toEqual([]);
  });

  it("applies boolean selections and drops non-boolean values for boolean options", () => {
    expect(
      resolveOmpAcpConfigUpdates(configOptions, [
        { id: "verbose", value: true },
        { id: "verbose", value: "true" },
      ]),
    ).toEqual([{ configId: "verbose", value: true }]);
  });
});

describe("applyOmpAcpModelSelection", () => {
  const makeRecordingRuntime = (input?: {
    readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
    readonly setModelFailure?: EffectAcpErrors.AcpError;
    readonly setConfigOptionFailure?: EffectAcpErrors.AcpError;
  }) => {
    const modelCalls: Array<string> = [];
    const configCalls: Array<{ readonly configId: string; readonly value: string | boolean }> = [];
    const runtime = {
      getConfigOptions: Effect.succeed(input?.configOptions ?? []),
      setModel: (model: string) =>
        Effect.gen(function* () {
          modelCalls.push(model);
          if (input?.setModelFailure) return yield* input.setModelFailure;
          return {};
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.gen(function* () {
          configCalls.push({ configId, value });
          if (input?.setConfigOptionFailure) return yield* input.setConfigOptionFailure;
          return {} as EffectAcpSchema.SetSessionConfigOptionResponse;
        }),
    };
    return { runtime, modelCalls, configCalls };
  };

  it.effect("switches the model when the requested id differs from current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyOmpAcpModelSelection({
        runtime,
        currentModelId: "anthropic/claude-sonnet-4-5",
        requestedModelId: "openai/gpt-5",
        mapError: (context) => context.step,
      });
      expect(modelCalls).toEqual(["openai/gpt-5"]);
      expect(result).toBe("openai/gpt-5");
    }),
  );

  it.effect("is a no-op when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, configCalls } = makeRecordingRuntime();
      const result = yield* applyOmpAcpModelSelection({
        runtime,
        currentModelId: "anthropic/claude-sonnet-4-5",
        requestedModelId: "anthropic/claude-sonnet-4-5",
        mapError: (context) => context.step,
      });
      expect(modelCalls).toEqual([]);
      expect(configCalls).toEqual([]);
      expect(result).toBe("anthropic/claude-sonnet-4-5");
    }),
  );

  it.effect("keeps the session default when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyOmpAcpModelSelection({
        runtime,
        currentModelId: undefined,
        requestedModelId: undefined,
        mapError: (context) => context.step,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBeUndefined();
    }),
  );

  it.effect("writes resolved option selections through set_config_option", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, configCalls } = makeRecordingRuntime({
        configOptions: [modelConfigOption, thinkingConfigOption, verboseConfigOption],
      });
      const selections: ReadonlyArray<ProviderOptionSelection> = [
        { id: "thinking", value: "high" },
        { id: "thinking", value: "bogus" },
        { id: "verbose", value: true },
        { id: "model", value: "openai/gpt-5" },
      ];
      const result = yield* applyOmpAcpModelSelection({
        runtime,
        currentModelId: "anthropic/claude-sonnet-4-5",
        requestedModelId: undefined,
        selections,
        mapError: (context) => context.step,
      });
      expect(modelCalls).toEqual([]);
      expect(configCalls).toEqual([
        { configId: "thinking", value: "high" },
        { configId: "verbose", value: true },
      ]);
      expect(result).toBe("anthropic/claude-sonnet-4-5");
    }),
  );

  it.effect("propagates set-model failures via mapError with step context", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime({ setModelFailure: failure });
      const error = yield* Effect.flip(
        applyOmpAcpModelSelection({
          runtime,
          currentModelId: "anthropic/claude-sonnet-4-5",
          requestedModelId: "openai/gpt-5",
          mapError: (context) => ({ step: context.step, message: context.cause.message }),
        }),
      );
      expect(error).toEqual({ step: "set-model", message: failure.message });
    }),
  );

  it.effect("propagates set-config-option failures via mapError with the config id", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("bad option");
      const { runtime } = makeRecordingRuntime({
        configOptions: [thinkingConfigOption],
        setConfigOptionFailure: failure,
      });
      const error = yield* Effect.flip(
        applyOmpAcpModelSelection({
          runtime,
          currentModelId: undefined,
          requestedModelId: undefined,
          selections: [{ id: "thinking", value: "low" }],
          mapError: (context) => ({ step: context.step, configId: context.configId }),
        }),
      );
      expect(error).toEqual({ step: "set-config-option", configId: "thinking" });
    }),
  );
});
