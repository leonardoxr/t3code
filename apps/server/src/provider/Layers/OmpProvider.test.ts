import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/schema";
import { OmpSettings } from "@t3tools/contracts";

import {
  buildInitialOmpProviderSnapshot,
  buildOmpDiscoveredModelsFromConfigOptions,
  buildOmpSlashCommands,
  checkOmpProviderStatus,
} from "./OmpProvider.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

describe("buildInitialOmpProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialOmpProviderSnapshot(
        decodeOmpSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialOmpProviderSnapshot(decodeOmpSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Oh My Pi");
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
    }),
  );
});

it.layer(NodeServices.layer)("checkOmpProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOmpProviderStatus(
        decodeOmpSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/omp-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken omp install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-omp-version-" });
          const ompPath = path.join(dir, "omp");
          yield* fs.writeFileString(
            ompPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(ompPath, 0o755);

          return yield* checkOmpProviderStatus(
            decodeOmpSettings({ enabled: true, binaryPath: ompPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Oh My Pi CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("reports an error when ACP model discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-omp-success-" });
          const ompPath = path.join(dir, "omp");
          yield* fs.writeFileString(
            ompPath,
            ["#!/bin/sh", 'printf "omp 0.0.99\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(ompPath, 0o755);

          return yield* checkOmpProviderStatus(
            decodeOmpSettings({
              enabled: true,
              binaryPath: ompPath,
              customModels: ["acme/custom-model"],
            }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["acme/custom-model"]);
      expect(snapshot.message).toContain("ACP startup failed");
    }),
  );
});

const modelConfigOption: EffectAcpSchema.SessionConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "anthropic/claude-sonnet-4-5",
  options: [
    { value: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { value: "openai/gpt-5", name: "GPT-5" },
    { value: "anthropic/claude-sonnet-4-5", name: "Duplicate Sonnet" },
    { value: "   ", name: "Blank" },
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

describe("buildOmpDiscoveredModelsFromConfigOptions", () => {
  it("returns no models without a model select config option", () => {
    expect(buildOmpDiscoveredModelsFromConfigOptions(undefined)).toEqual([]);
    expect(buildOmpDiscoveredModelsFromConfigOptions([])).toEqual([]);
    expect(buildOmpDiscoveredModelsFromConfigOptions([modeConfigOption])).toEqual([]);
    expect(
      buildOmpDiscoveredModelsFromConfigOptions([
        { id: "model", name: "Model", category: "model", type: "boolean", currentValue: true },
      ]),
    ).toEqual([]);
  });

  it("maps model select options, marks the current value as default, and dedupes", () => {
    const models = buildOmpDiscoveredModelsFromConfigOptions([
      modeConfigOption,
      modelConfigOption,
      thinkingConfigOption,
    ]);

    expect(models.map((model) => model.slug)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5",
    ]);
    expect(models[0]).toMatchObject({
      slug: "anthropic/claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      isCustom: false,
      isDefault: true,
    });
    expect(models[1]!.isDefault).toBeUndefined();
  });

  it("surfaces non-model, non-mode config options as option descriptors", () => {
    const models = buildOmpDiscoveredModelsFromConfigOptions([
      modeConfigOption,
      modelConfigOption,
      thinkingConfigOption,
    ]);

    for (const model of models) {
      expect(model.capabilities?.optionDescriptors).toEqual([
        {
          id: "thinking",
          label: "Thinking",
          type: "select",
          currentValue: "medium",
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
        },
      ]);
    }
  });

  it("flattens grouped model select options", () => {
    const models = buildOmpDiscoveredModelsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "openai/gpt-5",
        options: [
          {
            group: "anthropic",
            name: "Anthropic",
            options: [{ value: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
          },
          {
            group: "openai",
            name: "OpenAI",
            options: [{ value: "openai/gpt-5", name: "GPT-5" }],
          },
        ],
      },
    ]);

    // The default model's sub-provider group leads; others follow alphabetically.
    expect(models.map((model) => model.slug)).toEqual([
      "openai/gpt-5",
      "anthropic/claude-sonnet-4-5",
    ]);
    expect(models[0]!.isDefault).toBe(true);
    expect(models[0]!.subProvider).toBe("OpenAI");
    expect(models[1]!.subProvider).toBe("Anthropic");
  });

  it("orders models newest-first within sub-provider groups and folds dated duplicates into legacy", () => {
    const models = buildOmpDiscoveredModelsFromConfigOptions([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "anthropic/claude-opus-4-5",
        options: [
          { value: "anthropic/claude-3-5-sonnet-20240620", name: "Claude Sonnet 3.5" },
          { value: "anthropic/claude-opus-4-5", name: "Claude Opus 4.5" },
          { value: "anthropic/claude-opus-4-5-20251101", name: "Claude Opus 4.5" },
          { value: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6" },
          { value: "openai-codex/gpt-5.4", name: "GPT-5.4" },
          { value: "openai-codex/gpt-5.6-sol", name: "GPT-5.6-Sol" },
          { value: "ollama/llama3.2:3b", name: "llama3.2:3b" },
        ],
      },
    ]);

    expect(models.map((model) => model.slug)).toEqual([
      // Default group (Anthropic) first, newest first.
      "anthropic/claude-opus-4-6",
      "anthropic/claude-opus-4-5",
      "anthropic/claude-opus-4-5-20251101",
      "anthropic/claude-3-5-sonnet-20240620",
      // Remaining groups alphabetically: Ollama, then OpenAI Codex.
      "ollama/llama3.2:3b",
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-5.4",
    ]);
    expect(models.find((model) => model.slug === "anthropic/claude-opus-4-5")?.isDefault).toBe(
      true,
    );
    // Dated duplicate of an undated sibling is legacy; the dated-only 3.5 is not.
    expect(
      models.find((model) => model.slug === "anthropic/claude-opus-4-5-20251101")?.isLegacy,
    ).toBe(true);
    expect(
      models.find((model) => model.slug === "anthropic/claude-3-5-sonnet-20240620")?.isLegacy,
    ).toBeUndefined();
    expect(models.find((model) => model.slug === "openai-codex/gpt-5.6-sol")?.subProvider).toBe(
      "OpenAI Codex",
    );
  });
});

describe("buildOmpSlashCommands", () => {
  it("maps command names with optional description and input hint", () => {
    expect(
      buildOmpSlashCommands([
        { name: "compact" },
        { name: "review", description: "Review the current diff" },
        { name: "model", description: "Switch model", inputHint: "provider/model" },
      ]),
    ).toEqual([
      { name: "compact" },
      { name: "review", description: "Review the current diff" },
      { name: "model", description: "Switch model", input: { hint: "provider/model" } },
    ]);
  });

  it("returns an empty catalog for no commands", () => {
    expect(buildOmpSlashCommands([])).toEqual([]);
  });
});
