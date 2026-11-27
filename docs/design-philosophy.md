# Design philosophy

Overwatch is a tool for one engineer. These are the principles it is built on, and what each one rules out.

## True by construction

A guarantee comes from how the data is shaped: a key, a constraint, one transaction, one sequence. It does not come
from a check placed beside a mechanism, because a check can be forgotten, bypassed or wrong at a seam.

- Counting is a primary key on an occurrence made from the source's own data, inserted "if absent" in the same
  transaction as the checkpoint, and only a record whose key is not yet stored is charged against a limit. *Rules
  out*: counts derived from lists, caps hidden in code, receipts kept apart, a replay crowding out a fresh record.
- Every window of event time is one half-open interval type. *Rules out*: two slices both claiming a boundary record,
  an overlap reaching into time declared missing.
- A value from outside is read by one tolerant reader that returns "not measured" as its own value, and a measurement
  is one type, measured or not. *Rules out*: a missing or overflowing value becoming a measured zero, false or epoch.
- A rule that must hold for every write lives where every write passes: the admission guard in `Store.tx`, the
  references in the schema, the one interval function. *Rules out*: a new call site that forgets the rule.
- Exactness travels with the total: an occurrence records its problem, so a loss found later marks that total a
  lower bound in the same transaction. *Rules out*: an exact total over a window with a known gap.
- An approval is a fact about the model that earned it, and is keyed by it. *Rules out*: one model's trial
  approving another.
- A deadline is a number on the service's own clock that every waiter shares. *Rules out*: a slot held for as long
  as a peer chooses not to answer.
- One process owns the file through SQLite's own lock. *Rules out*: lock files and guessing whether a pid is alive.
- Order is `events.seq`. *Rules out*: comparing wall-clock times to decide what came first.
- Text can be stored only after redaction, and the writer re-cleans whatever reaches it. *Rules out*: a path where
  an error message or an identifier slips in unredacted.
- A finding cites handles to evidence the service stored and delivered to that attempt. *Rules out*: matching a
  model's quotes against text.

## Limits are declared

Every limit is written down (`docs/customizing.md`). Inside them, where every reading was fully measured, counts are
exact; beyond them, or where a reading was not, Overwatch says so (a lower-bound count, `capped` or `gap` coverage,
an overflow row) and keeps going. It does not claim an exact count over a window it knows it missed, never shows
healthy when it does not know, and never loses its place. One thing no count can see: identical log lines silently
replaced by identical lines.

## Unknown is never healthy

Health is computed from the least-known reading at the moment it is asked, by both the wall and the monotonic clock.
A reading that is missing, failed, capped, cut short or too old prevents quiet; a hung read still ages. It reflects
what is measured to be active now: a problem whose measurements have recovered does not hold it in `attention`.

## Code decides; the model interprets

The model never supplies counts, order, identity, quotes, sources or confidence. The trial measures the owner's
model on seeded cases before any automation is turned on. When local GPU inference makes tokens free (such as GLM 5.3
under OpenCode), Overwatch spends them on independent angles (up to five readings plus a challenger), deeper evidence
reads, and structured visual lenses — never on relaxing verification gates.

## Static truth, declarative lenses

Health clocks, frozen inbox rows, triage buttons, adjudicated counts, evidence handles, and fix publication gates are
static deterministic chrome: they never shift unpredictably or depend on a model. Inside the inspection stage,
declarative GenUI visual lenses (`LensSpec`, see [genui.md](genui.md)) replace prose walls with scannable causal
chains, slow-span waterfalls, metric shifts, and commit-risk cards. The model emits schema-validated JSON citing stored
handles — never raw HTML or scripts — and both server and client verify every handle before rendering.

## Autonomy inside hard walls

Human-in-the-loop (`fixes.mode: "propose"`, default) stops at a sandbox-verified candidate and waits for `Shift-P`.
Human-on-the-loop (`fixes.mode: "draft_pr"`, explicit per-app opt-in) runs the exact same permit-gated,
branch-protection-checked, outbound-scrubbed pipeline to open a `--draft` pull request automatically once every
eligibility rule and policy-bound `trial --fixes` gate passes. Merging is never automated. And when a problem calls
for open-ended engineering work, Overwatch hands off cleanly (`o`, `c`, `Shift+O`, and owner MCP tools) into the
owner's own interactive OpenCode session with exact SHAs, handles, and commands.

## Small, and built on one library

One process, one file, and one library: Effect. Services are layers, failures are typed, every value from outside is
decoded by a schema, and the database, programs, HTTP, MCP and the command line are Effect's own modules rather than
hand-written ones, so there is less of ours to read. The service has no build step; only the page is bundled. At most 5,500 lines for the service (5,000 until fixes and forecasting arrived in milestone 4). A fork can read
all of it.
