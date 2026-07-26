/* Engine test — plain Node, no framework. Run: node scripts/test-engine.mjs
 * Exercises the pure engine only; nothing here touches the DOM. */

import {
  createInitialState, legalMoves, checkPlacement, applyMove, getStatus,
  BOARD_SIZE, CENTER, RACK_SIZE, FULL_BUCKET_BONUS, BLANK,
  TILE_COUNTS, TILE_POINTS, PREMIUMS, idx,
} from '../js/engine.js';

let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.error('FAIL  ' + name); }
}

function throws(fn, name, msgPart) {
  try {
    fn();
    failed++;
    console.error('FAIL  ' + name + ' (no error thrown)');
  } catch (e) {
    if (msgPart && !String(e.message).includes(msgPart)) {
      failed++;
      console.error(`FAIL  ${name} (wrong error: "${e.message}")`);
    } else {
      passed++;
      console.log('  ok  ' + name);
    }
  }
}

/* Tiny dictionary for exact-rule tests; the full ENABLE list is loaded for
 * the soak at the bottom. */
const MINI = new Set([
  'cat', 'cats', 'cart', 'at', 'aa', 'tt', 'ace', 'retinas', 'ta', 'rat', 'carts',
  'so', 'ax',
]);
const isWord = (w) => MINI.has(w);

/* Hand-crafted mid-game fixture (JSON-serializable, like the real thing). */
function fixture(overrides = {}) {
  const base = createInitialState({ numPlayers: 2, seed: 42 });
  return { ...base, ...overrides };
}
function withBoard(state, tilesDown) {
  const board = state.board.slice();
  for (const [r, c, letter, blank] of tilesDown) {
    board[idx(r, c)] = { letter, blank: blank === true };
  }
  return { ...state, board };
}
const tile = (row, col, letter, blank = false) => ({ row, col, letter, blank });
function allTiles(state) {
  const onBoard = state.board.filter(Boolean).map((c) => (c.blank ? BLANK : c.letter));
  return [...state.bag, ...state.racks.flat(), ...onBoard];
}

/* ---------------------------------------------------------- determinism */
{
  const a = createInitialState({ numPlayers: 3, seed: 12345 });
  const b = createInitialState({ numPlayers: 3, seed: 12345 });
  const c = createInitialState({ numPlayers: 3, seed: 54321 });
  assert(JSON.stringify(a) === JSON.stringify(b), 'same seed -> identical bag and racks');
  assert(JSON.stringify(a) !== JSON.stringify(c), 'different seed -> different draw');
  assert(a.racks.length === 3 && a.racks.every((r) => r.length === RACK_SIZE), 'every player gets 7 tiles');

  const counts = {};
  for (const t of allTiles(a)) counts[t] = (counts[t] || 0) + 1;
  assert(allTiles(a).length === 100, 'the bag holds 100 tiles');
  assert(Object.entries(TILE_COUNTS).every(([l, n]) => counts[l] === n),
    'tile distribution matches TILE_COUNTS exactly');
  assert(Object.keys(TILE_POINTS).length === 27 &&
    Object.keys(TILE_COUNTS).every((l) => TILE_POINTS[l] !== undefined),
    'every tile has a point value');
}

/* ------------------------------------------------------- premium layout */
{
  let symmetric = true;
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      const t = PREMIUMS[idx(r, c)];
      if (t !== PREMIUMS[idx(BOARD_SIZE - 1 - r, c)] ||
          t !== PREMIUMS[idx(r, BOARD_SIZE - 1 - c)]) symmetric = false;
    }
  }
  assert(symmetric, 'premium layout is 4-fold symmetric');
  const tally = {};
  for (const t of PREMIUMS) if (t) tally[t] = (tally[t] || 0) + 1;
  assert(tally['3W'] === 8 && tally['2W'] === 14 && tally['3L'] === 14 && tally['2L'] === 18,
    'premium counts: 8×3W, 14×2W, 14×3L, 18×2L');
  assert(PREMIUMS[CENTER] === null, 'City Hall Park (center) has no multiplier');
  // guards against drifting toward the board we must not copy
  assert(PREMIUMS[idx(0, 0)] !== '3W', 'corners are not triple-word');
  assert([1, 2, 3, 4].some((i) => PREMIUMS[idx(i, i)] !== '2W'),
    'no double-word diagonal run from the corner');
}

/* ------------------------------------------- first move: center + 2 letters */
{
  const s = fixture({ racks: [['C', 'A', 'T', 'R', 'E', 'S', 'O'], ['A', 'A', 'A', 'A', 'A', 'A', 'A']] });
  throws(() => checkPlacement(s, { type: 'place', tiles: [tile(0, 0, 'C'), tile(0, 1, 'A'), tile(0, 2, 'T')] }, isWord),
    'first word must cover the center', 'City Hall Park');
  throws(() => checkPlacement(s, { type: 'place', tiles: [tile(7, 7, 'A')] }, isWord),
    'a lone first tile is not a word', 'two letters');

  const ok = checkPlacement(s, { type: 'place', tiles: [tile(7, 6, 'C'), tile(7, 7, 'A'), tile(7, 8, 'T')] }, isWord);
  assert(ok.words.length === 1 && ok.words[0].word === 'CAT', 'first word CAT extracted');
  assert(ok.score === 5, 'CAT over the plain center scores 3+1+1 = 5');
}

/* -------------------------------------- line, gaps, connection, occupancy */
{
  const s = withBoard(
    fixture({ racks: [['C', 'A', 'T', 'R', 'E', 'S', 'O'], ['A', 'A', 'A', 'A', 'A', 'A', 'A']] }),
    [[7, 6, 'C'], [7, 7, 'A'], [7, 8, 'T']],
  );
  throws(() => checkPlacement(s, { type: 'place', tiles: [tile(6, 6, 'A'), tile(8, 7, 'T')] }, isWord),
    'bent placements are rejected', 'straight line');
  throws(() => checkPlacement(s, { type: 'place', tiles: [tile(6, 6, 'A'), tile(6, 9, 'T')] }, isWord),
    'gapped placements are rejected', 'unbroken');
  throws(() => checkPlacement(s, { type: 'place', tiles: [tile(0, 0, 'A'), tile(0, 1, 'T')] }, isWord),
    'islands are rejected', 'connect');
  throws(() => checkPlacement(s, { type: 'place', tiles: [tile(7, 7, 'S')] }, isWord),
    'occupied squares are rejected', 'taken');
  throws(() => checkPlacement(s, { type: 'place', tiles: [tile(7, 9, 'Z')] }, isWord),
    'tiles you do not hold are rejected', 'rack');
  throws(() => checkPlacement(s, { type: 'place', tiles: [tile(7, 9, 'R')] }, isWord),
    'invalid main word CATR is rejected', 'CATR');
}

/* -------------------------------- main word + every crossing word validates */
{
  // Board: CAT across row 7 (cols 6-8). Play RAT down col 6 hooking the C? No —
  // place A,T under and over? Keep it concrete: play "AT" at row 8 cols 7-8:
  // main word AT, crossers AA (col 7) and TT (col 8) — all must be words.
  const s = withBoard(
    fixture({ racks: [['A', 'T', 'E', 'R', 'E', 'S', 'O'], ['A', 'A', 'A', 'A', 'A', 'A', 'A']] }),
    [[7, 6, 'C'], [7, 7, 'A'], [7, 8, 'T']],
  );
  const ok = checkPlacement(s, { type: 'place', tiles: [tile(8, 7, 'A'), tile(8, 8, 'T')] }, isWord);
  const words = ok.words.map((w) => w.word).sort();
  assert(JSON.stringify(words) === JSON.stringify(['AA', 'AT', 'TT']),
    'main word AND both crossing words are extracted');

  // one bad crosser sinks the whole play: "SO" main is fine, but "TS"? use
  // E under T: main "ES"? Simplest: put X at (8,6) making "XA T"? Use a
  // crosser that is not in MINI: place E at (8,7), R at (8,8): crossers
  // AE (not a word here) — rejected even if main run were fine.
  throws(() => checkPlacement(s, { type: 'place', tiles: [tile(8, 7, 'E'), tile(8, 8, 'R')] }, isWord),
    'an invalid crossing word rejects the play', "isn't in the Btown dictionary");
}

/* ------------------------------------------ premiums: once, and only once */
{
  // CART across row 7, cols 4-7: C lands on Church Street (2W) at (7,4).
  const s1 = fixture({ racks: [['C', 'A', 'R', 'T', 'E', 'S', 'O'], ['A', 'C', 'E', 'A', 'A', 'A', 'A']] });
  const first = checkPlacement(s1, { type: 'place', tiles: [tile(7, 4, 'C'), tile(7, 5, 'A'), tile(7, 6, 'R'), tile(7, 7, 'T')] }, isWord);
  assert(first.score === (3 + 1 + 1 + 1) * 2, 'CART doubles on Church Street (2W): 12');

  const s2 = applyMove(s1, { type: 'place', tiles: [tile(7, 4, 'C'), tile(7, 5, 'A'), tile(7, 6, 'R'), tile(7, 7, 'T')] }, isWord);
  assert(s2.scores[0] === 12 && s2.currentPlayer === 1, 'score banked, turn advances');
  assert(s2.racks[0].length === RACK_SIZE, 'rack refills to 7 from the bag');
  assert(s1.board[idx(7, 4)] === null && s1.scores[0] === 0, 'applyMove did not mutate the old state');
  assert(allTiles(s2).length === 100, 'no tiles created or lost by a play');

  // ACE down col 4 through the old C: A on (6,4) 3L, E on (8,4) 3L — but the
  // covered Church Street under C must NOT double the word again.
  const ace = checkPlacement(s2, { type: 'place', tiles: [tile(6, 4, 'A'), tile(8, 4, 'E')] }, isWord);
  assert(ace.words[0].word === 'ACE' && ace.score === 3 + 3 + 3,
    'a premium already covered does not fire again (ACE = 9, not 18)');
  assert(s2.lastMove.type === 'place' && s2.lastMove.words[0].word === 'CART' &&
    JSON.stringify(s2.lastMove.cells) === JSON.stringify([idx(7, 4), idx(7, 5), idx(7, 6), idx(7, 7)]),
    'lastMove records cells and words for the UI highlight');
}

/* -------------------------------------------------- Full Bucket bonus */
{
  const s = fixture({ racks: [['R', 'E', 'T', 'I', 'N', 'A', 'S'], ['A', 'A', 'A', 'A', 'A', 'A', 'A']] });
  const tiles = 'RETINAS'.split('').map((letter, i) => tile(7, 4 + i, letter));
  const ok = checkPlacement(s, { type: 'place', tiles }, isWord);
  // 7 one-pointers, doubled twice — Church Street at (7,4) AND (7,10) — then +40
  assert(ok.fullBucket === true && ok.score === 7 * 2 * 2 + FULL_BUCKET_BONUS,
    'all 7 tiles = Full Bucket: (7×2×2) + 40 = 68');
}

/* --------------------------------------------------------- blank tiles */
{
  const s = withBoard(
    fixture({ racks: [[BLANK, 'A', 'T', 'R', 'E', 'S', 'O'], ['A', 'A', 'A', 'A', 'A', 'A', 'A']] }),
    [[7, 6, 'C'], [7, 7, 'A'], [7, 8, 'T']],
  );
  const ok = checkPlacement(s, { type: 'place', tiles: [tile(7, 9, 'S', true)] }, isWord);
  assert(ok.words[0].word === 'CATS' && ok.score === 3 + 1 + 1 + 0,
    'a blank plays as its letter but scores 0');
  throws(() => checkPlacement(s, { type: 'place', tiles: [tile(7, 9, 'S', false), tile(7, 5, 'S', false)] }, isWord),
    'you cannot play letters as non-blanks you do not hold', 'rack');
  const after = applyMove(s, { type: 'place', tiles: [tile(7, 9, 'S', true)] }, isWord);
  assert(after.board[idx(7, 9)].blank === true && after.board[idx(7, 9)].letter === 'S',
    'the board remembers a blank and what it plays as');
  assert(JSON.parse(JSON.stringify(after)).board[idx(7, 9)].blank === true,
    'blank survives serialization');
}

/* ------------------------------------------------------------ exchange */
{
  const s = fixture();
  const rackBefore = s.racks[0].slice();
  const swap = [rackBefore[0], rackBefore[1]];
  const after = applyMove(s, { type: 'exchange', tiles: swap }, isWord);
  assert(after.racks[0].length === RACK_SIZE, 'exchange keeps the rack at 7');
  assert(after.bag.length === s.bag.length, 'exchange keeps the bag the same size');
  assert(allTiles(after).length === 100 &&
    JSON.stringify(allTiles(after).sort()) === JSON.stringify(allTiles(s).sort()),
    'exchange conserves the 100 tiles');
  assert(after.currentPlayer === 1 && after.lastMove.type === 'exchange' && after.lastMove.count === 2,
    'exchange spends the turn');
  const b = applyMove(s, { type: 'exchange', tiles: swap }, isWord);
  assert(JSON.stringify(b) === JSON.stringify(after), 'exchange is deterministic (seeded shuffle)');

  const dryBag = fixture({ bag: ['E'] });
  throws(() => applyMove(dryBag, { type: 'exchange', tiles: swap.slice(0, 2) }, isWord),
    'cannot swap more tiles than the bag holds', 'left in the bag');
  const emptyBag = fixture({ bag: [] });
  assert(!legalMoves(emptyBag).some((m) => m.type === 'exchange'),
    'no exchange offered from an empty bag');
}

/* ------------------------------------------- endgame: going out + leftovers */
{
  const s = withBoard(
    fixture({
      bag: [],
      racks: [['A', 'T'], ['Q', 'Z']],
      scores: [10, 20],
    }),
    [[7, 6, 'C'], [7, 7, 'A'], [7, 8, 'T']],
  );
  const end = applyMove(s, { type: 'place', tiles: [tile(8, 7, 'A'), tile(8, 8, 'T')] }, isWord);
  // AT + crossers AA and TT = 6; player 0 empties their rack with the bag dry:
  // +Q&Z leftovers (18) from player 1, who loses those 18.
  assert(end.gameOver === true && end.outPlayer === 0, 'bag empty + last tile = game over');
  assert(end.scores[0] === 10 + 6 + 18, 'going out adds opponents\' leftovers (34)');
  assert(end.scores[1] === 20 - 18, 'opponents subtract their own leftovers (2)');
  assert(end.adjustments[0].bonus === 18 && end.adjustments[1].leftover === 18,
    'endgame adjustments recorded for the UI');
  const st = getStatus(end);
  assert(st.status === 'over' && st.reason === 'out' &&
    JSON.stringify(st.winners) === JSON.stringify([0]), 'winner declared by final score');
  assert(legalMoves(end).length === 0, 'no legal moves once the game is over');
  throws(() => applyMove(end, { type: 'pass' }, isWord), 'no moves after the end', 'over');
}

/* --------------------------------------- endgame: two full rounds of passes */
{
  let s = fixture({ racks: [['Q', 'A'], ['Z', 'E']], scores: [30, 30] });
  for (let i = 0; i < 4; i++) {
    assert(!s.gameOver, `pass ${i} of 4: still going`);
    s = applyMove(s, { type: 'pass' }, isWord);
  }
  assert(s.gameOver && s.outPlayer === null, 'two full rounds of passes ends the game');
  assert(s.scores[0] === 30 - (9 + 1) && s.scores[1] === 30 - (9 + 1),
    'everyone subtracts their own leftovers; nobody collects');
  assert(getStatus(s).reason === 'passes' && getStatus(s).winners.length === 2,
    'pass-out can end in a tie');
  // a placement resets the streak
  let s2 = fixture({ racks: [['C', 'A', 'T', 'R', 'E', 'S', 'O'], ['A', 'A', 'A', 'A', 'A', 'A', 'A']] });
  s2 = applyMove(s2, { type: 'pass' }, isWord);
  s2 = applyMove(s2, { type: 'pass' }, isWord);
  s2 = applyMove(s2, { type: 'place', tiles: [tile(7, 6, 'C'), tile(7, 7, 'A'), tile(7, 8, 'T')] }, isWord);
  s2 = applyMove(s2, { type: 'pass' }, isWord);
  s2 = applyMove(s2, { type: 'pass' }, isWord);
  s2 = applyMove(s2, { type: 'pass' }, isWord);
  assert(!s2.gameOver, 'a play resets the pass count (needs 2 FULL rounds)');
}

/* -------------------------------------------- serialization round-trip */
{
  let s = fixture({
    racks: [['C', 'A', 'T', 'R', 'E', 'S', 'O'], ['S', 'A', 'C', 'E', 'A', 'T', 'R']],
    bag: ['A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A'], // known refills
  });
  s = applyMove(s, { type: 'place', tiles: [tile(7, 6, 'C'), tile(7, 7, 'A'), tile(7, 8, 'T')] }, isWord);
  s = JSON.parse(JSON.stringify(s));
  s = applyMove(s, { type: 'place', tiles: [tile(8, 7, 'A'), tile(8, 8, 'T')] }, isWord);
  const thawed = JSON.parse(JSON.stringify(s));
  const again = checkPlacement(thawed, { type: 'place', tiles: [tile(7, 9, 'S')] }, isWord);
  assert(again.words.map((w) => w.word).join(',') === 'CATS',
    'game survives stringify/parse mid-run and keeps validating');
  // fixture started with 10 bag tiles + two 7-tile racks = 24
  assert(allTiles(thawed).length === 24, 'tile conservation across the round-trip');
}

/* ------------------------------------- full-game soak: engine + bot + ENABLE */
{
  const { readFileSync } = await import('node:fs');
  const { buildLexicon, chooseMove } = await import('../js/bot.js');
  const dict = new Set(readFileSync(new URL('../data/words.txt', import.meta.url), 'utf8')
    .split('\n').map((w) => w.trim()).filter(Boolean));
  assert(dict.size === 172819 || dict.size > 170000, `ENABLE list loaded (${dict.size} words)`);
  const lexicon = buildLexicon(dict);

  let finished = 0;
  let conserved = true;
  const games = [[2, 1], [2, 2], [2, 3], [2, 4], [2, 5], [2, 6], [3, 7], [3, 8], [4, 9], [4, 10]];
  for (const [numPlayers, seed] of games) {
    let s = createInitialState({ numPlayers, seed });
    let guard = 0;
    while (!s.gameOver && guard++ < 400) {
      s = applyMove(s, chooseMove(s, lexicon), dict.has.bind(dict)); // throws on any illegal bot move
    }
    if (s.gameOver) finished++;
    if (allTiles(s).length !== 100) conserved = false;
  }
  assert(finished === games.length, `${finished}/${games.length} bot-vs-bot games finish (engine never rejects the bot)`);
  assert(conserved, '100 tiles conserved through every full game');

  const s = createInitialState({ numPlayers: 2, seed: 77 });
  assert(JSON.stringify(chooseMove(s, lexicon)) === JSON.stringify(chooseMove(s, lexicon)),
    'the bot is deterministic');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
