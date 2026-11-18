import { z } from "zod";
import { containsControlCharacters, isUtcDateTime } from "@/lib/observer/validation";
import { MAX_AMOUNT_PAISE, MIN_AMOUNT_PAISE } from "@/lib/server/orders";

const utcDateTime = z.string().refine(isUtcDateTime);

export const publicKeyJwkSchema = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

export const pairDeviceBodySchema = z
  .object({
    pairingCode: z.string().min(12).max(32),
    deviceName: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine((value) => !containsControlCharacters(value)),
    publicKey: publicKeyJwkSchema,
  })
  .strict();

export const observationBodySchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    source: z.enum(["phonepe", "bank_sms"]),
    eventKind: z.enum(["incoming_credit", "reversal"]),
    observedAt: utcDateTime,
    amountPaise: z.number().int().min(MIN_AMOUNT_PAISE).max(MAX_AMOUNT_PAISE),
    currency: z.literal("INR"),
    merchantRef: z.string().max(64).nullable(),
    bankRef: z.string().max(128).nullable(),
    observedPayeeVpa: z.string().max(255).nullable(),
    receiverProfileId: z.string().uuid().nullable(),
    sourceTransactionId: z.string().max(128).nullable(),
    sourceTemplateId: z.string().max(128).nullable(),
  })
  .strict()
  .superRefine((event, context) => {
    if (!isUtcDateTime(event.observedAt) || !Number.isFinite(Date.parse(event.observedAt))) {
      context.addIssue({
        code: "custom",
        path: ["observedAt"],
        message: "observedAt must be a valid UTC timestamp.",
      });
    }
    if (event.merchantRef !== null && !/^WZ[0-9A-F]{24}$/.test(event.merchantRef)) {
      context.addIssue({
        code: "custom",
        path: ["merchantRef"],
        message: "merchantRef must be the exact gateway reference format or null.",
      });
    }
    for (const [key, value] of Object.entries({
      bankRef: event.bankRef,
      sourceTransactionId: event.sourceTransactionId,
      sourceTemplateId: event.sourceTemplateId,
    })) {
      if (value !== null && (value.trim() === "" || containsControlCharacters(value))) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} must be null or printable nonempty text.`,
        });
      }
    }
  });

export const adminLoginSchema = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(1).max(1024),
  })
  .strict();

export const pairingCredentialSchema = z
  .object({
    grantedScopes: z
      .array(z.enum(["observations", "links:create", "links:read_own"]))
      .min(1)
      .max(3)
      .default(["observations"]),
  })
  .strict();

export const grantUpdateSchema = z
  .object({
    grantedScopes: z
      .array(z.enum(["observations", "links:create", "links:read_own"]))
      .min(1)
      .max(3),
  })
  .strict();

export const manualReviewSchema = z
  .object({
    orderId: z.string().uuid(),
    officialBankReference: z.string().trim().min(4).max(128),
    evidenceReference: z.string().trim().min(2).max(256),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

export const reconcileSchema = z
  .object({
    orderId: z.string().uuid(),
    officialBankReference: z.string().trim().min(4).max(128),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();

export const receiverAccountSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    payeeVpa: z.string().trim().min(3).max(255),
    verified: z.literal(true),
    confirmation: z.literal("I checked the receiving account in the bank record."),
  })
  .strict();

export const receiverProfileSchema = z
  .object({
    receiverAccountId: z.string().uuid(),
    deviceId: z.string().uuid(),
    source: z.enum(["phonepe", "bank_sms"]),
    sourceTemplateId: z.string().trim().min(1).max(128).nullable().optional(),
  })
  .strict();
