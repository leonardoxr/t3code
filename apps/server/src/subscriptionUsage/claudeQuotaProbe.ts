/**
 * Reads the Claude plan quota with Claude Code's own OAuth credential.
 *
 * The credential is read, never written: refreshing it is Claude Code's job and
 * a clobbered store logs the user out of their CLI. An expired or missing
 * credential is reported as `unauthenticated` rather than refreshed.
 *
 * The quota endpoint bills nothing against the plan, so this stays pollable
 * while the plan is exhausted - which is exactly when the gauge matters.
 *
 * @module subscriptionUsage/claudeQuotaProbe
 */
import type { ClaudeSettings } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { emptySubscriptionUsage, normalizeClaudeQuota } from "./subscriptionUsageNormalize.ts";

const CLAUDE_QUOTA_URL = "https://api.anthropic.com/api/oauth/usage";

/** The endpoint is gated behind Anthropic's OAuth beta flag. */
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

/** Where Claude Code keeps the credential in the macOS login keychain. */
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * The stored credential. A plan login nests under `claudeAiOauth`; an API-key
 * login has no such key, so it simply fails to decode and reports as
 * unauthenticated - an API key carries no plan quota.
 */
const ClaudeOauthCredential = Schema.Struct({
  claudeAiOauth: Schema.Struct({
    accessToken: Schema.String.check(Schema.isNonEmpty()),
    expiresAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    subscriptionType: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
});
const decodeClaudeOauthCredential = Schema.decodeUnknownExit(
  Schema.fromJsonString(
    ClaudeOauthCredential as unknown as Schema.Codec<typeof ClaudeOauthCredential.Type>,
  ),
);

/** Both credential stores hold the same JSON, so they share one reader. */
const readKeychainCredential = Effect.fn("claudeQuotaProbe.readKeychainCredential")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .string(
      ChildProcess.make("security", ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"]),
    )
    .pipe(Effect.catchCause(() => Effect.succeed(null)));
});

/**
 * A default install nests the credential under `.claude`; an overridden
 * `CLAUDE_CONFIG_DIR` is itself the config dir. Probe both, the way the
 * transcript scan resolves its directories.
 */
const readCredentialFile = Effect.fn("claudeQuotaProbe.readCredentialFile")(function* (
  settings: Pick<ClaudeSettings, "homePath">,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homePath = yield* resolveClaudeHomePath(settings);
  const candidates = [
    path.join(homePath, ".claude", ".credentials.json"),
    path.join(homePath, ".credentials.json"),
  ];
  for (const candidate of candidates) {
    const contents = yield* fileSystem
      .readFileString(candidate)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (contents !== null) return contents;
  }
  return null;
});

const readClaudeCredential = Effect.fn("claudeQuotaProbe.readClaudeCredential")(function* (
  settings: Pick<ClaudeSettings, "homePath">,
) {
  const platform = yield* HostProcessPlatform;
  const raw =
    platform === "darwin" ? yield* readKeychainCredential() : yield* readCredentialFile(settings);
  if (raw === null) return null;

  const decoded = decodeClaudeOauthCredential(raw);
  if (decoded._tag === "Failure") return null;

  const oauth = decoded.value.claudeAiOauth;
  return {
    accessToken: oauth.accessToken,
    expiresAt: oauth.expiresAt ?? null,
    subscriptionType: oauth.subscriptionType ?? null,
  };
});

/**
 * Pulls the plan quota for one Claude instance. Transport and decode failures
 * travel in the error channel; the caller turns them into an `unavailable`
 * status so a broken Claude never blanks the Codex gauge.
 */
export const probeClaudeSubscriptionUsage = Effect.fn("probeClaudeSubscriptionUsage")(function* (
  settings: Pick<ClaudeSettings, "homePath">,
) {
  const credential = yield* readClaudeCredential(settings);
  if (credential === null) {
    return emptySubscriptionUsage(
      "claude",
      "unauthenticated",
      "Claude Code is not signed in to a plan on this machine.",
    );
  }

  const now = yield* Clock.currentTimeMillis;
  if (credential.expiresAt !== null && credential.expiresAt <= now) {
    return emptySubscriptionUsage(
      "claude",
      "unauthenticated",
      "The stored Claude Code login has expired. Sign in with the Claude CLI to restore the plan quota.",
    );
  }

  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* httpClient.execute(
    HttpClientRequest.get(CLAUDE_QUOTA_URL).pipe(
      HttpClientRequest.setHeaders({
        authorization: `Bearer ${credential.accessToken}`,
        "anthropic-beta": CLAUDE_OAUTH_BETA,
        accept: "application/json",
      }),
    ),
  );

  if (response.status === 401 || response.status === 403) {
    return emptySubscriptionUsage(
      "claude",
      "unauthenticated",
      "Anthropic rejected the stored Claude Code login.",
    );
  }
  if (response.status === 404) {
    return emptySubscriptionUsage(
      "claude",
      "unsupported",
      "This Anthropic account does not report a plan quota.",
    );
  }
  if (response.status >= 400) {
    return emptySubscriptionUsage(
      "claude",
      "unavailable",
      `Anthropic answered the quota request with HTTP ${response.status}.`,
    );
  }

  const body = yield* response.json;
  const fetchedAtMs = yield* Clock.currentTimeMillis;
  return normalizeClaudeQuota(body, {
    planLabel: credential.subscriptionType,
    fetchedAtMs,
  });
});
