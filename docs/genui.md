# Static vs. Declarative Generative UI (GenUI)

Overwatch is designed to stay calm over an eight-hour workday. Most observability tools fail at one of two extremes: rigid static tables that force you to read walls of raw prose, or unconstrained AI UIs that inject arbitrary HTML/JS and hallucinate numbers.

Overwatch splits the screen cleanly along a single line: **deterministic static chrome owns truth, state, and authority; declarative GenUI Visual Lenses synthesize scannable pictures strictly from verified evidence handles.**

---

## 1. The Static / Generative Boundary

| Surface | Mode | Why |
| --- | --- | --- |
| **Environment pulse strip & freshness clocks** | **Static deterministic** | Health (`quiet`, `attention`, `partial`, `stale`, `signed_out`) is computed from `ProviderTime` and aged locally every second (`web/freshness.mjs`). Unknown is never shown as healthy. |
| **Inbox groups & frozen row order** | **Static deterministic** | Rows never jump under your cursor while triaging; arrivals stage behind `N new` (`r`). |
| **Triage actions (`d`/`l`/`w`/`n`/`u`) & `basisSeq` fencing** | **Static deterministic** | State transitions commit in one SQLite transaction with conflict detection across tabs. |
| **Adjudicated verdict counts & raw evidence drawer** | **Static deterministic** | `adjudicate()` counts votes in code; evidence text is copied verbatim from SQLite. |
| **Fix diff viewer & `Shift-P` draft PR gate** | **Static deterministic** | Safety-critical diffs, sandbox verification results, and host publication controls never pass through generative rendering. |
| **Visual Lens inside the Focus Stage** | **Declarative GenUI** | Summarizes causality, slow-span waterfalls, before/after metric shifts, risky commits, and event timelines as compact Foldkit SVG/HTML cards instead of prose walls. |

---

## 2. The `LensSpec` Contract

A Visual Lens is **pure JSON data**, never HTML, CSS, or JavaScript. Both the backend (`src/inbox.ts`) and frontend (`web/src/domain/Lens.ts`) decode it with strict `Effect.Schema` validation.

```ts
type LensTone = "neutral" | "warn" | "error" | "ok";
type LensOrigin = "telemetry" | "code" | "history" | "generated";

interface LensSpec {
  source: "ai" | "derived";
  title: string;
  summary: string;
  model?: string;
  generatedAt: number;         // UTC epoch ms
  verifiedHandles: string[];   // evidence handles confirmed in SQLite
  blocks: LensBlock[];
}
```

### The Six Declarative Foldkit Blocks

Each block maps to one hand-crafted, accessible Foldkit component in `web/src/components/VisualLens.ts` using Observatory Control Deck tokens (`web/tokens.css`):

| Block `kind` | Payload Fields | Rendered As | Best For |
| --- | --- | --- | --- |
| `causal_flow` | `title`, `steps: { label, detail, tone, handle? }[]` | Horizontal/vertical step chain with tone rails and clickable handle pills | Deploy -> config change -> symptom -> impact narratives |
| `span_waterfall` | `title`, `p50Ms?`, `slowMs?`, `spans: { label, service, durationMs, offsetMs, status: "ok"\|"slow"\|"error", handle? }[]` | Proportional SVG latency bars with threshold marker and tabular ms figures | Datadog APM slow-span / tail-latency regressions |
| `metric_compare` | `title`, `rows: { label, before, after, beforeNum?, afterNum?, unit?, delta, tone, handle? }[]` | Side-by-side before/after metric comparison bars with delta chip | Config value drops (`3000ms -> 300ms`), pool exhaustion, error-rate jumps |
| `commit_risk` | `title`, `commits: { sha, subject, files, insertions, deletions, flags, deployed, handle? }[]` | Compact commit cards with diffstat (`+N/-M`), risk-flag pills (`config`, `database`, `auth`, `timeout`, `large_diff`), and deployed badge | Correlating newly landed or rolled-out commits with onset |
| `timeline` | `title`, `events: { at, label, kind: "deploy"\|"spike"\|"span"\|"finding"\|"fix", handle? }[]` | Ordered event rail anchored to onset and rollout markers | Sequencing deploy -> first error -> investigation -> candidate fix |
| `key_facts` | `title`, `facts: { label, value, origin, handle? }[]` | Compact 2-column key-value grid carrying explicit evidence origin (`telemetry`, `code`, `history`, `generated`) | At-a-glance facts without reading paragraphs |

---

## 3. Dual Handle Grounding (Zero Invented Facts)

Free local GPU tokens (OpenCode + GLM 5.3) make on-demand AI visual synthesis practically costless, but a model must never invent a quote, metric, or handle. Overwatch enforces grounding twice:

1. **Server verification (`src/inbox.ts` / `POST /v2/items/:id/lens`)**:
   - The service asks OpenCode (spending a committed `Permit`) to return a `LensSpec` JSON citing only handles delivered to that item's frozen evidence set.
   - The reply is decoded with strict `Effect.Schema`. Any malformed output fails closed.
   - Every `handle` cited in `verifiedHandles` and inside `blocks` is checked against SQLite's `evidence` table for that exact item. Unknown or cross-item handles are stripped or rejected; every string passes `Writer` redaction (`cleanDeep`) before persistence in the `lenses` table.
2. **Client verification (`web/src/components/VisualLens.ts` -> `validateLensHandles`)**:
   - Before rendering, the browser verifies every cited handle against the item's loaded `ItemDetail` evidence handles.
   - Clicking a verified handle pill copies the exact handle (`e_...`) for pasting into OpenCode or inspecting the raw evidence drawer.
   - Any block item carrying an unverified handle is visually quarantined using Overwatch's `--hatch-unknown` diagonal stripe + dashed border — consistent with *unknown is never shown as healthy*.

---

## 4. Lifecycle: Instant Derived Lens + On-Demand AI Lens (`g`)

Every incident renders a useful visual lens immediately with zero latency and zero LLM wait:

1. **Deterministic `derived` lens (always available)**:
   - `buildLens()` on the server (and client-side fallback `web/src/lens.ts` if offline or against an older server) synthesizes a `source: "derived"` `LensSpec` straight from SQLite rows: `lines` (including parsed `SLOW <ms>` Datadog spans), `deploys`/`rollouts`, `commits`, `findings`, `investigations`, and `fixes`.
   - Exposed on both `GET /v2/items/:id` and the `ow_get` MCP tool as `lens` (active) and `lenses` (all available, e.g., both `ai` and `derived`).
2. **On-demand `ai` lens (`g` key or "Generate AI lens" button)**:
   - Enabled when OpenCode is connected (and `opencode.genUi: true` for automatic/eager generation).
   - Calls `POST /v2/items/:id/lens` (guarded in `server.ts`'s `WRITES` table) to generate a tailored `source: "ai"` `LensSpec` via your configured model (e.g., `local/glm-5.3`).
   - The Stage header shows a clean toggle pill (`AI Lens · N handles verified` vs `Derived lens`) so you can compare the AI synthesis against the deterministic derivation at any time.
   - If OpenCode is offline, times out, or produces invalid JSON, the UI shows a non-blocking toast and keeps the deterministic `derived` lens intact.

---

## 5. Adding Custom Declarative Blocks in a Corporate Fork

Because `web/` is outside the 5,500-line `src/` service budget, a corporate fork can add domain-specific visual blocks (for example, a queue-depth heatmap or feature-flag rollout matrix) without touching the core kernel:

1. Add the new block variant to `LensBlock` Schema in `web/src/domain/Lens.ts` (and mirror it in `src/inbox.ts` if synthesized server-side).
2. Add a pure Foldkit view function in `web/src/components/VisualLens.ts` using only `web/src/ui.ts` helpers and `web/tokens.css` variables — never `innerHTML`.
3. Thread every handle through `validateLensHandles()` so ungrounded rows fall back to `--hatch-unknown`.
4. Add unit tests in `test/page.test.ts` and rebuild the bundle with `pnpm run build:web`.
