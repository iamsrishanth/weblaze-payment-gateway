import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

export { hashPassword, verifyPassword } from "@/lib/auth/password";

export function fixedTimeStringEqual(candidate: string, expected: string): boolean {
  const candidateHash = createHash("sha256").update(candidate, "utf8").digest();
  const expectedHash = createHash("sha256").update(expected, "utf8").digest();
  const equalHash = timingSafeEqual(candidateHash, expectedHash);
  return equalHash && candidate.length === expected.length;
}
