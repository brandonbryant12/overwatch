/**
 * A small model that exercises everything the host must do: commits, rejections, idempotent retries, a view, a
 * policy that calls another aggregate, and a scheduled command. The conformance suite runs it on both hosts.
 */
import * as Domain from "@alchemy.run/domain";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class Deposited extends Domain.Event("Deposited", { amount: Schema.Int, balanceAfter: Schema.Int }) {}
export class Flagged extends Domain.Event("Flagged", { amount: Schema.Int }) {}
export class Reminded extends Domain.Event("Reminded", { note: Schema.String }) {}
export class TooLarge extends Domain.Rejection("TooLarge", { max: Schema.Int }) {}

export class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amount: Schema.Int },
  events: [Deposited],
  rejects: [TooLarge],
  reply: { balance: Schema.Int },
}) {}
export class Flag extends Domain.Command("Flag", { target: Schema.String, input: { amount: Schema.Int }, events: [Flagged] }) {}
export class Remind extends Domain.Command("Remind", { target: Schema.String, input: { note: Schema.String }, events: [Reminded] }) {}

export class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Int, reminders: Schema.Int }),
  initial: { balance: 0, reminders: 0 },
  commands: [Deposit, Remind],
  decide: {
    Deposit: (s, cmd) =>
      cmd.amount > 10_000 ? new TooLarge({ max: 10_000 }) : [new Deposited({ amount: cmd.amount, balanceAfter: s.balance + cmd.amount })],
    Remind: (_, cmd) => [new Reminded({ note: cmd.note })],
  },
  evolve: {
    Deposited: (s, e) => ({ ...s, balance: e.balanceAfter }),
    Reminded: (s) => ({ ...s, reminders: s.reminders + 1 }),
  },
  reply: { Deposit: (s) => ({ balance: s.balance }) },
}) {}

/** Another aggregate, so a policy's command crosses objects. */
export class Audit extends Domain.Aggregate("Audit", {
  id: Schema.String,
  state: Schema.Struct({ flags: Schema.Int }),
  initial: { flags: 0 },
  commands: [Flag],
  decide: { Flag: (_, cmd) => [new Flagged({ amount: cmd.amount })] },
  evolve: { Flagged: (s) => ({ flags: s.flags + 1 }) },
}) {}

export class Summary extends Domain.View("Summary", {
  from: [Account],
  key: Account,
  state: Schema.Struct({ deposits: Schema.Int, total: Schema.Int, reminders: Schema.Int }),
  initial: { deposits: 0, total: 0, reminders: 0 },
  evolve: {
    Deposited: (v, e) => ({ ...v, deposits: v.deposits + 1, total: v.total + e.amount }),
    Reminded: (v) => ({ ...v, reminders: v.reminders + 1 }),
  },
}) {}

export class AuditView extends Domain.View("AuditView", {
  from: [Audit],
  key: Audit,
  state: Schema.Struct({ flags: Schema.Int, amounts: Schema.Array(Schema.Int) }),
  initial: { flags: 0, amounts: [] },
  evolve: { Flagged: (v, e) => ({ flags: v.flags + 1, amounts: [...v.amounts, e.amount] }) },
}) {}

/** Big deposits are flagged on the account's audit, and the account is reminded later. */
export class BigDeposits extends Domain.Policy("BigDeposits", { from: Account, on: [Deposited] }) {}
export const bigDepositsLive = (remindAfter: Duration.Input = "2 seconds") => BigDeposits.toLayer(
  Effect.gen(function* () {
    const audits = yield* Audit;
    const accounts = yield* Account;
    return Effect.fn(function* ({ source, event, envelope }) {
      if (event.amount < 500) return;
      yield* audits.send(Audit.ref(source.id), new Flag({ amount: event.amount }));
      yield* accounts.schedule(source, new Remind({ note: `review ${event.amount}` }), {
        after: remindAfter,
        commandId: `remind-${envelope.stream}-${envelope.seq}`,
      });
    });
  }),
);
export const BigDepositsLive = bigDepositsLive();

export class Ledger extends Domain.Model("Ledger", {
  aggregates: [Account, Audit],
  views: [Summary, AuditView],
  policies: [BigDeposits],
}) {}
export class LedgerApi extends Domain.Api("LedgerApi", { model: Ledger }) {}
