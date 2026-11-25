/**
 * Test harness on Node's built-in runner: `describe`, `test`, `afterAll` and a small `expect`.
 * Nothing here needs a package, so the tests run with a plain `node --test`.
 */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

export { describe, test };
export const afterAll = after;

/** Drops `undefined` properties so `{ a: 1, b: undefined }` equals `{ a: 1 }`, as test authors expect. */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, plain(v)]),
    );
  }
  return value;
}

function equal(a: unknown, b: unknown): boolean {
  try {
    assert.deepStrictEqual(plain(a), plain(b));
    return true;
  } catch {
    return false;
  }
}

/** True when every property of `expected` is in `actual`, recursively. Arrays must match in length. */
function subset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => subset(actual[i], item));
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object") return false;
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
      subset((actual as Record<string, unknown>)[key], value),
    );
  }
  return equal(actual, expected);
}

const show = (value: unknown) => {
  try {
    const text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value, null, 1);
    return text === undefined ? String(value) : text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
  } catch {
    return String(value);
  }
};

function thrownMatches(error: unknown, expected?: string | RegExp): boolean {
  if (expected === undefined) return true;
  const message = error instanceof Error ? error.message : String(error);
  return typeof expected === "string" ? message.includes(expected) : expected.test(message);
}

function matchers(actual: any, negate: boolean) {
  const check = (pass: boolean, what: string, expected?: unknown) => {
    if (pass === negate) {
      assert.fail(`expected ${show(actual)} ${negate ? "not " : ""}${what}${expected === undefined ? "" : ` ${show(expected)}`}`);
    }
  };
  return {
    toBe: (expected: unknown) => check(Object.is(actual, expected), "to be", expected),
    toEqual: (expected: unknown) => check(equal(actual, expected), "to equal", expected),
    toMatchObject: (expected: unknown) => check(subset(actual, expected), "to match object", expected),
    toContain: (expected: unknown) =>
      check(typeof actual === "string" ? actual.includes(String(expected)) : Array.isArray(actual) && actual.some((item) => Object.is(item, expected)), "to contain", expected),
    toHaveLength: (expected: number) => check(actual?.length === expected, `to have length ${expected}, got ${actual?.length};`),
    toMatch: (expected: RegExp | string) =>
      check(typeof expected === "string" ? String(actual).includes(expected) : expected.test(String(actual)), "to match", String(expected)),
    toStartWith: (expected: string) => check(typeof actual === "string" && actual.startsWith(expected), "to start with", expected),
    toBeUndefined: () => check(actual === undefined, "to be undefined"),
    toBeDefined: () => check(actual !== undefined, "to be defined"),
    toBeLessThan: (expected: number) => check(actual < expected, "to be less than", expected),
    toBeGreaterThan: (expected: number) => check(actual > expected, "to be greater than", expected),
    toBeCloseTo: (expected: number, digits = 2) => check(Math.abs(actual - expected) < 10 ** -digits / 2, "to be close to", expected),
    toThrow: (expected?: string | RegExp) => {
      let thrown: unknown;
      let threw = false;
      try {
        actual();
      } catch (error) {
        threw = true;
        thrown = error;
      }
      check(threw && thrownMatches(thrown, expected), `to throw${threw ? `; it threw ${show(thrown instanceof Error ? thrown.message : thrown)}` : "; it did not throw"}`, expected);
    },
  };
}

export function expect(actual: unknown) {
  return {
    ...matchers(actual, false),
    not: matchers(actual, true),
    rejects: {
      toThrow: async (expected?: string | RegExp) => {
        let thrown: unknown;
        let threw = false;
        try {
          await actual;
        } catch (error) {
          threw = true;
          thrown = error;
        }
        if (!threw) assert.fail(`expected the promise to reject${expected === undefined ? "" : ` with ${show(String(expected))}`}; it resolved`);
        if (!thrownMatches(thrown, expected)) {
          assert.fail(`expected the rejection to match ${show(String(expected))}; got ${show(thrown instanceof Error ? thrown.message : thrown)}`);
        }
      },
    },
  };
}

/** Parses JSON with comments and trailing commas, as OpenCode config files allow. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      out += char;
      if (char === "\\") out += text[++i] ?? "";
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}
