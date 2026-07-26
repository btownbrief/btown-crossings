# Btown Crossings — agent instructions

Shared brain for any AI agent working in this repo (Codex, Claude Code, etc.).
Read `README.md` first for the rules and architecture — this file adds the
rules an agent needs. Stephen is non-technical — explain consequential
changes in plain language.

## What this is

An original crossword-tile board game for Btown Games, Burlington-themed.
Plain static site, **no build step**: `index.html` + `style.css` + ES modules
in `js/`. Deployed by GitHub Pages via `.github/workflows/deploy.yml` on push.
No backend, no accounts, no analytics.

## The one non-negotiable

**Every rule of the game lives in `js/engine.js` and nowhere else.** It's
pure functions over one JSON-serializable state object: `createInitialState`,
`legalMoves`/`checkPlacement`, `applyMove` (returns a NEW state, never
mutates), `getStatus`. It imports nothing and never touches the DOM, timers,
`Date`, or `Math.random` — the bag shuffle runs on a seeded RNG whose state
lives inside the game state, and dictionary lookups arrive as an injected
`isWord` function. A game must survive `JSON.stringify` → `JSON.parse` →
resume.

Why: online multiplayer gets bolted on later by syncing that exact state
object between phones. Rule logic in `main.js` or `bot.js` silently breaks
that plan. `js/bot.js` may only call the engine's public API; `js/main.js`
is UI only.

## Rules that will trip you up

- **Do not copy Scrabble's expression.** The tile counts, point values, and
  premium-square layout in `engine.js` are original designs and must stay
  that way — the test suite has guard assertions. The README explains what's
  protected and what isn't; keep it true.
- **`data/words.txt` is the vendored public-domain ENABLE list.** Bulk data,
  not logic — don't reformat, dedupe, or "clean" it; everyone's boards
  depend on it byte-for-byte.

## Before you finish

Run `node scripts/test-engine.mjs` — plain Node, no framework, must pass.
If you touched the engine or bot, add assertions for the new behavior. If
you touched the UI, load the game at a phone-sized viewport and play a few
turns (pass-and-play AND vs SKIP, including a drag, a blank, and a swap),
or clearly say you couldn't and what you inspected instead. Say what you
verified.
