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
 * What the submit asked for, independent of the setting.
 *
 * `default` is Enter: whatever Settings → Follow-up behavior says. `send` and
 * `queue` are the two explicit chords (and the button beside Stop), and always
 * mean the same thing no matter how the setting is configured.
 */
export type FollowUpIntent = "default" | "send" | "queue";

/**
 * Resolve an intent into an action.
 *
 * With no turn running there is nothing to queue behind or interrupt, so every
 * intent just sends. While one runs, an explicit `send` steers rather than
 * interrupts: of the two immediates it is the one that destroys no work.
 *
 * A provider whose transport cannot steer (`midTurnSteering: "queued"`) never
 * resolves to a mid-turn `send`: the message would sit invisibly behind the
 * running prompt while the timeline claimed delivery, so it queues instead —
 * same delivery time, honest UI. Interrupt still works everywhere.
 */
export function resolveFollowUpDelivery(input: {
  readonly behavior: FollowUpBehavior;
  readonly isRunning: boolean;
  readonly intent: FollowUpIntent;
  readonly midTurnSteering?: "native" | "queued";
}): FollowUpDelivery {
  if (!input.isRunning) {
    return "send";
  }
  const steerImpossible = input.midTurnSteering === "queued";
  if (input.intent === "send") {
    return steerImpossible ? "queue" : "send";
  }
  if (input.intent === "queue" || input.behavior === "queue") {
    return "queue";
  }
  if (input.behavior === "interrupt") {
    return "interrupt";
  }
  return steerImpossible ? "queue" : "send";
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
