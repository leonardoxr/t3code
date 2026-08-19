import {
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/**
 * The readable part of a JSON-RPC error payload.
 *
 * An agent handler that throws something it did not classify comes back as the
 * standard `-32603 "Internal error"`, with the only useful sentence — the
 * thrown error's own message — tucked into `data`. Reporting `message` alone
 * turns every one of those into an unfalsifiable "Internal error".
 */
function acpErrorDataDetail(data: unknown): string | null {
  if (typeof data === "string") {
    return data.trim().length === 0 ? null : data;
  }
  if (typeof data !== "object" || data === null) {
    return null;
  }
  if ("details" in data && typeof data.details === "string" && data.details.trim().length > 0) {
    return data.details;
  }
  try {
    const encoded = JSON.stringify(data);
    return encoded === undefined || encoded === "{}" ? null : encoded;
  } catch {
    return null;
  }
}

const MAX_ACP_ERROR_DETAIL_CHARS = 600;

function acpRequestErrorDetail(error: EffectAcpErrors.AcpRequestError): string {
  const detail = acpErrorDataDetail(error.data);
  if (detail === null || error.errorMessage.includes(detail)) {
    return error.errorMessage;
  }
  const trimmed =
    detail.length > MAX_ACP_ERROR_DETAIL_CHARS
      ? `${detail.slice(0, MAX_ACP_ERROR_DETAIL_CHARS)}…`
      : detail;
  return `${error.errorMessage}: ${trimmed}`;
}

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (isAcpProcessExitedError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (isAcpRequestError(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: acpRequestErrorDetail(error),
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}
