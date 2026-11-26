# Overwatch Design Language

> **Historical implementation paths.** This guide was written for an earlier build (Foldkit, `web/src/`, a build
> script and `web/dist/`). None of those exist now. The visual guidance (tokens, states, type, spacing, motion, logo,
> keyboard map) is current and is what the page uses; where this guide names a file or a framework, read the current
> place instead: tokens in `web/tokens.css`, styles in `web/page.css`, page logic in `web/model.mjs` and
> `web/freshness.mjs` (tested in `test/page.test.ts`), the DOM in `web/app.mjs`, the logo in `web/logo.svg`. The
> keyboard map that holds today is in `docs/using.md`.


Overwatch is one engineer's personal, all-day command center. It is not a marketing product or a multi-tenant SaaS dashboard. Every screen exists to answer two questions in seconds: **what needs my attention right now?** and **what happens when I prompt on what is in focus?**

## 1. Visual Direction: Observatory Control Deck

The visual identity draws from precision technical instruments and nocturnal control rooms: high-contrast dark surfaces calibrated for eight-hour readability, hairline structural grids, tabular numerals, and warm Signal Amber reserved exclusively for **focus, target lock, and primary action**.

- **Night Watch (default dark theme)**: Deep marine obsidian (`#0b0f14` canvas, `#10161f` instrument deck, `#161f2b` elevated controls) paired with luminous off-white primary ink (`#edf2f7`) and calibrated cool-slate secondary ink (`#a8b7ca`, WCAG AA >= 6.4:1).
- **Daylight Chart (light theme)**: Crisp drafting-paper neutral (`#f2f5f8` canvas, `#ffffff` deck, `#edf1f6` recessed wells) paired with deep ink (`#111824`) and muted slate (`#55657c`). Toggled with `t` or the header button, stored in `localStorage`, and initialized from `prefers-color-scheme`.
- **Zero decorative noise**: No marketing hero banners, no pre-heading eyebrows, no nested card-in-card cages, no non-interactive decorative badges, and no fake live indicators. Sections are separated by `1px` hairlines and quiet surface shifts.

## 2. Design Tokens (CSS Custom Properties)

All tokens live in `:root` (Night Watch default) and `[data-theme="light"]` (Daylight Chart) in `web/src/style.css` (historical; now `web/tokens.css`). Every future page and static mock-up uses these exact variable names.

### Surfaces & Borders

| Token | Night Watch (Dark) | Daylight Chart (Light) | Role |
| --- | --- | --- | --- |
| `--bg-canvas` | `#0b0f14` | `#f2f5f8` | Outer page canvas and main focus backdrop |
| `--bg-deck` | `#10161f` | `#ffffff` | Header, inbox rail, prompt dock, structured wells |
| `--bg-elevated` | `#161f2b` | `#f8fafc` | Active segmented options, interactive controls |
| `--bg-well` | `#0c1118` | `#edf1f6` | Recessed inputs, code excerpts, footers |
| `--bg-hover` | `rgba(148, 175, 206, 0.07)` | `rgba(15, 23, 42, 0.045)` | Subtle row and control hover wash |
| `--bg-selected` | `rgba(245, 166, 35, 0.09)` | `rgba(184, 107, 0, 0.085)` | Active focused item highlight |
| `--border-hairline` | `rgba(148, 175, 206, 0.14)` | `rgba(15, 23, 42, 0.11)` | Default `1px` structural dividers |
| `--border-strong` | `rgba(148, 175, 206, 0.26)` | `rgba(15, 23, 42, 0.22)` | Inputs, interactive controls, overlays |

### Ink & Brand Accents

| Token | Night Watch (Dark) | Daylight Chart (Light) | Role |
| --- | --- | --- | --- |
| `--ink-primary` | `#edf2f7` | `#111824` | Primary headings, titles, active prose |
| `--ink-secondary` | `#a8b7ca` | `#3c4b60` | Supporting descriptions, metadata values |
| `--ink-muted` | `#7f91a8` | `#55657c` | Timestamps, labels, keyboard hints (WCAG AA compliant) |
| `--ink-inverse` | `#0b0f14` | `#ffffff` | Text on solid `--accent` buttons |
| `--accent` | `#f5a623` | `#b86b00` | Signal Amber: focus reticle, active selection, Send CTA |
| `--accent-bright` | `#ffd166` | `#d97706` | Hover state for primary action and prod focus anchor |
| `--accent-surface` | `rgba(245, 166, 35, 0.13)` | `rgba(184, 107, 0, 0.10)` | Next-check callout and focused ring halo |
| `--accent-border` | `rgba(245, 166, 35, 0.42)` | `rgba(184, 107, 0, 0.42)` | Locked prompt dock border and selected palette hit |
| `--cyan` | `#38d9c0` | `#0b806e` | Phosphor Cyan: code locations, handoffs, logo orbital arcs |
| `--ring` | `#f5a623` | `#b86b00` | Visible `:focus-visible` keyboard focus outline (`2px solid`) |

### Semantic State Roles (Never Colour Alone)

Overwatch obeys the rule **unknown is never shown as healthy**. Every operational state is distinguished by **colour + unique geometric glyph + border/pattern + explicit text label**:

| State | Token | Glyph & Border/Pattern | Used for |
| --- | --- | --- | --- |
| **Failing / Error** | `--state-error` (`#f26461` / `#c52828`) | Chamfered diamond exclamation + solid `2px-3px` left rail | `error` severity, `real` verdict, `failed` run, failing watcher |
| **Needs me / Warning** | `--state-warn` (`#f5a623` / `#a65f00`) | Upward triangle + solid amber rail / clock icon for `queued` | `warn` severity, `queued` prompts, capacity warnings |
| **Healthy / Verified** | `--state-ok` (`#2dd4a0` / `#0a7252`) | Solid check-circle + solid teal border | Verified citations, `answered` prompts, `not real` verdict, connected OpenCode, healthy watcher |
| **Active / Running** | `--state-active` (`#38bdf8` / `#0369a1`) | Concentric orbital ring (slow rotation when motion allowed) | `sent` / running investigation, active rollout, `info` severity |
| **Unknown / Unverifiable** | `--state-unknown` (`#a2b0c3` / `#4b5a70`) | **Diagonal hatch (`--hatch-unknown`) + dashed border + dashed `?` circle** | Unverifiable citations, `unsure` verdict, `notChecked` gaps, `held` triage, unchecked watcher, coverage gap |
| **Suspended / Offline** | `--state-suspended` (`#e0915c` / `#9a4a1a`) | Slashed circle + dashed border (`border-style: dashed`) | Disconnected OpenCode, suspended connection, paused watcher |

## 3. Typography

Zero external fonts are loaded at runtime. Overwatch uses two native system stacks:

- `--font-sans`: `ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif`
- `--font-mono`: `ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace` (strictly for log samples, `kubectl` queries, IDs, code locations, timestamps, and `<kbd>` keycaps)

Strict 4-step dense dashboard type scale (header SVG wordmark exempt):

| Token | Size | Use |
| --- | --- | --- |
| `--text-lg` | `1.125rem` (18px) | Focused incident `<h2>`, dialog sheet titles (`font-weight: 650`, `letter-spacing: -0.02em`) |
| `--text-md` | `0.9375rem` (15px) | Section headings (`<h3>`), root-cause summary, prompt bar input |
| `--text-base` | `0.875rem` (14px) | Body prose (`max-width: 65-72ch`), inbox row titles, prompts, lists |
| `--text-sm` | `0.8125rem` (13px) | Metadata, timestamps, citations, segmented controls, table headers (never smaller than 13px above the fold) |

Rules:
- Use **sentence case** for UI labels and headers (never tracked-out `ALL CAPS` kickers).
- Always apply `font-variant-numeric: tabular-nums` to counts, timestamps, latencies, and resource usage.

## 4. Spacing, Density & Motion

- **4px base scale**: `--space-1` (4px) through `--space-6` (24px).
- **Split-deck geometry**: Single-line `52px` top command bar; fixed `380px` left inbox rail (`minmax(320px, 380px)`) paired with a fluid focus stage and docked prompt bar. On narrow screens (`<= 860px`), collapses cleanly into a stacked view with a sticky bottom prompt bar.
- **Calibrated motion**: Interactive transitions are brisk (`--dur-fast: 140ms`, `--dur-med: 200ms`) using `--ease-out: cubic-bezier(0.22, 1, 0.36, 1)`. Transitions always name explicit properties (never `transition: all`). Only active running indicators (`sent`) animate continuously, and `@media (prefers-reduced-motion: reduce)` collapses all animations and transitions immediately.

## 5. Logo & Brand Assets

The Overwatch mark is the **Sentinel Reticle**: a chamfered octagonal housing enclosing broken phosphor-cyan orbital scan arcs, a luminous optical aperture, and a Signal Amber focus diamond with crosshair cuts.

Committed vector assets (pure hand-authored SVG, zero raster images, zero embedded fonts):

- Favicon (`16px-64px`): `web/src/favicon.svg` (copied to `web/dist/favicon.svg` by `scripts/build-web.ts`)
- Standalone mark (`128px`): `docs/design/logo-mark.svg`
- Full geometric lockup (`384x64`): `docs/design/logo-lockup.svg`
- Inline Foldkit components (historical): `logoMark` and `logoWordmark` in `web/src/icons.ts`

Usage rules:
- Keep clear space of at least 25% of the mark's width around the octagon.
- At `16px-24px`, use the simplified favicon geometry (no dashed inner calibration ring).
- In the app header, pair the `28px` mark with the inline SVG geometric wordmark; the wordmark automatically adapts its stroke via `--ink-primary` and dot via `--accent` across Night Watch and Daylight Chart themes.

## 6. Component Patterns

- **Connected segmented controls** (`.segmented`, `role="radiogroup"`): Used for mutually exclusive filters (`All` / `Prod` / `Pre-prod`), sort orders (`Priority` / `Recent`), and Never's optional reason (`noise` / `expected` / `duplicate`). The prompt bar has no session picker: the routing preview says where a prompt goes, and Shift+Enter (hinted beside Send) sends in a new session. Never use a wall of separate bordered buttons for mode selection.
- **Inbox groups** (`.inbox-group`): `Needs you` (its title in `--accent`), `Working`, `New`, `Quiet`, each with a count; Working and Quiet are collapsed toggles (`aria-expanded`). Rows never move while visible: what arrives waits behind the group's `.pending-line` (`N new · r to show`, on `--accent-surface` with a dashed top border).
- **Inbox row** (`.inbox-item`): `3px` left semantic rail, 2-line clamped title, single monospace `app / environment` metadata line, a `why` line in Needs you (`.item-why`, accent when it came back), optional concise verdict line, and hover/focus-revealed Done / Later / Never glyph buttons (`.item-way-btn`) with `propagation: "Stop"`. A Done that keeps coming back adds `.bounce-offer` with its two one-key choices.
- **Cause row** (`.cause-item`): a dashed `--state-suspended` rail on the unknown hatch, the slashed-circle glyph, the cause in words, and its fix as a monospace `.cause-fix` well.
- **Way-out sheets** (`.way-sheet`): Later's single input with its grammar spelled out in the label and errors in `--state-error`; Never's preview of what it would have hidden on a `--state-warn` rail, the reason chips, and one amber primary button. The muted list (`.muted-sheet`) lists each muted row with its reason, hidden count this week, last hidden time and Undo.
- **Citation block** (`.citation`): Quotes labelled `Exact quote matched` use a recessed `--bg-well` box with a solid `--state-ok` left rail; `Not matched` quotes use `--hatch-unknown` diagonal stripes, dashed border, and dashed `?` icon so unverified claims never resemble verified facts.
- **Docked Prompt Bar** (`.prompt-dock`): Locked visually to the focused subject with an amber top border (`--accent-border`) and focus chip (`⌖ app/env · title`). Always displays the deterministic routing preview from `routePrompt()` before sending, plus an explicit notice when OpenCode is offline.
- **Overlays** (`.overlay-backdrop` + `.search-palette` / `.status-sheet` / `.shortcuts-sheet`): Native dialog semantics (`role="dialog"`, `aria-modal="true"`), dismissible via `Escape` or backdrop click.

## 7. Keyboard Map

(Historical wiring; the current map is in `docs/using.md`.) All shortcuts were wired declaratively through Foldkit's `Dom.streamFromKeyBindings` and suppressed automatically while typing in inputs (except `Escape`, `Mod+K`, and search palette navigation):

| Key | Action |
| --- | --- |
| `j` / `ArrowDown` | Focus the next row as shown (collapsed groups are skipped until opened) |
| `k` / `ArrowUp` | Focus the previous row as shown |
| `d` | Done: dealt with; comes back if it happens again. Advances focus |
| `l` | Later: opens the sheet (`2h`, `tomorrow`, `monday`, `worse`, or empty for until something changes) |
| `w` | Later until it gets worse, in one key |
| `n` | Never: opens the sheet with what it would have hidden and the optional reason |
| `u` | Undo the last way out, or put back the incident in focus if it has left the inbox |
| `r` | Show the rows waiting behind the `N new` lines, sorted |
| `m` | Open the muted list |
| `p` / `Enter` | Focus the prompt bar for the currently focused incident |
| `Shift+Enter` (in the prompt bar) | Send in a new session instead of where the preview says |
| `/` or `⌘K` (`Ctrl+K`) | Open Search palette (incidents wherever they went, findings, prompts) |
| `1` / `2` / `3` | Filter inbox: All / Prod / Pre-prod |
| `t` | Toggle Night Watch / Daylight Chart theme |
| `?` | Toggle keyboard shortcuts reference |
| `Esc` | Close active overlay or sheet, or blur the prompt bar |

## 8. Adding a New Page (Phase 1B & Phase 2+)

When building the planned pages (Fleet, Environment detail, Connections, Command Palette with arbitrary focus targets), follow these rules:

1. **Reuse `:root` tokens verbatim** from `web/src/style.css` (mirrored in `docs/design/mockups/tokens.css`). Do not introduce one-off hex colors.
2. **Keep every object focusable**: Any row, pod tile, connection, or metric window must carry a typed reference so clicking or pressing `p` locks it into the docked Prompt Bar's Focus Chip.
3. **Never fake a healthy state**: Suspended connections, coverage gaps, missing metrics, or unverified claims MUST use `--hatch-unknown` or dashed `--state-suspended` styling with explicit text explaining since when it was last checked.
4. **Keep view logic separate from styling**: Add state and pure selectors to `web/src/app.ts` (tested in `test/page.test.ts`), pure HTML builders to `web/src/views.ts`, inline SVG glyphs to `web/src/icons.ts`, and styles only to `web/src/style.css`.
5. **Reference the static mock-ups** in `docs/design/mockups/`:
   - `fleet.html`: Apps by environment tier
   - `environment.html`: Pods by revision, CPU/memory against limits, rollout status
   - `inbox-decisions.html`: An early mock-up of grouped decisions; the built inbox (groups, three ways out, muted list) supersedes it
   - `connections.html`: Healthy, rate-limited, and suspended connections with fix commands
   - `command-palette.html`: Search and command palette with arbitrary focus chip ("prompt on this")
