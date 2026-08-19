/**
 * OmpProvider — snapshot lifecycle for the Oh My Pi (`omp`) provider.
 *
 * Probes the CLI with `omp --version`, then discovers models, option
 * descriptors (thinking level), and slash commands through a throwaway
 * `omp acp` session: omp advertises models as a `model` session config
 * option and pushes its slash-command catalog as an
 * `available_commands_update` shortly after session setup.
 *
 * @module OmpProvider
 */
import {
  type ModelCapabilities,
  type OmpSettings,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { type AcpAvailableCommand } from "../acp/AcpRuntimeModel.ts";
import { buildOmpCapabilitiesFromConfigOptions, makeOmpAcpRuntime } from "../acp/OmpAcpSupport.ts";

const OMP_PRESENTATION = {
  displayName: "Oh My Pi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: false,
  // omp over ACP cannot steer: a concurrent session/prompt implicitly
  // CANCELS the running turn (acp-agent prompt()), and T3's prompt
  // serialization otherwise holds the message until the turn ends while the
  // timeline claims delivery. Clients must queue mid-turn sends instead.
  midTurnSteering: "queued",
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const OMP_ACP_DISCOVERY_TIMEOUT_MS = 15_000;
/**
 * omp pushes `available_commands_update` ~50ms after session setup (its
 * bootstrap race guard). Bound the wait so a hung push cannot eat the
 * discovery budget.
 */
const OMP_COMMAND_DISCOVERY_TIMEOUT_MS = 3_000;

interface OmpAcpDiscoveryResult {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
}

export function buildInitialOmpProviderSnapshot(
  ompSettings: OmpSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = ompModelsFromSettings(ompSettings.customModels);

    if (!ompSettings.enabled) {
      return buildServerProvider({
        presentation: OMP_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Oh My Pi is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Oh My Pi CLI availability...",
      },
    });
  });
}

function ompModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/**
 * Display labels for omp's model-id prefixes (`<sub-provider>/<model>`).
 * Unknown prefixes fall back to title-cased tokens so new omp providers
 * still group sensibly without a T3 release.
 */
const OMP_SUB_PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  "openai-codex": "OpenAI Codex",
  openai: "OpenAI",
  google: "Google",
  gemini: "Google",
  "google-vertex": "Google Vertex",
  ollama: "Ollama",
  groq: "Groq",
  cerebras: "Cerebras",
  xai: "xAI",
  openrouter: "OpenRouter",
  mistral: "Mistral",
  zai: "Z.ai",
  minimax: "MiniMax",
  opencode: "OpenCode",
  copilot: "GitHub Copilot",
  "github-copilot": "GitHub Copilot",
  bedrock: "AWS Bedrock",
  azure: "Azure OpenAI",
};

function ompSubProviderLabel(prefix: string): string {
  const known = OMP_SUB_PROVIDER_LABELS[prefix];
  if (known) {
    return known;
  }
  return prefix
    .split(/[-_]+/)
    .filter((token) => token.length > 0)
    .map((token) => token[0]!.toUpperCase() + token.slice(1))
    .join(" ");
}

/**
 * Numeric version tokens of a model id, for newest-first ordering.
 * Eight-digit date stamps (`-20250514`) are snapshot markers, not version
 * numbers — they rank as oldest so `claude-opus-4-8` outranks
 * `claude-opus-4-20250514`.
 */
function ompModelVersionRank(modelId: string): ReadonlyArray<number> {
  return (modelId.match(/\d+(?:\.\d+)?/g) ?? []).map((token) =>
    /^\d{8}$/.test(token) ? -1 : Number(token),
  );
}

function compareVersionRanksDesc(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    // A missing token ranks highest: the shorter id is the canonical alias
    // (`claude-opus-4-5` before its `-20251101` snapshot, `gpt-5` before
    // `gpt-5.4`), matching how providers point bare ids at the latest rev.
    const delta = (b[index] ?? Number.POSITIVE_INFINITY) - (a[index] ?? Number.POSITIVE_INFINITY);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

/** Date-stamped duplicate of an undated sibling (`…-20251101`). */
function isDatedDuplicate(modelId: string, allIds: ReadonlySet<string>): boolean {
  const match = /^(.*)-\d{8}$/.exec(modelId);
  return match !== null && allIds.has(match[1]!);
}

export function buildOmpDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const modelOption = (configOptions ?? []).find(
    (option) => option.category === "model" && option.id.trim().length > 0,
  );
  if (!modelOption || modelOption.type !== "select") {
    return [];
  }
  const capabilities = buildOmpCapabilitiesFromConfigOptions(configOptions);
  const currentModelId =
    typeof modelOption.currentValue === "string" ? modelOption.currentValue.trim() : "";

  interface OmpDiscoveredModel {
    readonly slug: string;
    readonly name: string;
    readonly subProvider: string | undefined;
    readonly versionRank: ReadonlyArray<number>;
    readonly isDefault: boolean;
  }

  const seen = new Set<string>();
  const discovered = modelOption.options
    .flatMap((entry) => ("value" in entry ? [entry] : entry.options))
    .flatMap((option): Array<OmpDiscoveredModel> => {
      const slug = option.value.trim();
      if (!slug || seen.has(slug)) {
        return [];
      }
      seen.add(slug);
      const separatorIndex = slug.indexOf("/");
      const prefix = separatorIndex > 0 ? slug.slice(0, separatorIndex) : "";
      const modelId = separatorIndex > 0 ? slug.slice(separatorIndex + 1) : slug;
      return [
        {
          slug,
          name: option.name.trim() || slug,
          subProvider: prefix ? ompSubProviderLabel(prefix) : undefined,
          versionRank: ompModelVersionRank(modelId),
          isDefault: currentModelId.length > 0 && slug === currentModelId,
        },
      ];
    });

  // Group by sub-provider — the default model's group leads, the rest are
  // alphabetical — and order newest-first within each group so the picker
  // reads latest → older. Date-stamped duplicates of an undated id fold
  // into the picker's collapsed legacy section.
  const defaultGroup = discovered.find((model) => model.isDefault)?.subProvider;
  const groupSortKey = (subProvider: string | undefined): string =>
    `${subProvider === defaultGroup ? "0" : "1"}:${subProvider ?? "\uffff"}`;
  const allSlugs = new Set(discovered.map((model) => model.slug));
  return discovered
    .toSorted((a, b) => {
      const groupDelta = groupSortKey(a.subProvider).localeCompare(groupSortKey(b.subProvider));
      if (groupDelta !== 0) {
        return groupDelta;
      }
      const versionDelta = compareVersionRanksDesc(a.versionRank, b.versionRank);
      if (versionDelta !== 0) {
        return versionDelta;
      }
      return a.name.localeCompare(b.name);
    })
    .map(
      (model): ServerProviderModel => ({
        slug: model.slug,
        name: model.name,
        ...(model.subProvider ? { subProvider: model.subProvider } : {}),
        isCustom: false,
        ...(model.isDefault ? { isDefault: true } : {}),
        ...(isDatedDuplicate(model.slug, allSlugs) ? { isLegacy: true } : {}),
        capabilities,
      }),
    );
}

export function buildOmpSlashCommands(
  commands: ReadonlyArray<AcpAvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  return commands.map((command) => ({
    name: command.name,
    ...(command.description ? { description: command.description } : {}),
    ...(command.inputHint ? { input: { hint: command.inputHint } } : {}),
  }));
}

const discoverOmpViaAcp = (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeOmpAcpRuntime({
      ompSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    const models = buildOmpDiscoveredModelsFromConfigOptions(
      started.sessionSetupResult.configOptions,
    );
    // Wait for the bootstrap `available_commands_update` push; the catalog
    // ref stays empty if omp never sends one within the bound.
    yield* Stream.runDrain(
      Stream.take(
        Stream.filter(acp.getEvents(), (event) => event._tag === "AvailableCommandsChanged"),
        1,
      ),
    ).pipe(Effect.timeoutOption(OMP_COMMAND_DISCOVERY_TIMEOUT_MS));
    const slashCommands = buildOmpSlashCommands(yield* acp.getAvailableCommands);
    return { models, slashCommands } satisfies OmpAcpDiscoveryResult;
  }).pipe(Effect.scoped);

const runOmpVersionCommand = (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = ompSettings.binaryPath || "omp";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = ompModelsFromSettings(ompSettings.customModels);

  if (!ompSettings.enabled) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Oh My Pi is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runOmpVersionCommand(ompSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Oh My Pi CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Oh My Pi CLI (`omp`) is not installed or not on PATH."
          : "Failed to execute Oh My Pi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Oh My Pi CLI is installed but timed out while running `omp --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Oh My Pi CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Oh My Pi CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverOmpViaAcp(ompSettings, environment).pipe(
    Effect.timeoutOption(OMP_ACP_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Oh My Pi ACP discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Oh My Pi CLI is installed but ACP startup failed. Check server logs for details.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `Oh My Pi ACP discovery timed out after ${OMP_ACP_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Oh My Pi CLI is installed but ACP startup timed out after ${OMP_ACP_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }
  const discovered = discoveryExit.value.value;
  const models =
    discovered.models.length > 0
      ? ompModelsFromSettings(ompSettings.customModels, discovered.models)
      : fallbackModels;

  return buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: ompSettings.enabled,
    checkedAt,
    models,
    slashCommands: discovered.slashCommands,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

export const enrichOmpSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Oh My Pi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
