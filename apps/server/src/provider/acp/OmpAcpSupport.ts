/**
 * OmpAcpSupport — spawn/runtime glue for the Oh My Pi CLI (`omp acp`).
 *
 * omp speaks standards-only ACP: auth method `agent` (reuses the credentials
 * already configured under `~/.omp`), models and thinking levels negotiated
 * as session config options, and modes `default`/`plan` for the interaction
 * mode toggle.
 *
 * @module OmpAcpSupport
 */
import {
  type ModelCapabilities,
  type OmpSettings,
  type ProviderOptionChoice,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { createModelCapabilities, normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { extractModelConfigId, findSessionConfigOption } from "./AcpRuntimeModel.ts";

const OMP_AUTH_METHOD_ID = "agent";
const OMP_DRIVER_KIND = ProviderDriverKind.make("omp");

type OmpAcpRuntimeOmpSettings = Pick<OmpSettings, "binaryPath">;

export interface OmpAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly ompSettings: OmpAcpRuntimeOmpSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Advertise form-mode elicitation support in `initialize`. Only the
   * adapter sets this — it registers an elicitation handler that routes
   * omp's plan-approval and extension-UI forms into T3 user-input events.
   * Probe and text-generation runtimes leave it off so omp falls back to
   * its no-elicitation behavior instead of hitting an unhandled request.
   */
  readonly advertiseElicitation?: boolean;
}

export interface OmpAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

export function buildOmpAcpSpawnInput(
  ompSettings: OmpAcpRuntimeOmpSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: ompSettings?.binaryPath || "omp",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeOmpAcpRuntime = (
  input: OmpAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildOmpAcpSpawnInput(input.ompSettings, input.cwd, input.environment),
        authMethodId: OMP_AUTH_METHOD_ID,
        ...(input.advertiseElicitation
          ? { clientCapabilities: { elicitation: { form: {} } } }
          : {}),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * Normalizes a T3 model slug into the `provider/model` id omp negotiates as
 * its model config option value. omp has no universal fallback model — an
 * empty selection yields `undefined` so callers keep the session default.
 */
export function resolveOmpAcpBaseModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) {
    return undefined;
  }
  return normalizeModelSlug(trimmed, OMP_DRIVER_KIND) ?? trimmed;
}

type OmpSessionSetupResponse =
  | EffectAcpSchema.LoadSessionResponse
  | EffectAcpSchema.NewSessionResponse
  | EffectAcpSchema.ResumeSessionResponse;

export function currentOmpModelIdFromSessionSetup(
  sessionSetupResult: OmpSessionSetupResponse,
): string | undefined {
  const modelConfigId = extractModelConfigId(sessionSetupResult);
  if (!modelConfigId) {
    return undefined;
  }
  const configOption = findSessionConfigOption(sessionSetupResult.configOptions, modelConfigId);
  const currentValue = configOption?.currentValue;
  return typeof currentValue === "string" && currentValue.trim() ? currentValue.trim() : undefined;
}

interface OmpSessionSelectOption {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
}

function flattenSessionConfigSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<OmpSessionSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    ("value" in entry ? [entry] : entry.options).flatMap((option) => {
      const value = option.value.trim();
      if (!value) {
        return [];
      }
      return [
        {
          value,
          name: option.name.trim() || value,
          ...(option.description?.trim() ? { description: option.description.trim() } : {}),
        },
      ];
    }),
  );
}

function normalizedConfigOptionCategory(option: EffectAcpSchema.SessionConfigOption): string {
  return option.category?.trim().toLowerCase() ?? "";
}

/**
 * Builds model capabilities from omp's non-model session config options.
 * The `mode` option is covered by T3's interaction mode toggle and the
 * `model` option by the model picker; everything else (`thinking`, and any
 * option future omp versions advertise) surfaces as a generic descriptor.
 */
export function buildOmpCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  const descriptors: Array<ProviderOptionDescriptor> = [];
  for (const option of configOptions ?? []) {
    const id = option.id.trim();
    if (!id) {
      continue;
    }
    const category = normalizedConfigOptionCategory(option);
    if (category === "mode" || category === "model" || id === "mode" || id === "model") {
      continue;
    }
    const label = option.name.trim() || id;
    if (option.type === "boolean") {
      descriptors.push({
        id,
        label,
        type: "boolean",
        ...(typeof option.currentValue === "boolean" ? { currentValue: option.currentValue } : {}),
      });
      continue;
    }
    const choices = flattenSessionConfigSelectOptions(option).map(
      (entry): ProviderOptionChoice => ({
        id: entry.value,
        label: entry.name,
        ...(entry.description ? { description: entry.description } : {}),
      }),
    );
    if (choices.length === 0) {
      continue;
    }
    const currentValue =
      typeof option.currentValue === "string" && option.currentValue.trim()
        ? option.currentValue.trim()
        : undefined;
    descriptors.push({
      id,
      label,
      type: "select",
      options: choices,
      ...(currentValue ? { currentValue } : {}),
    });
  }
  return createModelCapabilities({ optionDescriptors: descriptors });
}

/**
 * Resolves the config-option writes needed to honor the user's option
 * selections against the negotiated options. Unknown ids and invalid values
 * are dropped instead of failing the turn.
 */
export function resolveOmpAcpConfigUpdates(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<{ readonly configId: string; readonly value: string | boolean }> {
  if (!selections || selections.length === 0) {
    return [];
  }
  const updates: Array<{ readonly configId: string; readonly value: string | boolean }> = [];
  for (const selection of selections) {
    const configOption = findSessionConfigOption(configOptions, selection.id);
    if (!configOption) {
      continue;
    }
    const category = normalizedConfigOptionCategory(configOption);
    if (category === "mode" || category === "model") {
      continue;
    }
    if (configOption.type === "boolean") {
      if (typeof selection.value === "boolean") {
        updates.push({ configId: configOption.id, value: selection.value });
      }
      continue;
    }
    if (typeof selection.value !== "string") {
      continue;
    }
    const requested = selection.value.trim();
    const match = flattenSessionConfigSelectOptions(configOption).find(
      (option) => option.value === requested,
    );
    if (match) {
      updates.push({ configId: configOption.id, value: match.value });
    }
  }
  return updates;
}

interface OmpAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

/**
 * Applies a model selection and option selections through the config-option
 * surface. Returns the effective model id so callers can track the bound
 * model without re-reading session state.
 */
export function applyOmpAcpModelSelection<E>(input: {
  readonly runtime: OmpAcpModelSelectionRuntime;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: OmpAcpModelSelectionErrorContext) => E;
}): Effect.Effect<string | undefined, E> {
  return Effect.gen(function* () {
    let effectiveModelId = input.currentModelId;
    if (input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId) {
      yield* input.runtime.setModel(input.requestedModelId).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-model",
          }),
        ),
      );
      effectiveModelId = input.requestedModelId;
    }

    const configUpdates = resolveOmpAcpConfigUpdates(
      yield* input.runtime.getConfigOptions,
      input.selections,
    );
    for (const update of configUpdates) {
      yield* input.runtime.setConfigOption(update.configId, update.value).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-config-option",
            configId: update.configId,
          }),
        ),
      );
    }
    return effectiveModelId;
  });
}
