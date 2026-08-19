import { describe, expect, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  makeOmpElicitationAcceptedResponse,
  makeOmpElicitationCancelledResponse,
  parseOmpElicitationForm,
} from "./OmpAcpElicitation.ts";

const sessionId = "omp-session-1";

function formRequest(
  requestedSchema: Extract<
    EffectAcpSchema.ElicitationRequest,
    { readonly mode: "form" }
  >["requestedSchema"],
  message = "Ready to run this plan?",
): EffectAcpSchema.ElicitationRequest {
  return { mode: "form", sessionId, message, requestedSchema };
}

const decisionProperty: EffectAcpSchema.ElicitationPropertySchema = {
  type: "string",
  title: "Plan decision",
  description: "Approve the plan or send it back for refinement.",
  oneOf: [
    { const: "approve", title: "Approve and execute" },
    { const: "refine", title: "Refine plan" },
  ],
};

const planApprovalRequest = formRequest({
  type: "object",
  title: "Plan approval",
  properties: { decision: decisionProperty },
  required: ["decision"],
});

describe("parseOmpElicitationForm", () => {
  it("maps omp's plan-approval form to a single question with two options", () => {
    const fields = parseOmpElicitationForm(planApprovalRequest);
    expect(fields).toHaveLength(1);
    const field = fields![0]!;
    expect(field.key).toBe("decision");
    expect(field.required).toBe(true);
    expect(field.multiSelect).toBe(false);
    expect(field.question).toEqual({
      id: "decision",
      header: "Plan decision",
      question: "Approve the plan or send it back for refinement.",
      multiSelect: false,
      options: [
        { label: "Approve and execute", description: "approve" },
        { label: "Refine plan", description: "refine" },
      ],
    });
  });

  it("maps a boolean confirm to Yes/No options", () => {
    const fields = parseOmpElicitationForm(
      formRequest(
        {
          type: "object",
          properties: { confirm: { type: "boolean", title: "Confirm" } },
          required: ["confirm"],
        },
        "Overwrite the existing file?",
      ),
    );
    expect(fields).toHaveLength(1);
    const field = fields![0]!;
    expect(field.multiSelect).toBe(false);
    expect(field.question.header).toBe("Confirm");
    expect(field.question.question).toBe("Overwrite the existing file?");
    expect(field.question.options).toEqual([
      { label: "Yes", description: "Yes" },
      { label: "No", description: "No" },
    ]);
  });

  it("maps enum arrays to multi-select questions", () => {
    const fields = parseOmpElicitationForm(
      formRequest({
        type: "object",
        properties: {
          targets: {
            type: "array",
            title: "Targets",
            items: { type: "string", enum: ["web", "mobile", "server"] },
          },
        },
      }),
    );
    expect(fields).toHaveLength(1);
    const field = fields![0]!;
    expect(field.required).toBe(false);
    expect(field.multiSelect).toBe(true);
    expect(field.question.multiSelect).toBe(true);
    expect(field.question.options.map((option) => option.label)).toEqual([
      "web",
      "mobile",
      "server",
    ]);
  });

  it("rejects forms containing free-text string properties", () => {
    expect(
      parseOmpElicitationForm(
        formRequest({
          type: "object",
          properties: { name: { type: "string", title: "Name" } },
        }),
      ),
    ).toBeUndefined();
  });

  it("rejects a form when any single property is unrepresentable", () => {
    expect(
      parseOmpElicitationForm(
        formRequest({
          type: "object",
          properties: {
            decision: decisionProperty,
            count: { type: "number", title: "Count" },
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("rejects forms with no properties", () => {
    expect(
      parseOmpElicitationForm(formRequest({ type: "object", properties: {} })),
    ).toBeUndefined();
    expect(parseOmpElicitationForm(formRequest({ type: "object" }))).toBeUndefined();
  });
});

describe("makeOmpElicitationAcceptedResponse", () => {
  const planFields = parseOmpElicitationForm(planApprovalRequest)!;

  it("maps the selected option label back to its const value", () => {
    expect(
      makeOmpElicitationAcceptedResponse(planFields, { decision: "Approve and execute" }),
    ).toEqual({
      action: { action: "accept", content: { decision: "approve" } },
    });
  });

  it("matches answers by description (const) when the label convention differs", () => {
    expect(makeOmpElicitationAcceptedResponse(planFields, { decision: "refine" })).toEqual({
      action: { action: "accept", content: { decision: "refine" } },
    });
  });

  it("returns undefined when a required answer is missing or unusable", () => {
    expect(makeOmpElicitationAcceptedResponse(planFields, {})).toBeUndefined();
    expect(
      makeOmpElicitationAcceptedResponse(planFields, { decision: "not-a-choice" }),
    ).toBeUndefined();
  });

  it("skips optional fields without answers instead of failing", () => {
    const fields = parseOmpElicitationForm(
      formRequest({
        type: "object",
        properties: {
          decision: {
            type: "string",
            oneOf: [{ const: "approve", title: "Approve" }],
          },
        },
      }),
    )!;
    expect(makeOmpElicitationAcceptedResponse(fields, {})).toEqual({
      action: { action: "accept", content: {} },
    });
  });

  it("encodes boolean Yes answers as true and No as false", () => {
    const fields = parseOmpElicitationForm(
      formRequest({
        type: "object",
        properties: { confirm: { type: "boolean" } },
        required: ["confirm"],
      }),
    )!;
    expect(makeOmpElicitationAcceptedResponse(fields, { confirm: "Yes" })).toEqual({
      action: { action: "accept", content: { confirm: true } },
    });
    expect(makeOmpElicitationAcceptedResponse(fields, { confirm: "No" })).toEqual({
      action: { action: "accept", content: { confirm: false } },
    });
  });

  it("encodes multi-select answers as string arrays", () => {
    const fields = parseOmpElicitationForm(
      formRequest({
        type: "object",
        properties: {
          targets: {
            type: "array",
            items: { type: "string", enum: ["web", "mobile", "server"] },
          },
        },
        required: ["targets"],
      }),
    )!;
    expect(
      makeOmpElicitationAcceptedResponse(fields, { targets: ["web", "server", "bogus"] }),
    ).toEqual({
      action: { action: "accept", content: { targets: ["web", "server"] } },
    });
  });
});

describe("makeOmpElicitationCancelledResponse", () => {
  it("responds with a cancel action", () => {
    expect(makeOmpElicitationCancelledResponse()).toEqual({ action: { action: "cancel" } });
  });
});
