import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "../src/lib/auth/password";

test("administrator passwords are salted and verified without storing plain text", () => {
  const password = "synthetic-operator-password-2026";
  const encoded = hashPassword(password);

  assert.match(encoded, /^scrypt\$32768\$8\$1\$/);
  assert.notEqual(encoded, password);
  assert.equal(verifyPassword(password, encoded), true);
  assert.equal(verifyPassword("different-password", encoded), false);
  assert.equal(verifyPassword(password, "invalid-hash"), false);
});
