// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";
import { OmpSettings, ProviderInstanceId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeOmpTextGeneration } from "./OmpTextGeneration.ts";
const decodeOmpSettings = Schema.decodeSync(OmpSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const OmpTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-omp-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpOmpWrapper(dir: string, env: Record<string, string>): string {
  const binDir = NodePath.join(dir, "bin");
  const ompPath = NodePath.join(binDir, "omp");
  NodeFS.mkdirSync(binDir, { recursive: true });
  NodeFS.writeFileSync(
    ompPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      'if [ "$1" != "acp" ]; then',
      '  printf "%s\\n" "unexpected args: $*" >&2',
      "  exit 11",
      "fi",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(ompPath, 0o755);
  return ompPath;
}

function withFakeAcpOmp<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-omp-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const binaryPath = makeAcpOmpWrapper(tempDir, env);
    const config = decodeOmpSettings({ binaryPath });
    const textGeneration = yield* makeOmpTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

function readJsonRpcRequests(
  filePath: string,
): ReadonlyArray<{ readonly method?: string; readonly params?: Record<string, unknown> }> {
  return NodeFS.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

it.layer(OmpTextGenerationTestLayer)("OmpTextGeneration", (it) => {
  it.effect(
    "uses ACP with disabled tool capabilities and switches models via set_config_option",
    () => {
      const requestLogDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-omp-text-log-"),
      );
      const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

      return withFakeAcpOmp(
        {
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
            subject: "Add Oh My Pi provider",
            body: "Wire up the ACP runtime and headless text generation path.",
          }),
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateCommitMessage({
              cwd: process.cwd(),
              branch: "feature/omp",
              stagedSummary: "M apps/server/src/provider/Drivers/OmpDriver.ts",
              stagedPatch: "diff --git a/.../OmpDriver.ts b/.../OmpDriver.ts",
              modelSelection: createModelSelection(ProviderInstanceId.make("omp"), "composer-2"),
            });

            expect(generated.subject).toBe("Add Oh My Pi provider");
            expect(generated.body).toBe(
              "Wire up the ACP runtime and headless text generation path.",
            );

            const requests = readJsonRpcRequests(requestLogPath);
            const initializeParams = requests.find(
              (request) => request.method === "initialize",
            )?.params;
            expect(initializeParams?.clientCapabilities).toMatchObject({
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            });
            // Text generation never advertises form elicitation; only the
            // interactive adapter does.
            expect(
              (initializeParams?.clientCapabilities as Record<string, unknown>).elicitation,
            ).toBeUndefined();
            expect(
              requests.some(
                (request) =>
                  request.method === "session/set_config_option" &&
                  request.params?.configId === "model" &&
                  request.params?.value === "composer-2",
              ),
            ).toBe(true);
          }),
      );
    },
  );

  it.effect("keeps the session default model when the selection matches it", () => {
    const requestLogDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-omp-text-log-noop-"),
    );
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpOmp(
      {
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ title: "Stay on default" }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "keep the default model",
            modelSelection: createModelSelection(ProviderInstanceId.make("omp"), "default"),
          });
          expect(generated.title).toBe("Stay on default");

          const requests = readJsonRpcRequests(requestLogPath);
          expect(requests.some((request) => request.method === "session/set_config_option")).toBe(
            false,
          );
        }),
    );
  });

  it.effect("extracts the JSON object when omp wraps it in conversational text", () =>
    withFakeAcpOmp(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT:
          "Sure! Here's a thread title:\n\n" +
          JSON.stringify({ title: "Investigate failing CI" }) +
          "\n\nLet me know if you need anything else.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "the lint job is red",
            modelSelection: createModelSelection(ProviderInstanceId.make("omp"), "composer-2"),
          });
          expect(generated.title).toBe("Investigate failing CI");
        }),
    ),
  );

  it.effect("surfaces model-selection failures as text generation errors", () =>
    withFakeAcpOmp(
      {
        T3_ACP_FAIL_SET_CONFIG_OPTION: "1",
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({ branch: "unreachable" }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateBranchName({
              cwd: process.cwd(),
              message: "wire up omp",
              modelSelection: createModelSelection(ProviderInstanceId.make("omp"), "composer-2"),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toContain("Oh My Pi ACP base model");
        }),
    ),
  );

  it.effect("fails with TextGenerationError when output is empty", () =>
    withFakeAcpOmp(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: "   \n  ",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: createModelSelection(ProviderInstanceId.make("omp"), "default"),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/empty/i);
        }),
    ),
  );

  it.effect("decodes a structured PR title + body", () =>
    withFakeAcpOmp(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          title: "feat(omp): wire up session/set_config_option",
          body: "## Summary\n- Route model switches through the negotiated `model` config option.\n- Keep the session default when no model is requested.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feat/omp-provider",
            commitSummary: "feat: add omp provider",
            diffSummary: "M apps/server/src/provider/Drivers/OmpDriver.ts",
            diffPatch: "diff --git a/.../OmpDriver.ts b/.../OmpDriver.ts",
            modelSelection: createModelSelection(ProviderInstanceId.make("omp"), "default"),
          });

          expect(generated.title).toBe("feat(omp): wire up session/set_config_option");
          expect(generated.body).toContain("negotiated `model` config option");
        }),
    ),
  );

  it.effect("fails with TextGenerationError when output is unparseable JSON", () =>
    withFakeAcpOmp(
      {
        T3_ACP_PROMPT_RESPONSE_TEXT: "totally not json output from a confused model",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: createModelSelection(ProviderInstanceId.make("omp"), "default"),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/invalid structured output/i);
        }),
    ),
  );
});
