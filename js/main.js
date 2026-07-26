/* BTOWN CROSSINGS — UI only. All rules live in engine.js; SKIP's brain
 * lives in bot.js. This file renders state, handles drag/tap tile
 * placement, paces the bot with timers, and saves/restores the game
 * (the whole game state is one JSON-serializable object, so localStorage
 * resume is a stringify away). */

import {
  createInitialState, checkPlacement, applyMove, getStatus,
  BOARD_SIZE, CENTER, BLANK, TILE_POINTS, PREMIUMS, idx,
} from './engine.js';
import { buildLexicon, chooseMove } from './bot.js';

const SAVE_KEY = 'btown-crossings-save-v1';
const BOT = 1; // in bot mode, player 0 is the human, player 1 is SKIP

const $ = (id) => document.getElementById(id);
const screens = { menu: $('menu'), handoff: $('handoff'), game: $('game'), gameover: $('gameover') };

let dict = null;      // Set of lowercase words
let lexicon = null;   // bot brain, built on first bot game
let G = null;         // { mode: 'bot' | 'pass', state }
let rackView = [];    // [{ letter }] — this turn's rack, in display order
let pending = [];     // [{ slot, letter, as, blank, row, col }] — uncommitted tiles
let handRevealed = true;
let selectedSlot = null;     // rack tile picked by tap, waiting for a cell
let pendingBlankDrop = null; // { slot, row, col } waiting on the letter picker
let botTimer = null;
let passArmed = false;
let cellEls = [];

const newSeed = () => (Math.random() * 2 ** 31) | 0;
const isWord = (w) => dict !== null && dict.has(w);

function playerName(p) {
  if (G.mode === 'bot') return p === BOT ? 'SKIP' : 'You';
  return 'Player ' + (p + 1);
}

function humanTurn() {
  return G && !G.state.gameOver && !(G.mode === 'bot' && G.state.currentPlayer === BOT);
}

function show(name) {
  for (const key of Object.keys(screens)) screens[key].classList.toggle('hidden', key !== name);
}

/* ---------------------------------------------------------------- save */

function save() {
  try {
    if (G && !G.state.gameOver) localStorage.setItem(SAVE_KEY, JSON.stringify({ mode: G.mode, state: G.state }));
    else localStorage.removeItem(SAVE_KEY);
  } catch { /* private mode etc. — play on without saving */ }
}

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved?.state?.version === 1 && !saved.state.gameOver) return saved;
  } catch { /* corrupted save — ignore it */ }
  return null;
}

/* ---------------------------------------------------------------- board */

function buildBoard() {
  const board = $('board');
  board.innerHTML = '';
  cellEls = [];
  for (let k = 0; k < BOARD_SIZE * BOARD_SIZE; k++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    if (k === CENTER) { cell.classList.add('center'); cell.textContent = '⭐'; }
    else if (PREMIUMS[k]) { cell.classList.add('p' + PREMIUMS[k]); cell.textContent = PREMIUMS[k]; }
    cell.dataset.k = k;
    board.appendChild(cell);
    cellEls.push(cell);
  }
}

function tileEl(letter, blank, cls) {
  const el = document.createElement('div');
  el.className = cls + (blank ? ' blank-tile' : '');
  el.textContent = letter;
  const pts = document.createElement('span');
  pts.className = 'pts';
  pts.textContent = blank ? '' : TILE_POINTS[letter];
  el.appendChild(pts);
  return el;
}

function renderBoard(fx = {}) {
  const lastCells = new Set(
    pending.length === 0 && G.state.lastMove?.type === 'place' ? G.state.lastMove.cells : []);
  for (let k = 0; k < cellEls.length; k++) {
    const cell = cellEls[k];
    cell.querySelector('.btile')?.remove();
    cell.classList.remove('drop-ok');
    const committed = G.state.board[k];
    const pend = pending.find((p) => idx(p.row, p.col) === k);
    if (committed) {
      const el = tileEl(committed.letter, committed.blank, 'btile');
      if (lastCells.has(k)) el.classList.add('lastplay');
      if (fx.slapCells?.includes(k)) el.classList.add('slap');
      cell.appendChild(el);
    } else if (pend && handRevealed) {
      const el = tileEl(pend.as, pend.blank, 'btile pending');
      el.addEventListener('pointerdown', (e) => startDrag(e, el, { type: 'pending', pend }));
      cell.appendChild(el);
    }
  }
}

/* ---------------------------------------------------------------- rack */

function syncRack() {
  pending = [];
  selectedSlot = null;
  rackView = humanTurn() || G.mode === 'pass'
    ? G.state.racks[G.state.currentPlayer].map((letter) => ({ letter }))
    : G.state.racks[0].map((letter) => ({ letter }));
}

function renderRack() {
  const rack = $('rack');
  rack.innerHTML = '';
  if (!handRevealed) return;
  const usedSlots = new Set(pending.map((p) => p.slot));
  for (const slot of rackView) {
    if (usedSlots.has(slot)) continue;
    const el = tileEl(slot.letter === BLANK ? '★' : slot.letter, slot.letter === BLANK, 'rtile');
    if (slot === selectedSlot) el.classList.add('selected');
    el.addEventListener('pointerdown', (e) => startDrag(e, el, { type: 'rack', slot }));
    rack.appendChild(el);
  }
}

/* ---------------------------------------------------------------- status */

function pendingMove() {
  return {
    type: 'place',
    tiles: pending.map((p) => ({ row: p.row, col: p.col, letter: p.as, blank: p.blank })),
  };
}

function renderStatus() {
  const state = G.state;
  const chips = $('scoreChips');
  chips.innerHTML = '';
  for (let p = 0; p < state.numPlayers; p++) {
    const chip = document.createElement('div');
    chip.className = 'chip' + (state.currentPlayer === p && !state.gameOver ? ' active' : '');
    chip.innerHTML = `<span></span><span class="sc"></span>`;
    chip.children[0].textContent = playerName(p);
    chip.children[1].textContent = state.scores[p];
    chips.appendChild(chip);
  }
  const bag = document.createElement('div');
  bag.className = 'chip bag';
  bag.textContent = `🎒 ${state.bag.length}`;
  bag.title = 'Tiles left in the bag';
  chips.appendChild(bag);

  const msg = $('msg');
  const play = $('playBtn');
  msg.className = '';
  $('recallBtn').classList.toggle('hidden', pending.length === 0);
  $('swapBtn').disabled = !humanTurn() || state.bag.length === 0;
  $('passTurnBtn').disabled = !humanTurn();
  $('shuffleBtn').disabled = !handRevealed;
  if (!passArmed) { $('passTurnBtn').textContent = 'PASS'; $('passTurnBtn').classList.remove('confirm'); }

  if (state.gameOver) { play.disabled = true; return; }
  if (!humanTurn()) {
    play.disabled = true;
    play.textContent = 'PLAY';
    msg.textContent = 'SKIP is reading the lake…';
    return;
  }
  if (pending.length === 0) {
    play.disabled = true;
    play.textContent = 'PLAY';
    if (!dict) msg.textContent = 'Unpacking the dictionary…';
    else if (narrateLast()) msg.innerHTML = narrateLast();
    else if (state.board.every((c) => c === null)) {
      msg.innerHTML = `${playerName(state.currentPlayer)}: first word covers <b>City Hall Park ⭐</b>`;
    } else {
      msg.textContent = `${playerName(state.currentPlayer)}: drag tiles to build a word`;
    }
    return;
  }
  if (!dict) { play.disabled = true; msg.textContent = 'Unpacking the dictionary…'; return; }
  try {
    const result = checkPlacement(state, pendingMove(), isWord);
    play.disabled = false;
    play.textContent = `PLAY · ${result.score}`;
    msg.className = 'good';
    const names = result.words.map((w) => w.word).join(' + ');
    msg.textContent = `${names} for ${result.score}${result.fullBucket ? ' — FULL BUCKET! 🪣' : ''}`;
  } catch (e) {
    play.disabled = true;
    play.textContent = 'PLAY';
    msg.className = 'bad';
    msg.textContent = e.message;
  }
}

/* One-line recap of the previous move, shown at the start of a turn. */
function narrateLast() {
  const last = G.state.lastMove;
  if (!last || last.player === G.state.currentPlayer) return '';
  const who = playerName(last.player);
  if (last.type === 'place') {
    const best = last.words.slice().sort((a, b) => b.score - a.score)[0];
    return `${who} played <b>${best.word}</b> for ${last.score}${last.fullBucket ? ' — FULL BUCKET! 🪣' : ''}. Your move, ${playerName(G.state.currentPlayer)}.`;
  }
  if (last.type === 'exchange') return `${who} swapped ${last.count} tile${last.count === 1 ? '' : 's'}.`;
  return `${who} passed.`;
}

function render(fx = {}) {
  renderBoard(fx);
  renderRack();
  renderStatus();
}

/* ---------------------------------------------------------------- drag & tap
 * One pointer, one tile. Dragging lifts a ghost above the finger; drop on
 * an empty square to place, anywhere else to send it back to the rack.
 * A simple tap selects the tile instead — then tap any empty square. */

let drag = null;

function boardCellAt(clientX, clientY) {
  const rect = $('board').getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
  const col = Math.floor(((clientX - rect.left) / rect.width) * BOARD_SIZE);
  const row = Math.floor(((clientY - rect.top) / rect.height) * BOARD_SIZE);
  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return null;
  return { row, col };
}

function cellFree(row, col) {
  const k = idx(row, col);
  return G.state.board[k] === null && !pending.some((p) => idx(p.row, p.col) === k);
}

function startDrag(e, el, source) {
  if (!humanTurn() || drag || G.state.gameOver) return;
  e.preventDefault();
  const slot = source.type === 'rack' ? source.slot : source.pend.slot;
  const letter = source.type === 'rack'
    ? (slot.letter === BLANK ? '★' : slot.letter)
    : source.pend.as;
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost' + (slot.letter === BLANK ? ' blank-tile' : '');
  ghost.textContent = letter;
  drag = {
    source, el, ghost, slot,
    lift: e.pointerType === 'touch' ? 54 : 8,
    startX: e.clientX, startY: e.clientY, moved: false,
  };
  el.classList.add('ghosted');
  try { el.setPointerCapture(e.pointerId); } catch { /* stale pointer — element events still fire */ }
  el.addEventListener('pointermove', onDragMove);
  el.addEventListener('pointerup', onDragEnd);
  el.addEventListener('pointercancel', onDragCancel);
}

function onDragMove(e) {
  if (!drag) return;
  if (!drag.moved) {
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 7) return;
    drag.moved = true;
    document.body.appendChild(drag.ghost);
  }
  drag.ghost.style.left = `${e.clientX - 26}px`;
  drag.ghost.style.top = `${e.clientY - 26 - drag.lift}px`;
  cellEls.forEach((c) => c.classList.remove('drop-ok'));
  const cell = boardCellAt(e.clientX, e.clientY - drag.lift);
  drag.cell = cell && cellFree(cell.row, cell.col) ? cell : null;
  if (drag.cell) cellEls[idx(drag.cell.row, drag.cell.col)].classList.add('drop-ok');
}

function endDragCleanup() {
  drag.ghost.remove();
  drag.el.classList.remove('ghosted');
  cellEls.forEach((c) => c.classList.remove('drop-ok'));
  drag = null;
}

function onDragCancel() {
  if (!drag) return;
  endDragCleanup();
  render();
}

function onDragEnd(e) {
  if (!drag) return;
  const { source, slot, cell, moved } = drag;
  endDragCleanup();

  if (!moved) { // a tap
    if (source.type === 'pending') {
      pending = pending.filter((p) => p !== source.pend); // tap a placed tile: take it back
    } else {
      selectedSlot = selectedSlot === slot ? null : slot; // arm/disarm tap-to-place
    }
    render();
    return;
  }

  if (cell) {
    if (source.type === 'pending') {
      source.pend.row = cell.row;
      source.pend.col = cell.col;
    } else {
      placeFromRack(slot, cell.row, cell.col);
      return; // placeFromRack renders (or opens the blank picker)
    }
  } else if (source.type === 'pending') {
    pending = pending.filter((p) => p !== source.pend); // dropped off-board: back to the rack
  }
  render();
}

function placeFromRack(slot, row, col) {
  selectedSlot = null;
  if (slot.letter === BLANK) {
    pendingBlankDrop = { slot, row, col };
    $('blankPicker').classList.remove('hidden');
    render();
    return;
  }
  pending.push({ slot, letter: slot.letter, as: slot.letter, blank: false, row, col });
  render();
}

// tap-to-place: a selected rack tile lands on any free square you tap
$('board').addEventListener('click', (e) => {
  if (!humanTurn() || !selectedSlot) return;
  const cell = boardCellAt(e.clientX, e.clientY);
  if (cell && cellFree(cell.row, cell.col)) placeFromRack(selectedSlot, cell.row, cell.col);
});

/* ---------------------------------------------------------------- blank picker */

(() => {
  const grid = $('blankGrid');
  for (let i = 0; i < 26; i++) {
    const L = String.fromCharCode(65 + i);
    const btn = document.createElement('button');
    btn.textContent = L;
    btn.addEventListener('click', () => {
      if (!pendingBlankDrop) return;
      const { slot, row, col } = pendingBlankDrop;
      pending.push({ slot, letter: BLANK, as: L, blank: true, row, col });
      pendingBlankDrop = null;
      $('blankPicker').classList.add('hidden');
      render();
    });
    grid.appendChild(btn);
  }
})();

/* ---------------------------------------------------------------- moves */

function doMove(move) {
  const mover = G.state.currentPlayer;
  let result = null;
  try {
    if (move.type === 'place') result = checkPlacement(G.state, move, isWord);
    G.state = applyMove(G.state, move, isWord);
  } catch (e) {
    $('msg').className = 'bad';
    $('msg').textContent = e.message;
    return;
  }
  save();
  pending = [];
  passArmed = false;

  if (G.state.gameOver) {
    handRevealed = true;
    render({ slapCells: result ? G.state.lastMove.cells : [] });
    setTimeout(() => showGameOver(), move.type === 'place' ? 1100 : 400);
    return;
  }

  if (G.mode === 'pass') {
    handRevealed = false; // curtain down before the next player's rack shows
    render();
    setTimeout(() => showHandoff(G.state.currentPlayer), move.type === 'place' ? 850 : 350);
  } else {
    syncRack();
    render({ slapCells: move.type === 'place' ? G.state.lastMove.cells : [] });
    if (G.state.currentPlayer === BOT) botTimer = setTimeout(botStep, 1000);
  }
}

$('playBtn').addEventListener('click', () => {
  if (!humanTurn() || pending.length === 0) return;
  doMove(pendingMove());
});

$('recallBtn').addEventListener('click', () => { pending = []; selectedSlot = null; render(); });

$('shuffleBtn').addEventListener('click', () => {
  for (let i = rackView.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [rackView[i], rackView[j]] = [rackView[j], rackView[i]];
  }
  render();
});

$('passTurnBtn').addEventListener('click', () => {
  if (!humanTurn()) return;
  if (!passArmed) {
    passArmed = true;
    $('passTurnBtn').textContent = 'SURE?';
    $('passTurnBtn').classList.add('confirm');
    setTimeout(() => { passArmed = false; renderStatus(); }, 2200);
    return;
  }
  doMove({ type: 'pass' });
});

/* ---------------------------------------------------------------- swap */

let swapPick = new Set();

$('swapBtn').addEventListener('click', () => {
  if (!humanTurn() || G.state.bag.length === 0) return;
  pending = [];
  selectedSlot = null;
  render();
  swapPick = new Set();
  renderSwap();
  $('swapOverlay').classList.remove('hidden');
});

function renderSwap() {
  const wrap = $('swapTiles');
  wrap.innerHTML = '';
  const rack = G.state.racks[G.state.currentPlayer];
  rack.forEach((letter, i) => {
    const el = tileEl(letter === BLANK ? '★' : letter, letter === BLANK, 'rtile');
    if (swapPick.has(i)) el.classList.add('selected');
    el.addEventListener('click', () => {
      if (swapPick.has(i)) swapPick.delete(i);
      else if (swapPick.size < G.state.bag.length) swapPick.add(i);
      renderSwap();
    });
    wrap.appendChild(el);
  });
  $('swapGoBtn').disabled = swapPick.size === 0;
  $('swapNote').textContent = `The bag holds ${G.state.bag.length} tiles — swap up to ${Math.min(G.state.bag.length, rack.length)}. Swapping ends your turn.`;
}

$('swapGoBtn').addEventListener('click', () => {
  const rack = G.state.racks[G.state.currentPlayer];
  const tiles = [...swapPick].map((i) => rack[i]);
  $('swapOverlay').classList.add('hidden');
  if (tiles.length > 0) doMove({ type: 'exchange', tiles });
});
$('swapCancelBtn').addEventListener('click', () => $('swapOverlay').classList.add('hidden'));

/* ---------------------------------------------------------------- bot */

function botStep() {
  if (!G || G.mode !== 'bot' || G.state.gameOver || G.state.currentPlayer !== BOT) return;
  if (!dict) { botTimer = setTimeout(botStep, 300); return; } // dictionary still loading
  if (!lexicon) lexicon = buildLexicon(dict);
  const move = chooseMove(G.state, lexicon);
  doMove(move);
}

/* ---------------------------------------------------------------- flow */

function startGame(mode, numPlayers) {
  clearTimeout(botTimer);
  G = { mode, state: createInitialState({ numPlayers, seed: newSeed() }) };
  save();
  buildBoard();
  if (mode === 'pass') {
    handRevealed = false;
    showHandoff(G.state.currentPlayer);
  } else {
    handRevealed = true;
    syncRack();
    show('game');
    render();
  }
}

function showHandoff(player) {
  handRevealed = false;
  $('handoffTitle').textContent = 'Pass the phone to ' + playerName(player);
  const last = narrateLast();
  $('handoffLast').innerHTML = last;
  show('handoff');
}

$('handoffBtn').addEventListener('click', () => {
  handRevealed = true;
  syncRack();
  show('game');
  render();
});

const WIN_LINES = [
  'That board reads better than the Sunday paper.',
  'Sweeter than a creemee on Church Street.',
  'Words that good deserve a booth at the farmers market.',
  'Somewhere on the lake, SKIP just dipped his sails in respect.',
];

function showGameOver() {
  clearTimeout(botTimer);
  save(); // clears the save — game's done
  const st = getStatus(G.state);
  const names = st.winners.map(playerName);

  $('go-title').textContent = st.winners.length > 1
    ? 'A TIE AT THE CROSSING'
    : (G.mode === 'bot' && st.winners[0] === BOT ? 'SKIP TAKES IT ⛵' : names[0].toUpperCase() + ' WINS! 🍁');

  let line = '';
  if (st.reason === 'passes') line = 'Two full rounds of passes — the tiles have spoken. ';
  else line = `${playerName(G.state.outPlayer)} went out and collected the leftovers. `;
  if (st.winners.length > 1) line += `${names.join(' & ')} split the maple candy.`;
  else if (G.mode === 'bot' && st.winners[0] === BOT) line += 'The old skipper knows his way around a board. Demand a rematch.';
  else line += WIN_LINES[(Math.random() * WIN_LINES.length) | 0];
  $('go-line').textContent = line;

  const table = $('go-table');
  table.innerHTML = '';
  const order = [...Array(G.state.numPlayers).keys()].sort((a, b) => G.state.scores[b] - G.state.scores[a]);
  for (const p of order) {
    const adj = G.state.adjustments[p];
    const row = document.createElement('div');
    row.className = 'go-row' + (st.winners.includes(p) ? ' winner' : '');
    row.innerHTML = `<span class="nm"></span><span class="adj"></span><span class="fin"></span>`;
    row.querySelector('.nm').textContent = playerName(p);
    row.querySelector('.adj').textContent =
      (adj.leftover ? `−${adj.leftover} left over` : '') +
      (adj.bonus ? `${adj.leftover ? ' · ' : ''}+${adj.bonus} collected` : '');
    row.querySelector('.fin').textContent = G.state.scores[p];
    table.appendChild(row);
  }
  show('gameover');
}

/* ---------------------------------------------------------------- menu */

$('botBtn').addEventListener('click', () => startGame('bot', 2));
$('passBtn').addEventListener('click', () => $('countRow').classList.toggle('hidden'));
document.querySelectorAll('.count-btn').forEach((btn) => {
  btn.addEventListener('click', () => startGame('pass', +btn.dataset.n));
});

$('resumeBtn').addEventListener('click', () => {
  const saved = loadSave();
  if (!saved) { $('resumeBtn').classList.add('hidden'); return; }
  clearTimeout(botTimer);
  G = saved;
  buildBoard();
  if (G.mode === 'pass') {
    showHandoff(G.state.currentPlayer);
  } else {
    handRevealed = true;
    syncRack();
    show('game');
    render();
    if (G.state.currentPlayer === BOT) botTimer = setTimeout(botStep, 900);
  }
});

function goMenu() {
  clearTimeout(botTimer);
  pending = [];
  pendingBlankDrop = null;
  $('blankPicker').classList.add('hidden');
  $('swapOverlay').classList.add('hidden');
  $('resumeBtn').classList.toggle('hidden', !loadSave());
  show('menu');
}

$('homeBtn').addEventListener('click', goMenu);
$('menuBtn').addEventListener('click', goMenu);
$('againBtn').addEventListener('click', () => startGame(G.mode, G.state.numPlayers));
$('helpBtn').addEventListener('click', () => $('helpOverlay').classList.remove('hidden'));

document.querySelectorAll('.overlay').forEach((ov) => {
  ov.addEventListener('click', (e) => {
    if (e.target !== ov) return;
    if (ov.id === 'blankPicker') pendingBlankDrop = null;
    ov.classList.add('hidden');
  });
  ov.querySelector('[data-close]')?.addEventListener('click', () => ov.classList.add('hidden'));
});

/* ---------------------------------------------------------------- boot */

goMenu();
fetch('data/words.txt')
  .then((res) => res.text())
  .then((text) => {
    dict = new Set(text.split('\n').map((w) => w.trim()).filter(Boolean));
    if (G) renderStatus();
  })
  .catch(() => {
    $('msg').className = 'bad';
    $('msg').textContent = 'Could not load the dictionary — check your connection and reload.';
  });
