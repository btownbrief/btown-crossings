/* SKIP — Btown Crossings' bot (named for the lake that skips work to sail).
 *
 * Finds decent (not optimal) plays with the classic anchored search:
 * a trie of dictionary words, anchor squares next to existing tiles,
 * left parts built from the rack, right extensions through the board.
 * Deliberately modest: only words up to 8 letters are in its trie, and it
 * simply takes its best-scoring find — no endgame trickery, no rack
 * management theory.
 *
 * The bot may only call the engine's public API. Every candidate play is
 * priced and legality-checked by engine.checkPlacement before it's
 * considered, so the bot cannot play a move a human couldn't.
 * chooseMove is deterministic: same state + same lexicon = same move.
 */

import { BOARD_SIZE, BLANK, TILE_POINTS, checkPlacement, idx } from './engine.js';

const MAX_TRIE_WORD = 8; // rack of 7 through one board letter — plenty for a decent game

const A_CODE = 'A'.charCodeAt(0);
const ALL_LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(A_CODE + i));

/* ------------------------------------------------------------ lexicon */

/* Build the bot's brain from the dictionary Set (lowercase words). Do this
 * once and reuse it — it walks the whole word list. */
export function buildLexicon(dictSet) {
  const trie = {};
  for (const w of dictSet) {
    if (w.length < 2 || w.length > MAX_TRIE_WORD || !/^[a-z]+$/.test(w)) continue;
    let node = trie;
    for (const ch of w.toUpperCase()) node = node[ch] ?? (node[ch] = {});
    node.$ = 1;
  }
  return { trie, isWord: (w) => dictSet.has(w) };
}

/* ------------------------------------------------------------ search */

/* All candidate placements for the current player, best first. */
export function findPlacements(state, lexicon) {
  const found = []; // { tiles, score, blanks }
  const empty = !state.board.some((c) => c !== null);

  for (const dir of empty ? ['h'] : ['h', 'v']) {
    // grid[r][c]: letter or null, in search space ('v' = transposed board)
    const at = (r, c) => {
      const cell = dir === 'h' ? state.board[idx(r, c)] : state.board[idx(c, r)];
      return cell ? cell.letter : null;
    };
    for (let r = 0; r < BOARD_SIZE; r++) {
      searchRow(state, lexicon, dir, r, at, found);
    }
  }

  found.sort((a, b) => b.score - a.score || a.blanks - b.blanks);
  return found;
}

function searchRow(state, lexicon, dir, r, at, found) {
  const empty = !state.board.some((c) => c !== null);
  const rack = state.racks[state.currentPlayer];
  const counts = {};
  for (const t of rack) counts[t] = (counts[t] || 0) + 1;

  // anchors: empty squares touching a tile (or the center on an empty board)
  const anchors = new Set();
  const centerRC = dir === 'h' ? [7, 7] : [7, 7];
  for (let c = 0; c < BOARD_SIZE; c++) {
    if (at(r, c) !== null) continue;
    if (empty) {
      if (r === centerRC[0] && c === centerRC[1]) anchors.add(c);
      continue;
    }
    const near = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]].some(([rr, cc]) =>
      rr >= 0 && rr < BOARD_SIZE && cc >= 0 && cc < BOARD_SIZE && at(rr, cc) !== null);
    if (near) anchors.add(c);
  }
  if (anchors.size === 0) return;

  // cross-checks: which letters may sit on each empty square, given the
  // perpendicular word they'd complete (full dictionary, not the trie)
  const cross = [];
  for (let c = 0; c < BOARD_SIZE; c++) {
    if (at(r, c) !== null) { cross.push(null); continue; }
    let above = '';
    for (let rr = r - 1; rr >= 0 && at(rr, c) !== null; rr--) above = at(rr, c) + above;
    let below = '';
    for (let rr = r + 1; rr < BOARD_SIZE && at(rr, c) !== null; rr++) below += at(rr, c);
    if (above === '' && below === '') { cross.push(null); continue; } // anything goes
    cross.push(new Set(ALL_LETTERS.filter((L) =>
      lexicon.isWord((above + L + below).toLowerCase()))));
  }
  const allowed = (c, L) => cross[c] === null || cross[c].has(L);

  const record = (placed) => {
    if (placed.length === 0) return;
    const tiles = placed.map(({ c, letter, blank }) =>
      dir === 'h'
        ? { row: r, col: c, letter, blank }
        : { row: c, col: r, letter, blank });
    let result;
    try {
      result = checkPlacement(state, { type: 'place', tiles }, lexicon.isWord);
    } catch {
      return; // the engine is the referee — anything it dislikes is dropped
    }
    found.push({ tiles, score: result.score, blanks: tiles.filter((t) => t.blank).length });
  };

  // extend right from `col` with trie `node`; `placed` = new tiles so far
  const extend = (node, col, placed, anchorCovered) => {
    const onBoard = col < BOARD_SIZE ? at(r, col) : null;
    if (onBoard === null) {
      if (node.$ && anchorCovered) record(placed);
      if (col >= BOARD_SIZE) return;
      for (const L of Object.keys(node)) {
        if (L === '$' || !allowed(col, L)) continue;
        const covered = anchorCovered || anchors.has(col);
        if (counts[L] > 0) {
          counts[L]--;
          extend(node[L], col + 1, placed.concat({ c: col, letter: L, blank: false }), covered);
          counts[L]++;
        }
        if (counts[BLANK] > 0) {
          counts[BLANK]--;
          extend(node[L], col + 1, placed.concat({ c: col, letter: L, blank: true }), covered);
          counts[BLANK]++;
        }
      }
    } else {
      const next = node[onBoard];
      if (next) extend(next, col + 1, placed, anchorCovered);
    }
  };

  // build left parts from the rack, or reuse the tiles already on the board
  const leftPart = (node, anchor, placed, budget) => {
    extend(node, anchor, placed.map((p, i) => ({ ...p, c: anchor - placed.length + i })), false);
    if (budget === 0) return;
    for (const L of Object.keys(node)) {
      if (L === '$') continue;
      if (counts[L] > 0) {
        counts[L]--;
        leftPart(node[L], anchor, placed.concat({ letter: L, blank: false }), budget - 1);
        counts[L]++;
      }
      if (counts[BLANK] > 0) {
        counts[BLANK]--;
        leftPart(node[L], anchor, placed.concat({ letter: L, blank: true }), budget - 1);
        counts[BLANK]++;
      }
    }
  };

  for (const anchor of [...anchors].sort((a, b) => a - b)) {
    if (anchor > 0 && at(r, anchor - 1) !== null) {
      // fixed prefix: the board tiles immediately left of the anchor
      let start = anchor;
      while (start > 0 && at(r, start - 1) !== null) start--;
      let node = lexicon.trie;
      for (let c = start; c < anchor && node; c++) node = node[at(r, c)];
      if (node) extend(node, anchor, [], true);
    } else {
      // room to build a prefix: empty non-anchor squares to the left
      // (stop at the previous anchor so each play is found exactly once)
      let room = 0;
      let c = anchor - 1;
      while (c >= 0 && at(r, c) === null && !anchors.has(c)) {
        room++;
        c--;
      }
      leftPart(lexicon.trie, anchor, [], Math.min(room, rack.length - 1));
    }
  }
}

/* ------------------------------------------------------------ choice */

/* The move SKIP would make. Deterministic; always legal (or null only if
 * the game is over). */
export function chooseMove(state, lexicon) {
  if (state.gameOver) return null;
  const plays = findPlacements(state, lexicon);
  if (plays.length > 0) {
    const best = plays[0];
    return { type: 'place', tiles: best.tiles };
  }
  // nothing playable: swap the clunkiest tiles (highest point value first,
  // blanks never) if the bag allows, else pass
  const rack = state.racks[state.currentPlayer];
  const swappable = rack.filter((t) => t !== BLANK)
    .sort((a, b) => TILE_POINTS[b] - TILE_POINTS[a] || (a < b ? -1 : 1));
  const n = Math.min(state.bag.length, swappable.length);
  if (n > 0) return { type: 'exchange', tiles: swappable.slice(0, n) };
  return { type: 'pass' };
}
