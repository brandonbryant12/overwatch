/**
 * Identifiers that come from outside (a client's prompt id, a command id) are input like any other. They are accepted
 * only in the shape Overwatch issues itself, and only if redaction would leave them unchanged: an identifier is
 * stored verbatim (in the journal, in derived ids), so it cannot carry anything redaction would have removed.
 */
import * as Schema from "effect/Schema";
import { redactText } from "./redact.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

/** Null when the identifier is acceptable; otherwise what is wrong with it, saying what to send instead. */
export function unsafeId(value: string, what: string): string | null {
  if (!ID.test(value)) return `${what} must be 1-128 letters, digits, ":", ".", "_" or "-", starting with a letter or digit`;
  if (redactText(value) !== value) return `${what} looks like it carries a secret; send an opaque id instead`;
  return null;
}

/** A schema for an identifier supplied from outside. */
export const ExternalId = (what: string) => Schema.String.check(Schema.makeFilter((value: string) => unsafeId(value, what) ?? undefined));
