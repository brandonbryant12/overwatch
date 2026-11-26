# Design philosophy

Overwatch is a tool for one engineer. These are the principles it is built on, and what each one rules out.

## True by construction

A guarantee comes from how the data is shaped: a key, a constraint, one transaction, one sequence. It does not come
from a check placed beside a mechanism, because a check can be forgotten, bypassed or wrong at a seam.

- Counting is a primary key on an occurrence made from the source's own data, inserted "if absent" in the same
  transaction as the checkpoint. *Rules out*: counts derived from lists, caps hidden in code, receipts kept apart.
- One process owns the file through SQLite's own lock. *Rules out*: lock files and guessing whether a pid is alive.
- Order is `events.seq`. *Rules out*: comparing wall-clock times to decide what came first.
- Text can be stored only after redaction, and the writer re-cleans whatever reaches it. *Rules out*: a path where
  an error message or an identifier slips in unredacted.
- A finding cites handles to evidence the service stored and delivered to that attempt. *Rules out*: matching a
  model's quotes against text.

## Limits are declared

Every limit is written down (`docs/customizing.md`). Inside them behaviour is exact; beyond them Overwatch says so
(a lower-bound count, `capped` or `gap` coverage, an overflow row) and keeps going. It never counts wrongly in
silence, never shows healthy when it does not know, and never loses its place.

## Unknown is never healthy

Health is computed from the least-known reading at the moment it is asked, by both the wall and the monotonic clock.
A reading that is missing, failed, capped, cut short or too old prevents quiet; a hung read still ages.

## Code decides; the model interprets

The model never supplies counts, order, identity, quotes, sources or confidence. The trial measures the owner's
model on seeded cases before any automation is turned on.

## Small, and nothing to install

One process, one file, Node's standard library, no build step. About 5,000 lines for the service. A fork can read
all of it.
