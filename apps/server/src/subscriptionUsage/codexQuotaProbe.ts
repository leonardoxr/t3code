/**
 * Reads the Codex plan quota from a short-lived `codex app-server`.
 *
 * The app-server answers `account/rateLimits/read` from the account state it
 * already holds, so the probe costs no plan quota and stays pollable while the
 * plan is exhausted. The child lives inside the probe's scope: a timeout or an
 * interrupt closes that scope and reaps it, so a slow CLI cannot leak
 * processes.
 *
 * @module subscriptionUsage/codexQuotaProbe
 */
import type { CodexSettings } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as CodexClient from "effect-codex-app-server/client";

import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { codexAppServerArgs, resolveCodexLaunchArgs } from "../provider/Layers/codexLaunchArgs.ts";
import { buildCodexInitializeParams } from "../provider/Layers/CodexProvider.ts";
import { emptySubscriptionUsage, normalizeCodexRateLimits } from "./subscriptionUsageNormalize.ts";

/** JSON-RPC's "method not found", which is how an older CLI declines. */
const JSON_RPC_METHOD_NOT_FOUND = -32601;

/** A probe child that ignores SIGTERM is not worth waiting on. */
const FORCE_KILL_AFTER = "2 seconds" as const;

/**
 * Pulls the plan quota for one Codex instance. Spawn, handshake, and decode
 * failures travel in the error channel; the caller turns them into an
 * `unavailable` status so a broken Codex never blanks the Claude gauge.
 */
export const probeCodexSubscriptionUsage = Effect.fn("probeCodexSubscriptionUsage")(
  function* (settings: CodexSettings) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const hostEnvironment = yield* HostProcessEnvironment;
    const layout = yield* resolveCodexHomeLayout(settings);
    const environment = layout.effectiveHomePath
      ? { ...hostEnvironment, CODEX_HOME: layout.effectiveHomePath }
      : hostEnvironment;

    const spawnCommand = yield* resolveSpawnCommand(
      settings.binaryPath,
      codexAppServerArgs(resolveCodexLaunchArgs(settings.launchArgs, environment)),
      { env: environment, extendEnv: true },
    );
    const child = yield* spawner.spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        extendEnv: true,
        forceKillAfter: FORCE_KILL_AFTER,
        shell: spawnCommand.shell,
      }),
    );

    const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(clientContext),
    );

    yield* client.request("initialize", buildCodexInitializeParams());
    yield* client.notify("initialized", undefined);

    // Only a ChatGPT plan has a rolling quota. An API key or a Bedrock account
    // bills per token, so reporting "no windows" there would read as a bug.
    const account = yield* client.request("account/read", {});
    const accountType = account.account?.type ?? null;
    if (accountType === null) {
      return emptySubscriptionUsage(
        "codex",
        "unauthenticated",
        "Codex is not signed in on this machine.",
      );
    }
    if (accountType !== "chatgpt") {
      return emptySubscriptionUsage(
        "codex",
        "unauthenticated",
        "Codex is signed in without a ChatGPT plan, so it has no plan quota.",
      );
    }

    const rateLimits = yield* client
      .request("account/rateLimits/read", undefined)
      .pipe(
        Effect.catchTag("CodexAppServerRequestError", (error) =>
          error.code === JSON_RPC_METHOD_NOT_FOUND ? Effect.succeed(null) : Effect.fail(error),
        ),
      );
    if (rateLimits === null) {
      return emptySubscriptionUsage(
        "codex",
        "unsupported",
        "The installed Codex CLI is too old to report a plan quota.",
      );
    }

    const fetchedAtMs = yield* Clock.currentTimeMillis;
    return normalizeCodexRateLimits(rateLimits, { fetchedAtMs });
  },
  // The child and the protocol client belong to this scope, so closing it on
  // success, failure, timeout, or interrupt is what reaps the process.
  Effect.scoped,
);
