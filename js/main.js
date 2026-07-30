/* BTOWN CROSSINGS — UI only. All rules live in engine.js; SKIP's brain
 * lives in bot.js. This file renders state, handles drag/tap tile
 * placement, paces the bot with timers, and saves/restores the game
 * (the whole game state is one JSON-serializable object, so localStorage
 * resume is a stringify away). */

import {
  createInitialState, checkPlacement, applyMove, getStatus,
  BOARD_SIZE, CENTER, BLANK, TILE_POINTS, PREMIUMS, PREMIUM_INFO, idx,
} from './engine.js';
import { buildLexicon, chooseMove } from './bot.js';
import { OnlineMatch, savedSession, clearSession, getName } from './rooms.js';

const SAVE_KEY = 'btown-crossings-save-v1';
const GAME = 'btown-crossings';
const BOT = 1; // in bot mode, player 0 is the human, player 1 is SKIP

const $ = (id) => document.getElementById(id);
const screens = { menu: $('menu'), handoff: $('handoff'), game: $('game'), gameover: $('gameover') };
const onlinePanel = $('onlinePanel');
const opTitle = $('opTitle');
const opName = $('opName');
const opCodeWrap = $('opCodeWrap');
const opCode = $('opCode');
const opError = $('opError');
const lobbyEl = $('lobby');
const lobbyCode = $('lobbyCode');
const rejoinBtn = $('rejoinBtn');

let dict = null;      // Set of lowercase words
let lexicon = null;   // bot brain, built on first bot game
let G = null;         // { mode: 'bot' | 'pass' | 'online', state }
let rackView = [];    // [{ letter }] — this turn's rack, in display order
let pending = [];     // [{ slot, letter, as, blank, row, col }] — uncommitted tiles
let handRevealed = true;
let selectedSlot = null;     // rack tile picked by tap, waiting for a cell
let pendingBlankDrop = null; // { slot, row, col } waiting on the letter picker
let botTimer = null;
let passArmed = false;
let cellEls = [];
let online = null;    // { match, myPlayer } while seated at an online table
let onlineAbandoned = false;
let panelIntent = 'host';
let pollErrors = 0;

const newSeed = () => (Math.random() * 2 ** 31) | 0;
const isWord = (w) => dict !== null && dict.has(w);

function playerName(p) {
  if (G.mode === 'bot') return p === BOT ? 'SKIP' : 'You';
  if (G.mode === 'online') {
    if (p === online?.myPlayer) return 'You';
    return online?.match.opponents().find((opp) => opp.seat === p)?.name || 'Your friend';
  }
  return 'Player ' + (p + 1);
}

function humanTurn() {
  if (!G || G.state.gameOver) return false;
  if (G.mode === 'bot') return G.state.currentPlayer !== BOT;
  if (G.mode === 'online') {
    return online !== null &&
      G.state.currentPlayer === online.myPlayer &&
      online.match.status === 'playing' &&
      !onlineAbandoned;
  }
  return true;
}

function show(name) {
  for (const key of Object.keys(screens)) screens[key].classList.toggle('hidden', key !== name);
}

/* ---------------------------------------------------------------- save */

function save() {
  try {
    if (G?.mode === 'online') return; // rooms.js owns online resume
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
  const rackPlayer = G.mode === 'online'
    ? online.myPlayer
    : (humanTurn() || G.mode === 'pass' ? G.state.currentPlayer : 0);
  // Online state contains both racks for deterministic sync, but the honest
  // interface deliberately reads and renders only this phone's seat.
  rackView = G.state.racks[rackPlayer].map((letter) => ({ letter }));
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
    if (G.mode === 'online') {
      const opp = online.match.opponents()[0] || {};
      if (onlineAbandoned || opp.left) {
        msg.textContent = `${opp.name || 'Your friend'} left the table.`;
      } else if (pollErrors >= 3) {
        msg.textContent = 'The connection wandered off Church Street — hanging tight…';
      } else {
        msg.textContent = opp.away
          ? `${opp.name || 'Your friend'} stepped away…`
          : `Waiting on ${opp.name || 'your friend'}…`;
      }
    } else {
      msg.textContent = 'SKIP is reading the lake…';
    }
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
  // Online names come from the network; this string is later inserted as
  // markup only so the trusted word/score emphasis can remain.
  const who = escapeHtml(playerName(last.player));
  if (last.type === 'place') {
    const best = last.words.slice().sort((a, b) => b.score - a.score)[0];
    const next = escapeHtml(playerName(G.state.currentPlayer));
    return `${who} played <b>${best.word}</b> for ${last.score}${last.fullBucket ? ' — FULL BUCKET! 🪣' : ''}. Your move, ${next}.`;
  }
  if (last.type === 'exchange') return `${who} swapped ${last.count} tile${last.count === 1 ? '' : 's'}.`;
  return `${who} passed.`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
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

/* `ignore` is the pending tile being moved — the square it currently sits on
 * counts as free for it, so dropping it back where it started is a no-op
 * instead of shipping it to the rack. */
function cellFree(row, col, ignore) {
  const k = idx(row, col);
  return G.state.board[k] === null &&
    !pending.some((p) => p !== ignore && idx(p.row, p.col) === k);
}

/* Drag loupe: 24px cells hide under a fingertip, so while a drag is over the
 * board a magnified preview of the target cell (and its coordinate) floats
 * above the lifted ghost. Tap-to-place never shows it. */
const loupe = document.createElement('div');
loupe.id = 'dragLoupe';
loupe.className = 'hidden';
loupe.innerHTML = '<div class="loupe-sq"><span class="loupe-letter"></span></div><div class="loupe-tag"></div>';
document.body.appendChild(loupe);

function updateLoupe(e) {
  if (!drag?.cell) { loupe.classList.add('hidden'); return; }
  const { row, col } = drag.cell;
  const k = idx(row, col);
  const prem = PREMIUMS[k];
  const sq = loupe.querySelector('.loupe-sq');
  sq.className = 'loupe-sq' + (prem ? ' sq-' + prem : k === CENTER ? ' ctr' : '');
  const letterEl = loupe.querySelector('.loupe-letter');
  letterEl.textContent = drag.letter;
  letterEl.classList.toggle('blank-tile', drag.slot.letter === BLANK);
  loupe.querySelector('.loupe-tag').textContent =
    String.fromCharCode(65 + col) + (row + 1) + (prem ? ' · ' + prem : k === CENTER ? ' · ⭐' : '');
  loupe.style.left = `${Math.min(Math.max(e.clientX, 46), window.innerWidth - 46)}px`;
  loupe.style.top = `${e.clientY - drag.lift - 34}px`;
  loupe.classList.remove('hidden');
}

function startDrag(e, el, source) {
  // A previous gesture that never got its pointerup would leave `drag` set
  // and freeze every tile on the board. Clear it and carry on.
  if (drag) endDragCleanup();
  if (!humanTurn() || G.state.gameOver) return;
  e.preventDefault();
  const slot = source.type === 'rack' ? source.slot : source.pend.slot;
  const letter = source.type === 'rack'
    ? (slot.letter === BLANK ? '★' : slot.letter)
    : source.pend.as;
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost' + (slot.letter === BLANK ? ' blank-tile' : '');
  ghost.textContent = letter;
  drag = {
    source, el, ghost, slot, letter,
    pointerId: e.pointerId,
    prevSelected: selectedSlot,
    lift: e.pointerType === 'touch' ? 54 : 8,
    startX: e.clientX, startY: e.clientY, moved: false,
  };
  selectedSlot = null; // a drag must not also fire the tap-to-place click
  el.classList.add('ghosted');
  try { el.setPointerCapture(e.pointerId); } catch { /* capture is a nicety, not the contract */ }
  // The rest of the gesture is tracked on the window, never on the tile.
  // Tiles are torn down and rebuilt by every render, and pointer capture can
  // fail or be released mid-drag — either way the tile stops receiving events
  // and a tile-bound pointerup would never arrive, hanging the board.
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragCancel);
}

/* Ignore the other fingers: one pointer owns the drag from down to up. */
function isDragPointer(e) {
  return drag !== null && e.pointerId === drag.pointerId;
}

function onDragMove(e) {
  if (!isDragPointer(e)) return;
  if (!drag.moved) {
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 7) return;
    drag.moved = true;
    document.body.appendChild(drag.ghost);
  }
  drag.ghost.style.left = `${e.clientX - 26}px`;
  drag.ghost.style.top = `${e.clientY - 26 - drag.lift}px`;
  cellEls.forEach((c) => c.classList.remove('drop-ok'));
  const cell = boardCellAt(e.clientX, e.clientY - drag.lift);
  const self = drag.source.type === 'pending' ? drag.source.pend : null;
  drag.cell = cell && cellFree(cell.row, cell.col, self) ? cell : null;
  if (drag.cell) cellEls[idx(drag.cell.row, drag.cell.col)].classList.add('drop-ok');
  updateLoupe(e);
}

function endDragCleanup() {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragCancel);
  drag.ghost.remove();
  drag.el.classList.remove('ghosted');
  cellEls.forEach((c) => c.classList.remove('drop-ok'));
  loupe.classList.add('hidden');
  drag = null;
}

function onDragCancel(e) {
  if (!isDragPointer(e)) return;
  endDragCleanup();
  render();
}

function onDragEnd(e) {
  if (!isDragPointer(e)) return;
  const { source, slot, cell, moved, prevSelected } = drag;
  endDragCleanup();

  if (!moved) { // a tap
    if (source.type === 'pending') {
      pending = pending.filter((p) => p !== source.pend); // tap a placed tile: take it back
    } else {
      selectedSlot = prevSelected === slot ? null : slot; // arm/disarm tap-to-place
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

/* Premium tooltip: press an uncovered premium square when you're NOT
 * mid-placement and a small card names it, Burlington style
 * (e.g. "Waterfront · letter ×3"). Auto-dismisses, or tap anywhere. */
const premTip = document.createElement('div');
premTip.id = 'premTip';
premTip.className = 'hidden';
premTip.innerHTML = '<span class="lg"></span><b></b><span></span>';
document.body.appendChild(premTip);
let premTipTimer = null;
let premTipEvent = null; // the press that opened it must not also dismiss it

function hidePremTip() {
  clearTimeout(premTipTimer);
  premTip.classList.add('hidden');
}

$('board').addEventListener('pointerdown', (e) => {
  if (drag || selectedSlot || pending.length > 0) return; // mid-placement: presses place tiles
  if (e.target.closest('.btile')) return; // tile presses run the drag/tap flow
  const cell = boardCellAt(e.clientX, e.clientY);
  if (!cell) return;
  const k = idx(cell.row, cell.col);
  const type = PREMIUMS[k];
  if (!type || G.state.board[k] !== null) return;
  premTip.children[0].className = 'lg sq-' + type;
  premTip.children[1].textContent = PREMIUM_INFO[type].name;
  premTip.children[2].textContent = ` · ${type[1] === 'L' ? 'letter' : 'word'} ×${type[0]}`;
  const rect = cellEls[k].getBoundingClientRect();
  premTip.style.left = `${Math.min(Math.max(rect.left + rect.width / 2, 80), window.innerWidth - 80)}px`;
  premTip.style.top = `${rect.top - 6}px`;
  premTip.classList.remove('hidden');
  premTipEvent = e;
  clearTimeout(premTipTimer);
  premTipTimer = setTimeout(hidePremTip, 2000);
});

document.addEventListener('pointerdown', (e) => {
  if (e !== premTipEvent) hidePremTip();
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
  if (G.mode === 'online' && !humanTurn()) return;
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
  if (G.mode === 'online') {
    syncRack();
    pushOnline(G.state);
  }

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
    if (G.mode !== 'online') syncRack();
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

/* ------------------------------------------------------------- online play */
// Two phones share one pure engine state through js/rooms.js. Seat numbers
// are engine player numbers: createInitialState() opens with player 0, so the
// host in seat 0 moves first and the friend who joins is player 1.
//
// The full state reaches both friendly-game phones for deterministic sync,
// including racks and the seeded bag. The UI below intentionally renders only
// this phone's rack and never exposes either rack or the bag contents elsewhere.

$('hostBtn').addEventListener('click', () => openOnlinePanel('host'));
$('joinBtn').addEventListener('click', () => openOnlinePanel('join'));
$('opCancel').addEventListener('click', closeOnlinePanel);
$('opGo').addEventListener('click', onlineGo);
$('lobbyCancel').addEventListener('click', cancelLobby);
rejoinBtn.addEventListener('click', rejoinTable);
opCode.addEventListener('input', () => {
  opCode.value = opCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
[opName, opCode].forEach((el) => el.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') onlineGo();
}));

function openOnlinePanel(intent) {
  panelIntent = intent;
  opTitle.textContent = intent === 'host' ? 'START A TABLE' : 'JOIN A TABLE';
  $('opGo').textContent = intent === 'host' ? 'GET A CODE' : 'TAKE YOUR SEAT';
  opCodeWrap.classList.toggle('hidden', intent === 'host');
  opError.classList.add('hidden');
  opName.value = opName.value || getName();
  onlinePanel.classList.remove('hidden');
  (intent === 'join' && opName.value ? opCode : opName).focus();
}

function closeOnlinePanel() {
  onlinePanel.classList.add('hidden');
}

const FRIENDLY_ROOM_ERRORS = {
  not_found: 'No table with that code — double-check the letters.',
  room_full: 'That table already has two wordsmiths.',
  room_started: 'That table already has two wordsmiths.',
  not_ready: "Online play isn't switched on yet — check back soon!",
  offline: "Can't reach the table — are you online?",
};

function friendlyRoomError(err) {
  if (err && err.code === 'wrong_game') {
    return `That code belongs to ${String(err.detail || 'another Btown game').replace(/-/g, ' ')}.`;
  }
  return (err && FRIENDLY_ROOM_ERRORS[err.code]) || 'The tiles got scrambled — please try again.';
}

async function onlineGo() {
  if ($('opGo').disabled) return; // Enter key can't double-submit
  const name = opName.value.trim();
  if (!name) {
    opError.textContent = 'Every wordsmith needs a name.';
    opError.classList.remove('hidden');
    opName.focus();
    return;
  }

  const go = $('opGo');
  go.disabled = true;
  opError.classList.add('hidden');
  try {
    if (panelIntent === 'host') {
      const fresh = createInitialState({ numPlayers: 2, seed: newSeed() });
      const match = await OnlineMatch.create({
        game: GAME, name, state: fresh, seats: 2,
      });
      closeOnlinePanel();
      openLobby(match);
    } else {
      const code = opCode.value.trim();
      if (code.length !== 4) {
        opError.textContent = 'The table code is 4 characters.';
        opError.classList.remove('hidden');
        opCode.focus();
        return;
      }
      const match = await OnlineMatch.join({ game: GAME, code, name });
      closeOnlinePanel();
      enterOnlineGame(match);
    }
  } catch (err) {
    opError.textContent = friendlyRoomError(err);
    opError.classList.remove('hidden');
  } finally {
    go.disabled = false;
  }
}

function openLobby(match) {
  if (lobbyEl._match && lobbyEl._match !== match) lobbyEl._match.stop();
  lobbyCode.textContent = match.code;
  lobbyEl.classList.remove('hidden');
  match.start({
    onStatus: (status) => {
      if (status === 'playing') {
        lobbyEl.classList.add('hidden');
        enterOnlineGame(match);
      }
    },
    onError: () => {}, // the next waiting-room poll gets another clean try
  });
  lobbyEl._match = match;
}

function cancelLobby() {
  const match = lobbyEl._match;
  if (match) match.leave();
  lobbyEl._match = null;
  lobbyEl.classList.add('hidden');
  refreshRejoin();
}

async function rejoinTable() {
  rejoinBtn.disabled = true;
  try {
    const match = await OnlineMatch.resume({ game: GAME });
    if (match.status === 'waiting') openLobby(match);
    else enterOnlineGame(match);
  } catch (err) {
    // Only a room that's truly gone forfeits the session — a flaky
    // connection must not delete the one path back to the game.
    if (err && (err.code === 'not_found' || err.code === 'not_seated' || err.code === 'room_started')) {
      clearSession(GAME);
      refreshRejoin();
    }
  } finally {
    rejoinBtn.disabled = false;
  }
}

function refreshRejoin() {
  const saved = savedSession(GAME);
  rejoinBtn.classList.toggle('hidden', !saved);
  if (saved) rejoinBtn.textContent = `↩ REJOIN YOUR TABLE (${saved.code})`;
}

function enterOnlineGame(match) {
  clearTimeout(botTimer);
  online = { match, myPlayer: match.seat };
  onlineAbandoned = false;
  pollErrors = 0;
  G = { mode: 'online', state: match.state };
  handRevealed = true;
  buildBoard();
  applyOnlineState(match.state);
  onlinePanel.classList.add('hidden');
  lobbyEl.classList.add('hidden');
  lobbyEl._match = null;
  match.start({
    onState: onRemoteState,
    onStatus: onRemoteStatus,
    onPresence: onRemotePresence,
    onError: onRoomPollError,
  });
  if (match.status === 'over' && !G.state.gameOver) onRemoteStatus('over');
}

/** Cold repaint handles opponent moves, refreshes, conflicts, and rematches. */
function applyOnlineState(newState) {
  if (!online) return;
  if (drag) endDragCleanup();
  pending = [];
  selectedSlot = null;
  pendingBlankDrop = null;
  passArmed = false;
  swapPick = new Set();
  $('blankPicker').classList.add('hidden');
  $('swapOverlay').classList.add('hidden');
  G.state = newState;
  handRevealed = true;
  syncRack();
  if (newState.gameOver) showGameOver();
  else {
    show('game');
    render();
  }
}

function onRemoteState(newState) {
  onlineAbandoned = false;
  pollErrors = 0;
  applyOnlineState(newState);
}

function onRemoteStatus(status) {
  if (status !== 'over' || G.state.gameOver) return;
  onlineAbandoned = true;
  pending = [];
  selectedSlot = null;
  syncRack();
  show('game');
  render();
}

function onRemotePresence(opponents) {
  pollErrors = 0; // this callback only fires on a successful poll
  const opp = opponents[0];
  if (opp?.left && !G.state.gameOver) onlineAbandoned = true;
  $('againBtn').disabled = Boolean(opp?.left);
  if (!G.state.gameOver) renderStatus();
}

function onRoomPollError(err) {
  if (err && err.code === 'not_found') {
    online.match.stop();
    clearSession(GAME);
    online = null;
    G = null;
    show('menu');
    refreshRejoin();
    return;
  }
  pollErrors++;
  if (G && !G.state.gameOver) renderStatus();
}

async function pushOnline(newState) {
  if (!online) return;
  const over = getStatus(newState).status === 'over';
  try {
    await online.match.push(newState, { over });
    pollErrors = 0;
    if (G?.state === newState && !newState.gameOver) renderStatus();
  } catch (err) {
    if (err && err.code === 'version_conflict') {
      applyOnlineState(online.match.state);
      return;
    }
    setTimeout(async () => {
      if (!online || G?.state !== newState) return;
      try {
        await online.match.push(newState, { over });
        pollErrors = 0;
      } catch (retryErr) {
        if (retryErr?.code === 'version_conflict') applyOnlineState(online.match.state);
        else onRoomPollError(retryErr);
      }
    }, 1500);
  }
}

async function onlineRematch() {
  if (!online || !G.state.gameOver) return;
  $('againBtn').disabled = true;
  const fresh = createInitialState({ numPlayers: 2, seed: newSeed() });
  applyOnlineState(fresh);
  try {
    await online.match.push(fresh, {});
    pollErrors = 0;
    render();
  } catch (err) {
    if (err && err.code === 'version_conflict') {
      applyOnlineState(online.match.state);
    } else {
      onRoomPollError(err);
      applyOnlineState(online.match.state);
    }
  } finally {
    $('againBtn').disabled = false;
  }
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
  refreshRejoin();
}

function leaveOnlineToMenu() {
  if (online) {
    online.match.leave();
    online = null;
  }
  G = null;
  $('homeBtn').dataset.armed = '';
  $('homeBtn').textContent = '🏠';
  goMenu();
}

function requestHome() {
  if (!online) {
    goMenu();
    return;
  }
  const home = $('homeBtn');
  if (home.dataset.armed !== '1') {
    home.dataset.armed = '1';
    home.textContent = '×';
    home.setAttribute('aria-label', 'Tap again to leave the online table');
    setTimeout(() => {
      home.dataset.armed = '';
      home.textContent = '🏠';
      home.setAttribute('aria-label', 'Back to menu');
    }, 2500);
    return;
  }
  leaveOnlineToMenu();
}

$('homeBtn').addEventListener('click', requestHome);
$('menuBtn').addEventListener('click', () => {
  if (online) leaveOnlineToMenu();
  else goMenu();
});
$('againBtn').addEventListener('click', () => {
  if (online) onlineRematch();
  else startGame(G.mode, G.state.numPlayers);
});
$('helpBtn').addEventListener('click', () => $('helpOverlay').classList.remove('hidden'));

document.querySelectorAll('.overlay').forEach((ov) => {
  // Online setup/lobby have explicit cancel actions; hiding the lobby without
  // leaving would strand a live polling room behind the menu.
  if (['dictOverlay', 'onlinePanel', 'lobby'].includes(ov.id)) return;
  ov.addEventListener('click', (e) => {
    if (e.target !== ov) return;
    if (ov.id === 'blankPicker') pendingBlankDrop = null;
    ov.classList.add('hidden');
  });
  ov.querySelector('[data-close]')?.addEventListener('click', () => ov.classList.add('hidden'));
});

/* ---------------------------------------------------------------- boot */

goMenu();

function loadDictionary() {
  $('dictOverlay').classList.add('hidden');
  fetch('data/words.txt')
    .then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    })
    .then((text) => {
      dict = new Set(text.split('\n').map((w) => w.trim()).filter(Boolean));
      if (G) renderStatus();
    })
    .catch(() => $('dictOverlay').classList.remove('hidden'));
}

$('dictRetryBtn').addEventListener('click', loadDictionary);
loadDictionary();
