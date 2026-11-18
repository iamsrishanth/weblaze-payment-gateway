import { z } from "zod";

export function isValidSourceTemplateId(value: string): boolean {
  if (value.length < 1 || value.length > 64) return false;
  if (!/^[A-Za-z]/.test(value)) return false;
  if ([...value].some((character) => !/^[A-Za-z0-9._:-]$/.test(character))) return false;
  if ([...value].filter((character) => /^[0-9]$/.test(character)).length > 3) return false;
  return !/[0-9]{4,}/.test(value);
}

export const sourceTemplateIdSchema = z.string().max(64).refine(isValidSourceTemplateId);

export const receiverProfileSourceFields = z.object({
  source: z.enum(["phonepe", "bank_sms"]),
  sourceTemplateId: z.preprocess(
    (value) => (value === undefined || value === "" ? null : value),
    sourceTemplateIdSchema.nullable(),
  ),
});

export function refineReceiverProfileSourceFields(
  value: z.infer<typeof receiverProfileSourceFields>,
  context: z.RefinementCtx,
) {
  if (value.source === "bank_sms" && value.sourceTemplateId === null) {
    context.addIssue({
      code: "custom",
      path: ["sourceTemplateId"],
      message: "A safe, operator-approved sourceTemplateId is required for bank SMS.",
    });
  }
  if (value.source === "phonepe" && value.sourceTemplateId !== null) {
    context.addIssue({
      code: "custom",
      path: ["sourceTemplateId"],
      message: "PhonePe profiles must use a null sourceTemplateId.",
    });
  }
}

export const receiverProfileSourceSchema = receiverProfileSourceFields.superRefine(
  refineReceiverProfileSourceFields,
);
