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

## Online play (the rooms layer)

`js/rooms.js` is the fleet's vendored online-multiplayer client — the
canonical copy lives in `four-in-a-rowboat`; copy it here verbatim. It talks
to the shared Supabase rooms backend
(`btownbrief.github.io/supabase/rooms-2026-07-30.sql`): a room is a 4-letter
code + the entire engine state as opaque JSON + a version number. After your
move you push the new state with the version you last saw; everyone else
polls. All rules stay in `engine.js` — `rooms.js` knows nothing about this
game. Seat index is engine player index: the host is seat/player 0, which is
the player `createInitialState()` has moving first, and the joiner is
seat/player 1.

Crossings has hidden racks and a seeded shared bag. Online, render only this
phone's seat rack and never render the opponent rack or bag contents. Never
show the pass-and-play handoff screen online, and gate tile drag starts as
well as buttons to this phone's turn.

`scripts/rooms-shim.mjs` is the verbatim local backend stand-in from
`four-in-a-rowboat`, so everything is testable offline:
`scripts/test-rooms.mjs` drives the real client + engine through a full online
game against it. If the backend SQL is not installed yet, clients get a clean
`not_ready` error and the UI says online play is not switched on.

## Before you finish

Run `node scripts/test-engine.mjs` — plain Node, no framework, must pass.
If you touched `rooms.js`, `main.js`'s online section, or the shim, also run
`node scripts/test-rooms.mjs`.
If you touched the engine or bot, add assertions for the new behavior. If
you touched the UI, load the game at a phone-sized viewport and play a few
turns (pass-and-play AND vs SKIP, including a drag, a blank, and a swap),
or clearly say you couldn't and what you inspected instead. Say what you
verified.
