/* BTOWN CROSSINGS engine — pure rules, no DOM, no timers, no Math.random.
 *
 * Every function here is a pure function over a plain JSON-serializable
 * state object. The bag shuffle uses a seeded RNG whose state lives INSIDE
 * the game state, so a game can be JSON.stringify'd, parsed, and resumed —
 * and two states built from the same seed are identical. Online multiplayer
 * later = syncing this exact object. Keep ALL rule logic in this file.
 *
 * Dictionary lookups are injected: any function that needs to know whether
 * a word is real takes an `isWord(lowercaseString) -> boolean` argument.
 * The engine never loads or owns the word list.
 *
 * Public API:
 *   createInitialState(options)            -> state
 *   legalMoves(state)                      -> pass/exchange moves + a place marker
 *   checkPlacement(state, move, isWord)    -> { words, score, fullBucket } or throws
 *   applyMove(state, move, isWord)         -> NEW state (never mutates)
 *   getStatus(state)                       -> { status, winners, reason }
 *
 * Moves:
 *   { type:'place', tiles:[{ row, col, letter:'A', blank:false }, ...] }
 *     (blank:true plays a blank AS `letter`; it scores 0)
 *   { type:'exchange', tiles:['A','_', ...] }   ('_' is a blank in the rack)
 *   { type:'pass' }
 *
 * The bag, point values, and premium-square layout are ORIGINAL designs
 * for this game (see README.md) — they are deliberately NOT Scrabble's.
 */

export const BOARD_SIZE = 15;
export const CENTER = 7 * BOARD_SIZE + 7; // City Hall Park — first word covers it
export const RACK_SIZE = 7;
export const FULL_BUCKET_BONUS = 40; // all 7 tiles in one turn
export const BLANK = '_';

/* The Btown bag: 100 tiles (98 letters + 2 blanks). Counts roughly track
 * English letter frequency; values run roughly inverse to frequency.
 * Original to this game — documented in the README. */
export const TILE_COUNTS = {
  A: 8, B: 2, C: 3, D: 4, E: 11, F: 2, G: 3, H: 3, I: 8, J: 1, K: 1,
  L: 5, M: 3, N: 6, O: 7, P: 2, Q: 1, R: 6, S: 5, T: 6, U: 4, V: 1,
  W: 2, X: 1, Y: 2, Z: 1, [BLANK]: 2,
};

export const TILE_POINTS = {
  A: 1, E: 1, I: 1, O: 1, T: 1, N: 1, R: 1, S: 1,
  L: 2, U: 2, D: 2,
  C: 3, G: 3, H: 3, M: 3,
  P: 4, B: 4, F: 4, W: 4, Y: 4,
  V: 5, K: 5,
  J: 7, X: 7,
  Q: 9, Z: 9,
  [BLANK]: 0,
};

/* Premium squares, named for Burlington places:
 *   2L North Beach (double letter)   3L Waterfront (triple letter)
 *   2W Church Street (double word)   3W the Intervale (triple word)
 * A premium counts only on the turn its square is first covered — which
 * falls out naturally: multipliers below apply to newly placed tiles only.
 * The layout is an original 4-fold-symmetric design: one quadrant is
 * declared here and mirrored both ways. The center (City Hall Park) is a
 * plain starting square — no multiplier. */
export const PREMIUM_INFO = {
  '2L': { name: 'North Beach', label: 'double letter' },
  '3L': { name: 'Waterfront', label: 'triple letter' },
  '2W': { name: 'Church Street', label: 'double word' },
  '3W': { name: 'the Intervale', label: 'triple word' },
};

const QUADRANT = [
  [0, 0, '2W'], [0, 5, '3W'], [0, 7, '2L'],
  [1, 1, '2L'], [1, 3, '3L'],
  [2, 2, '3W'],
  [3, 0, '3L'], [3, 6, '2L'],
  [4, 3, '2L'], [4, 6, '2W'],
  [5, 1, '2W'],
  [6, 1, '2L'], [6, 4, '3L'],
  [7, 1, '3L'], [7, 4, '2W'],
];

export const PREMIUMS = (() => {
  const grid = new Array(BOARD_SIZE * BOARD_SIZE).fill(null);
  for (const [r, c, type] of QUADRANT) {
    for (const rr of new Set([r, BOARD_SIZE - 1 - r])) {
      for (const cc of new Set([c, BOARD_SIZE - 1 - c])) {
        grid[rr * BOARD_SIZE + cc] = type;
      }
    }
  }
  return grid;
})();

export const idx = (row, col) => row * BOARD_SIZE + col;

/* ---------------------------------------------------------------- RNG
 * mulberry32 — tiny, deterministic. The integer state is threaded through
 * and stored on the game state as `rng`. */

function rngNext(s) {
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, s };
}

/* Fisher-Yates. Returns { deck, rng } — never touches the input array. */
function shuffle(tiles, rngState) {
  const deck = tiles.slice();
  let s = rngState;
  for (let i = deck.length - 1; i > 0; i--) {
    const r = rngNext(s);
    s = r.s;
    const j = Math.floor(r.value * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  return { deck, rng: s };
}

function fullBag() {
  const bag = [];
  for (const [letter, n] of Object.entries(TILE_COUNTS)) {
    for (let i = 0; i < n; i++) bag.push(letter);
  }
  return bag;
}

/* ---------------------------------------------------------------- setup */

export function createInitialState(options = {}) {
  const numPlayers = options.numPlayers ?? 2;
  if (!Number.isInteger(numPlayers) || numPlayers < 2 || numPlayers > 4) {
    throw new Error('numPlayers must be 2, 3, or 4');
  }
  const seed = (options.seed ?? 1) | 0;

  const { deck: bag, rng } = shuffle(fullBag(), seed);

  const racks = [];
  for (let p = 0; p < numPlayers; p++) {
    racks.push(bag.splice(bag.length - RACK_SIZE, RACK_SIZE));
  }

  return {
    version: 1,
    seed,
    rng,
    numPlayers,
    board: new Array(BOARD_SIZE * BOARD_SIZE).fill(null), // null | { letter, blank }
    bag,
    racks,
    scores: new Array(numPlayers).fill(0),
    currentPlayer: 0,
    passStreak: 0,     // consecutive passes; 2 full rounds ends the game
    gameOver: false,
    outPlayer: null,   // who played their last tile, if the game ended that way
    adjustments: null, // per-player endgame { leftover, bonus }, for the UI
    lastMove: null,    // { player, type, ... } — last-play highlight + narration
  };
}

/* ---------------------------------------------------------------- helpers */

function boardEmpty(state) {
  return !state.board.some((cell) => cell !== null);
}

/* Remove `letters` (rack entries, '_' for blank) from a rack. Returns the
 * new rack, or null if the rack doesn't contain them all. */
function rackWithout(rack, letters) {
  const out = rack.slice();
  for (const letter of letters) {
    const i = out.indexOf(letter);
    if (i === -1) return null;
    out.splice(i, 1);
  }
  return out;
}

function leftoverValue(rack) {
  return rack.reduce((sum, letter) => sum + TILE_POINTS[letter], 0);
}

/* ---------------------------------------------------------------- placement */

/* Validate a proposed placement and price it out. Returns
 *   { words: [{ word, cells, score }], score, fullBucket }
 * or throws an Error whose message says what's wrong (the UI shows it). */
export function checkPlacement(state, move, isWord) {
  if (state.gameOver) throw new Error('The game is over.');
  if (typeof isWord !== 'function') throw new Error('checkPlacement needs an isWord function');
  if (!Array.isArray(move.tiles) || move.tiles.length === 0) throw new Error('Place at least one tile.');
  // Normalize blank to a strict boolean up front so validation, the rack
  // check, scoring, and persistence all read the same tile the same way
  // (a truthy blank like 1 must behave exactly like true).
  const tiles = move.tiles.map((t) => ({ ...t, blank: Boolean(t && t.blank) }));
  if (tiles.length > RACK_SIZE) throw new Error('Too many tiles.');

  const seen = new Set();
  for (const t of tiles) {
    if (!Number.isInteger(t.row) || !Number.isInteger(t.col) ||
        t.row < 0 || t.row >= BOARD_SIZE || t.col < 0 || t.col >= BOARD_SIZE) {
      throw new Error('Tile off the board.');
    }
    if (!/^[A-Z]$/.test(t.letter)) throw new Error('Bad tile letter.');
    const k = idx(t.row, t.col);
    if (seen.has(k)) throw new Error('Two tiles on one square.');
    if (state.board[k] !== null) throw new Error('That square is taken.');
    seen.add(k);
  }

  // rack must actually hold these tiles ('_' for each blank)
  const needed = tiles.map((t) => (t.blank ? BLANK : t.letter));
  if (rackWithout(state.racks[state.currentPlayer], needed) === null) {
    throw new Error("Those tiles aren't on your rack.");
  }

  // one straight line
  const rows = new Set(tiles.map((t) => t.row));
  const cols = new Set(tiles.map((t) => t.col));
  if (rows.size > 1 && cols.size > 1) throw new Error('Tiles must sit in one straight line.');
  const horizontal = rows.size === 1;

  // overlay: what the board looks like with the new tiles down
  const overlay = {};
  for (const t of tiles) overlay[idx(t.row, t.col)] = t;
  const cellAt = (row, col) => {
    if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return null;
    return overlay[idx(row, col)] ?? state.board[idx(row, col)];
  };

  // no gaps: every square between the first and last new tile must be filled
  if (horizontal) {
    const row = tiles[0].row;
    const cs = tiles.map((t) => t.col);
    for (let c = Math.min(...cs); c <= Math.max(...cs); c++) {
      if (cellAt(row, c) === null) throw new Error('No gaps — the word must be unbroken.');
    }
  } else {
    const col = tiles[0].col;
    const rs = tiles.map((t) => t.row);
    for (let r = Math.min(...rs); r <= Math.max(...rs); r++) {
      if (cellAt(r, col) === null) throw new Error('No gaps — the word must be unbroken.');
    }
  }

  // connection: first word covers City Hall Park (the center); after that,
  // at least one new tile must touch or extend what's already down
  if (boardEmpty(state)) {
    if (!tiles.some((t) => idx(t.row, t.col) === CENTER)) {
      throw new Error('The first word must cover City Hall Park (the center square).');
    }
  } else {
    const touches = tiles.some((t) =>
      [[t.row - 1, t.col], [t.row + 1, t.col], [t.row, t.col - 1], [t.row, t.col + 1]]
        .some(([r, c]) => r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE &&
          state.board[idx(r, c)] !== null));
    if (!touches) throw new Error('New words must connect to the crossings already down.');
  }

  // collect every maximal run of 2+ letters that contains a new tile
  // (the main word plus each crossing word), score it, and check it
  const runs = new Map(); // 'h:startIdx' / 'v:startIdx' -> run
  const scanRun = (t, dh, dv, tag) => {
    let r = t.row;
    let c = t.col;
    while (cellAt(r - dv, c - dh) !== null) { r -= dv; c -= dh; }
    const startKey = tag + ':' + idx(r, c);
    if (runs.has(startKey)) return;
    let word = '';
    let score = 0;
    let wordMult = 1;
    const cells = [];
    while (cellAt(r, c) !== null) {
      const cell = cellAt(r, c);
      const k = idx(r, c);
      const isNew = overlay[k] !== undefined;
      let points = cell.blank ? 0 : TILE_POINTS[cell.letter];
      if (isNew) { // premiums count only the turn their square is first covered
        const prem = PREMIUMS[k];
        if (prem === '2L') points *= 2;
        else if (prem === '3L') points *= 3;
        else if (prem === '2W') wordMult *= 2;
        else if (prem === '3W') wordMult *= 3;
      }
      word += cell.letter;
      score += points;
      cells.push(k);
      r += dv;
      c += dh;
    }
    if (word.length >= 2) runs.set(startKey, { word, cells, score: score * wordMult });
  };
  for (const t of tiles) {
    scanRun(t, 1, 0, 'h');
    scanRun(t, 0, 1, 'v');
  }

  const words = [...runs.values()];
  if (words.length === 0) throw new Error('A word needs at least two letters.');
  for (const w of words) {
    if (!isWord(w.word.toLowerCase())) {
      throw new Error(`“${w.word}” isn't in the Btown dictionary.`);
    }
  }

  const fullBucket = tiles.length === RACK_SIZE;
  const score = words.reduce((sum, w) => sum + w.score, 0) +
    (fullBucket ? FULL_BUCKET_BONUS : 0);
  return { words, score, fullBucket };
}

/* ---------------------------------------------------------------- moves */

/* Placements are validated (not enumerated — the space is huge): propose one
 * through checkPlacement/applyMove. This lists the always-available moves. */
export function legalMoves(state) {
  if (state.gameOver) return [];
  const moves = [{ type: 'pass' }];
  const maxExchange = Math.min(state.bag.length, state.racks[state.currentPlayer].length);
  if (maxExchange > 0) moves.push({ type: 'exchange', maxTiles: maxExchange });
  moves.push({ type: 'place' }); // marker: build a move and run it by checkPlacement
  return moves;
}

export function applyMove(state, move, isWord) {
  if (state.gameOver) throw new Error('The game is over.');
  if (move.type === 'place') return applyPlace(state, move, isWord);
  if (move.type === 'exchange') return applyExchange(state, move);
  if (move.type === 'pass') return applyPass(state);
  throw new Error('Unknown move type: ' + move.type);
}

function applyPlace(state, move, isWord) {
  const result = checkPlacement(state, move, isWord); // throws if invalid
  // Same blank normalization checkPlacement applied — the tile that
  // validated and scored as a blank must persist as a blank.
  const tiles = move.tiles.map((t) => ({ ...t, blank: Boolean(t && t.blank) }));
  const player = state.currentPlayer;

  const board = state.board.slice();
  for (const t of tiles) {
    board[idx(t.row, t.col)] = { letter: t.letter, blank: t.blank };
  }

  const needed = tiles.map((t) => (t.blank ? BLANK : t.letter));
  let rack = rackWithout(state.racks[player], needed);
  const bag = state.bag.slice();
  while (rack.length < RACK_SIZE && bag.length > 0) rack.push(bag.pop());
  const racks = state.racks.map((r, p) => (p === player ? rack : r));

  const scores = state.scores.slice();
  scores[player] += result.score;

  const next = {
    ...state,
    board,
    bag,
    racks,
    scores,
    currentPlayer: (player + 1) % state.numPlayers,
    passStreak: 0,
    lastMove: {
      player,
      type: 'place',
      cells: tiles.map((t) => idx(t.row, t.col)),
      words: result.words.map((w) => ({ word: w.word, score: w.score })),
      score: result.score,
      fullBucket: result.fullBucket,
    },
  };

  // going out: bag empty and the player just used their last tile
  if (rack.length === 0 && bag.length === 0) return finishGame(next, player);
  return next;
}

function applyExchange(state, move) {
  const player = state.currentPlayer;
  const tiles = move.tiles;
  if (!Array.isArray(tiles) || tiles.length === 0) throw new Error('Pick tiles to swap.');
  if (state.bag.length < tiles.length) {
    throw new Error(`Only ${state.bag.length} tiles left in the bag.`);
  }
  const rack = rackWithout(state.racks[player], tiles);
  if (rack === null) throw new Error("Those tiles aren't on your rack.");

  // draw replacements first, then shuffle the returned tiles into the bag
  const bag = state.bag.slice();
  const drawn = bag.splice(bag.length - tiles.length, tiles.length);
  const { deck, rng } = shuffle(bag.concat(tiles), state.rng);

  const racks = state.racks.map((r, p) => (p === player ? rack.concat(drawn) : r));
  return {
    ...state,
    rng,
    bag: deck,
    racks,
    currentPlayer: (player + 1) % state.numPlayers,
    passStreak: 0,
    lastMove: { player, type: 'exchange', count: tiles.length },
  };
}

function applyPass(state) {
  const player = state.currentPlayer;
  const next = {
    ...state,
    currentPlayer: (player + 1) % state.numPlayers,
    passStreak: state.passStreak + 1,
    lastMove: { player, type: 'pass' },
  };
  // two full rounds of passes: nobody's playing — count it down
  if (next.passStreak >= 2 * state.numPlayers) return finishGame(next, null);
  return next;
}

/* Endgame accounting: everyone subtracts their leftover tile values; the
 * player who went out (if any) adds the sum of opponents' leftovers. */
function finishGame(state, outPlayer) {
  const scores = state.scores.slice();
  const adjustments = state.racks.map((rack, p) => {
    const leftover = leftoverValue(rack);
    scores[p] -= leftover;
    return { leftover, bonus: 0 };
  });
  if (outPlayer !== null) {
    const bonus = adjustments.reduce((sum, a) => sum + a.leftover, 0);
    scores[outPlayer] += bonus;
    adjustments[outPlayer].bonus = bonus;
  }
  return { ...state, scores, gameOver: true, outPlayer, adjustments };
}

/* ---------------------------------------------------------------- status */

export function getStatus(state) {
  if (!state.gameOver) return { status: 'active', winners: [], reason: null };
  const top = Math.max(...state.scores);
  const winners = [];
  state.scores.forEach((score, p) => { if (score === top) winners.push(p); });
  return {
    status: 'over',
    winners,
    reason: state.outPlayer !== null ? 'out' : 'passes',
  };
}
