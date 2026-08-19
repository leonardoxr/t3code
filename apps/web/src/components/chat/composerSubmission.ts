import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import type { FollowUpBehavior } from "@t3tools/contracts/settings";

/**
 * What a submit does with the draft.
 *
 * - `send` dispatches a turn. While one is running the provider folds it into
 *   that turn, which is what "steer" means.
 * - `queue` parks it until the thread is genuinely idle.
 * - `interrupt` stops the running turn and runs this message next.
 */
export type FollowUpDelivery = "send" | "queue" | "interrupt";

/**
 * Resolve the setting (and the one-off override chord) into an action.
 *
 * With no turn running there is nothing to queue behind or interrupt, so every
 * behavior just sends. The override flips between queueing and sending now;
 * when the user's default is already queue, "now" steers rather than
 * interrupts — of the two immediates it is the one that destroys no work.
 */
export function resolveFollowUpDelivery(input: {
  readonly behavior: FollowUpBehavior;
  readonly isRunning: boolean;
  readonly override: boolean;
}): FollowUpDelivery {
  if (!input.isRunning) {
    return "send";
  }
  if (input.behavior === "queue") {
    return input.override ? "send" : "queue";
  }
  if (input.override) {
    return "queue";
  }
  return input.behavior === "interrupt" ? "interrupt" : "send";
}

type ComposerSubmitEvent = { preventDefault: () => void };

type ComposerSubmissionInput = {
  prompt: string;
  providerInput?: string;
  submissionTarget: "provider-turn" | "pending-user-input";
};

export function getComposerPromptLengthValidationMessage(prompt: string): string | null {
  const excessCharacters = prompt.trim().length - PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
  if (excessCharacters <= 0) return null;

  const characterLabel = excessCharacters === 1 ? "character" : "characters";
  return `Prompt is ${excessCharacters.toLocaleString("en-US")} ${characterLabel} over the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US")}-character limit. Shorten or split it before sending.`;
}

export function getComposerSubmissionValidationMessage(
  options: ComposerSubmissionInput,
): string | null {
  return options.submissionTarget === "provider-turn"
    ? getComposerPromptLengthValidationMessage(options.providerInput ?? options.prompt)
    : null;
}

export function submitComposerDraft(
  options: ComposerSubmissionInput & {
    event: ComposerSubmitEvent | undefined;
    onSend: (event?: ComposerSubmitEvent) => boolean | void;
  },
): { validationMessage: string | null; didDispatch: boolean } {
  const validationMessage = getComposerSubmissionValidationMessage(options);
  if (validationMessage) {
    options.event?.preventDefault();
    return { validationMessage, didDispatch: false };
  }

  if (options.onSend(options.event) === false) {
    options.event?.preventDefault();
    return { validationMessage: null, didDispatch: false };
  }
  return { validationMessage: null, didDispatch: true };
}
