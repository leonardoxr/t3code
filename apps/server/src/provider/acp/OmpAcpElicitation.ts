/**
 * OmpAcpElicitation — maps ACP form-mode elicitation to T3 user-input events.
 *
 * omp uses `elicitation/create` (form mode) for its plan-mode approval
 * dialog ("Approve and execute" / "Refine plan") and extension UI prompts.
 * Option-shaped forms (string enums, booleans, enum arrays) map onto T3's
 * question dialog; free-form text/number forms are not representable and
 * yield `undefined` so the caller answers with `cancel` — omp degrades
 * gracefully on cancelled elicitations.
 *
 * @module OmpAcpElicitation
 */
import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

type OmpElicitationFormRequest = Extract<
  EffectAcpSchema.ElicitationRequest,
  { readonly mode: "form" }
>;

interface OmpElicitationChoice {
  readonly label: string;
  readonly description: string;
  readonly value: string | boolean;
}

interface OmpElicitationField {
  readonly key: string;
  readonly question: UserInputQuestion;
  readonly choices: ReadonlyArray<OmpElicitationChoice>;
  readonly multiSelect: boolean;
  readonly required: boolean;
}

function isFormElicitationRequest(
  request: EffectAcpSchema.ElicitationRequest,
): request is OmpElicitationFormRequest {
  return request.mode === "form";
}

function choicesFromStringProperty(
  property: Extract<EffectAcpSchema.ElicitationPropertySchema, { readonly type: "string" }>,
): ReadonlyArray<OmpElicitationChoice> | undefined {
  if (property.oneOf && property.oneOf.length > 0) {
    return property.oneOf.flatMap((option) => {
      const value = option.const.trim();
      if (!value) {
        return [];
      }
      const label = option.title.trim() || value;
      return [{ label, description: value, value }];
    });
  }
  if (property.enum && property.enum.length > 0) {
    return property.enum.flatMap((entry) => {
      const value = entry.trim();
      return value ? [{ label: value, description: value, value }] : [];
    });
  }
  return undefined;
}

function choicesFromArrayItems(
  items: Extract<EffectAcpSchema.ElicitationPropertySchema, { readonly type: "array" }>["items"],
): ReadonlyArray<OmpElicitationChoice> {
  if ("enum" in items) {
    return items.enum.flatMap((entry) => {
      const value = entry.trim();
      return value ? [{ label: value, description: value, value }] : [];
    });
  }
  return items.anyOf.flatMap((option) => {
    const value = option.const.trim();
    if (!value) {
      return [];
    }
    const label = option.title.trim() || value;
    return [{ label, description: value, value }];
  });
}

function fieldFromProperty(input: {
  readonly key: string;
  readonly property: EffectAcpSchema.ElicitationPropertySchema;
  readonly formTitle: string | undefined;
  readonly message: string;
  readonly required: boolean;
}): OmpElicitationField | undefined {
  const { key, property } = input;
  const header = property.title?.trim() || input.formTitle || "Oh My Pi";
  const questionText = property.description?.trim() || input.message.trim() || header;

  let choices: ReadonlyArray<OmpElicitationChoice> | undefined;
  let multiSelect = false;
  switch (property.type) {
    case "string":
      choices = choicesFromStringProperty(property);
      break;
    case "boolean":
      choices = [
        { label: "Yes", description: "Yes", value: true },
        { label: "No", description: "No", value: false },
      ];
      break;
    case "array":
      choices = choicesFromArrayItems(property.items);
      multiSelect = true;
      break;
    default:
      choices = undefined;
      break;
  }
  if (!choices || choices.length === 0) {
    return undefined;
  }

  return {
    key,
    question: {
      id: key,
      header,
      question: questionText,
      multiSelect,
      options: choices.map((choice) => ({
        label: choice.label,
        description: choice.description,
      })),
    },
    choices,
    multiSelect,
    required: input.required,
  };
}

/**
 * Parses a form elicitation into T3 question fields. Returns `undefined`
 * when the form contains any property T3's option dialog cannot represent.
 */
export function parseOmpElicitationForm(
  request: EffectAcpSchema.ElicitationRequest,
): ReadonlyArray<OmpElicitationField> | undefined {
  if (!isFormElicitationRequest(request)) {
    return undefined;
  }
  const properties = Object.entries(request.requestedSchema.properties ?? {});
  if (properties.length === 0) {
    return undefined;
  }
  const required = request.requestedSchema.required ?? [];
  const formTitle = request.requestedSchema.title?.trim() || undefined;
  const fields: Array<OmpElicitationField> = [];
  for (const [key, property] of properties) {
    const field = fieldFromProperty({
      key,
      property,
      formTitle,
      message: request.message,
      required: required.includes(key),
    });
    if (!field) {
      return undefined;
    }
    fields.push(field);
  }
  return fields;
}

function selectedChoiceValues(
  field: OmpElicitationField,
  answer: unknown,
): ReadonlyArray<string | boolean> {
  const rawValues = Array.isArray(answer) ? answer : [answer];
  const labels = rawValues.flatMap((entry) =>
    typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
  );
  return labels.flatMap((label) => {
    const choice = field.choices.find(
      (candidate) => candidate.label === label || candidate.description === label,
    );
    return choice ? [choice.value] : [];
  });
}

/**
 * Encodes user answers back into an elicitation accept response. Returns
 * `undefined` when a required field has no usable answer, in which case the
 * caller should respond with `cancel`.
 */
export function makeOmpElicitationAcceptedResponse(
  fields: ReadonlyArray<OmpElicitationField>,
  answers: ProviderUserInputAnswers,
): EffectAcpSchema.ElicitationResponse | undefined {
  const content: Record<string, string | boolean | ReadonlyArray<string>> = {};
  for (const field of fields) {
    const values = selectedChoiceValues(field, answers[field.key]);
    if (values.length === 0) {
      if (field.required) {
        return undefined;
      }
      continue;
    }
    if (field.multiSelect) {
      content[field.key] = values.flatMap((value) => (typeof value === "string" ? [value] : []));
    } else {
      content[field.key] = values[0]!;
    }
  }
  return { action: { action: "accept", content } };
}

export function makeOmpElicitationCancelledResponse(): EffectAcpSchema.ElicitationResponse {
  return { action: { action: "cancel" } };
}
