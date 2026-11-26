import "./scratch.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { clean, cleanDeep, truncate } from "../src/redact.ts";

const SECRET = "TrainingOnly482910";
const SHAPES = [
  "Authorization: Bearer " + SECRET,
  "postgres://user:" + SECRET + "@db.invalid/shop",
  "Set-Cookie: session=" + SECRET,
  "-----BEGIN PRIVATE KEY-----\n" + SECRET + "\n-----END PRIVATE KEY-----",
  '{"client_secret":"' + SECRET + '"}',
  "password=" + SECRET,
  "api_key: " + SECRET,
  "token=" + SECRET,
];

test("every shape in the documented family loses its secret", () => {
  for (const shape of SHAPES) assert.ok(!clean(shape).includes(SECRET), shape);
  for (const key of ["AKIA" + "1234567890123456", "ghp_" + "a".repeat(36), "xoxb-1234567890123", "sk-" + "0f".repeat(18), "eyJhbGciOiJIUzI1.eyJzdWIiOjEyMzQ1.c2lnbmF0dXJlMTIz"])
    assert.ok(!clean(`value ${key} here`).includes(key), key);
});

test("prose and identifiers Overwatch generates are left alone", () => {
  for (const text of ["the token expired; password reset required", "e_0123456789abcdef01234567", "inc_" + "ab".repeat(16), "3f2a9c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b"])
    assert.equal(clean(text), text);
});

test("cleaning is idempotent, so stored text survives a restore unchanged", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), fc.constantFrom(...SHAPES, ""), (prefix, shape) => {
      const once = clean(prefix + " " + shape);
      assert.equal(clean(once), once);
    }),
    { numRuns: 500 },
  );
});

test("truncation bounds UTF-8 bytes, never splits a character and says so", () => {
  fc.assert(
    fc.property(fc.string({ unit: "grapheme", maxLength: 3000 }), fc.integer({ min: 20, max: 2000 }), (text, max) => {
      const out = truncate(text, max);
      assert.ok(Buffer.byteLength(out) <= max);
      if (out !== text) assert.match(out, /truncated/);
      assert.ok(!out.includes("�") || text.includes("�"));
    }),
    { numRuns: 300 },
  );
});

test("JSON values are cleaned throughout, keys included", () => {
  const value = cleanDeep({ ["password=" + SECRET]: ["token=" + SECRET, { deep: "Bearer " + SECRET + SECRET }], n: 3 });
  assert.ok(!JSON.stringify(value).includes(SECRET));
  assert.equal((value as { n: number }).n, 3);
});
