# CLI Design System

**Analysis Date:** 2026-07-18

`src/brand.ts` is the single visual source of truth. Every cockpit surface — fleet,
doctor, status, run, report — styles through its tokens, glyphs, and helpers. Nothing
hand-rolls ANSI outside it.

Everything below is TTY-gated: styled only when stdout is a real TTY **and** `NO_COLOR`
is unset. Otherwise every token and helper returns the plain unstyled text, so non-TTY
surfaces stay byte-pinned and machine-consumable.

## Hierarchy rules

1. **Chrome dim** — legends, rules, parentheticals, section labels, inactive state.
2. **Data plain** — values, names, paths carry no styling; alignment does the work.
3. **Selection and verdicts emphasized** — the cursor row is bold, verdict glyphs are
   colored, the title line is bold. Nothing else competes.
4. **One visual voice per frame** — a frame is title → legend → rule → rows; one
   dominant element per frame, no mixed styles on one line class.

## Color as meaning

Color is meaning, never decoration: brand green = ok/pass/authed, red = fail/unauthed,
amber = attention/warn/lint, dim = chrome. A color that doesn't answer a question at a
glance doesn't ship. **Color is never the only signal**: every colored state pairs with
a distinct glyph or word (✓ vs ○ vs ✗ vs ! vs -, authed vs unauthed), so every state
survives `NO_COLOR` and non-TTY byte-pinned output unambiguously.

## Tokens (`TOKENS`)

| Token | Renders | Use |
|---|---|---|
| `brand` | brand green (256-color ramp anchor 41, from `BRAND_RAMP`) | the tickmark hue; the product name accent |
| `ok` | brand green ramp (same hue as `brand`) | pass/authed/green verdict words and glyphs |
| `fail` | red | fail/unauthed verdict words and glyphs |
| `warn` | amber | attention/warn/lint words and glyphs |
| `dim` | dim | all chrome (rules, legends, parentheticals, inactive) |
| `bold` | bold | emphasis: titles, cursor row, product name |

`BRAND_RAMP` (`[84, 78, 41, 35]`, bright → deep) is the settled green ramp the BANNER
draws; `brand`/`ok` anchor on `41`.

## Glyphs (`GLYPHS`)

| Glyph | Char | Use |
|---|---|---|
| `pointer` | `❯` | cursor row in list pickers — one glance answers "where am I" |
| `toggleActive` | `✓` | active/selected toggle — **the brand tickmark, rendered brand green** |
| `toggleInactive` | `○` | inactive toggle — **rendered dim** |
| `pass` | `✓` | pass verdict (rendered `ok`) |
| `fail` | `✗` | fail verdict (rendered `fail`) |
| `attention` | `!` | warn/attention verdict (rendered `warn`) |
| `neutral` | `-` | neutral/skip (rendered `dim`) |

**Toggle mandate (operator ruling 2026-07-18, every surface):** active = the brand
tickmark `✓` rendered in brand green; inactive = the dim circle `○`. The product is
named tickmarkr — the tickmark IS the brand and is always brand-colored.
**Bracket toggle glyphs (`[x]`, `[ ]`, `[!]`) are forbidden** on every surface; rows
are glyph-first: the state glyph leads the row, never boxed, never trailing.
Each verdict keeps a distinct glyph shape so color is never the only signal.

## Helpers

| Helper | Renders | Use |
|---|---|---|
| `toggleActive()` | brand-green `✓` on TTY, plain `✓` otherwise | the one way to draw an active toggle |
| `toggleInactive()` | dim `○` on TTY, plain `○` otherwise | the one way to draw an inactive toggle |
| `title(text)` | bold on TTY, plain otherwise | the dominant title line of a frame |
| `legend(text)` | dim on TTY, plain otherwise | the ONE dim key-hint line under a title |
| `rule(width?)` | dim `─` rule sized to terminal (cap 100 cols) | separates title from body |
| `kvRow(key, value, keyWidth?)` | dim padded key + plain value | aligned key-value rows; padding before styling so columns hold |
| `statusRow(verdict, label)` | verdict glyph **before** the label | one-line verdict rows (`✓ gates green`) |

Every helper above has this documented use; no undocumented helper exists. A frame is
composed as: `title` → `legend` → `rule` → rows (`kvRow` / `statusRow` / toggles).

## Unchanged legacy exports

`BANNER`, `PLAIN_BANNER`, `bannerShell`, `TICKMARKR_EXIT_TRAILER`, `paneDispatchScript`,
`paneDispatchCommand` keep their exact byte-for-byte output — they are byte-pinned by
tests and consumed by machines and the README hero.
