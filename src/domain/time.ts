import * as DateTime from "effect/DateTime";

/** The time a command is decided at, in epoch milliseconds, from the context `decide` receives. Never the wall clock. */
export const nowMs = (ctx: { readonly now: DateTime.Utc }) => DateTime.toEpochMillis(ctx.now);

/** A command's fields without its tag, to copy into the event that records it. */
export const fieldsOf = <T extends { readonly _tag: string }>({ _tag, ...fields }: T): Omit<T, "_tag"> => fields;
