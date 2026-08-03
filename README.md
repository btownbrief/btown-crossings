# BTOWN CROSSINGS 🍁🔠

An original crossword-building board game set on a map of Burlington —
double your word on **Church Street**, triple a letter on the
**Waterfront**, and empty your rack for the 40-point **Full Bucket**.
Pass the phone around the table with 2–4 players, or take on **SKIP the
Skipper**. Part of [Btown Games](https://play.btownbrief.com), the browser
arcade of the [BTown Brief](https://www.btownbrief.com).

**Play it live:** https://play.btownbrief.com/btown-crossings/

## How it plays

- 15×15 board, racks of 7 tiles, a 100-tile bag (including 2 blanks).
- On your turn, place tiles in one straight line to form one main word
  connected to what's already down. The **first word must cover
  City Hall Park ⭐** (the center square). Every crossing run of 2+
  letters must also be a real word — invalid words simply can't be
  submitted, so there's no challenge rule.
- Or **swap** any number of tiles back into the bag (that's your turn),
  or **pass**.
- Premium squares apply only on the turn they're first covered:

  | square | named for | does |
  | --- | --- | --- |
  | 2L | **North Beach** | doubles a letter |
  | 3L | **Waterfront** | triples a letter |
  | 2W | **Church Street** | doubles the word |
  | 3W | **the Intervale** | triples the word |

- Use all 7 tiles in one turn: **Full Bucket, +40**.
- The game ends when the bag is empty and someone plays their last tile
  (everyone subtracts their leftover tile values; the player who went out
  adds the sum of everyone's leftovers) — or after two full rounds of
  passes (everyone just subtracts). Highest score wins.

## An original design (the legal bit)

Crossword-tile mechanics are a classic public-domain game idea, but
Scrabble's specific board art, premium-square arrangement, tile values,
and tile distribution are protected expression. **Nothing here copies
them.** This game uses:

- an **original 100-tile bag** (98 letters + 2 blanks) with its own letter
  counts, tuned to English letter frequency — see `TILE_COUNTS` in
  `js/engine.js`;
- **original point values** (1 for the eight most common letters up to 9
  for Q and Z) — see `TILE_POINTS`;
- an **original 4-fold-symmetric premium layout** (8 triple-words,
  14 double-words, 14 triple-letters, 18 double-letters, declared as one
  quadrant in `js/engine.js` and mirrored), with a plain center square —
  corners are double-word, not triple, and there is no premium diagonal;
- its own name, bonus (40, not 50), and Burlington identity throughout.

`scripts/test-engine.mjs` includes guard assertions so future edits don't
drift toward the layout we deliberately avoid.

## Dictionary

`data/words.txt` is the **ENABLE** word list (172,823 words), vendored
verbatim. ENABLE is **public domain** — released without copyright
restriction and the base of many word games. Loaded once at startup into
a `Set`; all validation is client-side. Don't reformat or "clean" it.

## How it works

Plain static site — no build step. `index.html` + `style.css` + ES modules in `js/`:

| file | what it does |
| --- | --- |
| `js/engine.js` | **all** the rules, as pure functions over one JSON-serializable state object (seeded RNG lives in the state — same seed, same bag). Dictionary lookups are injected as an `isWord` function; the engine owns no data files. |
| `js/bot.js` | SKIP's brain — trie + anchored search over words up to 8 letters, every candidate re-validated through `engine.checkPlacement`, best find wins. Decent, not optimal, on purpose. |
| `js/main.js` | UI only: screens, drag & tap tile placement, live word/score preview, pass-the-phone handoffs, bot pacing, localStorage resume |
| `js/leaderboard.js` | monthly leaderboard client (Supabase); vs-SKIP wins only, no accounts |

The engine/UI split is deliberate: online multiplayer later just means
syncing the engine's state object between phones. Rule logic anywhere
outside `engine.js` breaks that plan — see `AGENTS.md`.

Every push to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`.

## Testing

```bash
node scripts/test-engine.mjs
```

Plain Node, no framework. Covers word extraction (main + all crossers),
premium scoring (each square pays once), the Full Bucket, first-move
center rule, rejection of bent/gapped/disconnected plays, blanks,
exchanges, both endgames with leftover accounting, deterministic deals
per seed, serialization round-trips, layout guards, and a 10-game
bot-vs-bot soak over the full ENABLE list.
