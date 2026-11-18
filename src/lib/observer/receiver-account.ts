import { z } from "zod";

export const optionalMaskedAccountSuffixSchema = z.preprocess(
  (value) => (value === "" ? null : value),
  z
    .string()
    .length(4)
    .regex(/^[0-9]{4}$/, "Enter exactly the last four digits, or leave blank.")
    .nullable()
    .optional(),
);
