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
import { sound } from './audio.js';
import {
  lbEnabled, fetchTop, submitScore, renamePlayer, monthLabel,
  getName as lbGetName, playerId as lbPlayerId,
} from './leaderboard.js';

const SAVE_KEY = 'btown-crossings-save-v1';
const GAME = 'btown-crossings';
const BOT = 1; // in bot mode, player 0 is the human, player 1 is SKIP
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

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
let handoffTimer = null;
let gameOverTimer = null;
let passArmed = false;
let cellEls = [];
let online = null;    // { match, myPlayer } while seated at an online table
let onlineAbandoned = false;
let panelIntent = 'host';
let pollErrors = 0;
let lastTransitionKey = '';
let suppressNextOnlineEffect = false;
let effectRun = 0;
let scoreRaf = 0;
let invalidTimer = null;
const effectTimers = new Set();

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

function transitionKey(state) {
  if (!state) return '';
  const last = state.lastMove;
  return JSON.stringify({
    last,
    scores: state.scores,
    currentPlayer: state.currentPlayer,
    passStreak: state.passStreak,
    bag: state.bag.length,
    rng: state.rng,
    gameOver: state.gameOver,
  });
}

function scheduleEffect(fn, delay) {
  const run = effectRun;
  const timer = setTimeout(() => {
    effectTimers.delete(timer);
    if (run === effectRun) fn();
  }, delay);
  effectTimers.add(timer);
  return timer;
}

function clearInvalidFeedback() {
  clearTimeout(invalidTimer);
  invalidTimer = null;
  $('board').classList.remove('invalid-pulse');
  cellEls.forEach((cell) => cell.querySelector('.btile')?.classList.remove('invalid'));
}

function clearEffects({ stopSound = false } = {}) {
  effectRun++;
  for (const timer of effectTimers) clearTimeout(timer);
  effectTimers.clear();
  if (scoreRaf) cancelAnimationFrame(scoreRaf);
  scoreRaf = 0;
  clearInvalidFeedback();
  $('fxLayer').replaceChildren();
  $('board').classList.remove('word-impact');
  cellEls.forEach((cell) => cell.classList.remove('premium-fired'));
  if (stopSound) sound.stop();
}

function orderedCells(cells) {
  const ordered = cells.slice();
  const rows = new Set(ordered.map((k) => Math.floor(k / BOARD_SIZE)));
  const cols = new Set(ordered.map((k) => k % BOARD_SIZE));
  if (rows.size === 1) ordered.sort((a, b) => (a % BOARD_SIZE) - (b % BOARD_SIZE));
  else if (cols.size === 1) ordered.sort((a, b) => Math.floor(a / BOARD_SIZE) - Math.floor(b / BOARD_SIZE));
  return ordered;
}

function placementFx(cells) {
  const cascadeCells = orderedCells(cells || []);
  return {
    cascadeCells,
    premiumCells: cascadeCells.filter((k) => PREMIUMS[k]),
  };
}

function showInvalidFeedback() {
  clearInvalidFeedback();
  const board = $('board');
  board.classList.add('invalid-pulse');
  pending.forEach((tile) => {
    cellEls[idx(tile.row, tile.col)]?.querySelector('.btile')?.classList.add('invalid');
  });
  invalidTimer = setTimeout(clearInvalidFeedback, 420);
}

function showScoreFloat(score, cells) {
  const rects = cells.map((k) => cellEls[k]?.getBoundingClientRect()).filter(Boolean);
  if (rects.length === 0) return;
  const left = (Math.min(...rects.map((r) => r.left)) + Math.max(...rects.map((r) => r.right))) / 2;
  const top = Math.min(...rects.map((r) => r.top));
  const callout = document.createElement('div');
  callout.className = 'score-float';
  callout.textContent = `+${score}`;
  callout.style.left = `${left}px`;
  callout.style.top = `${top}px`;
  $('fxLayer').appendChild(callout);
  scheduleEffect(() => callout.remove(), 900);
}

function showFullBucket(cells) {
  const banner = document.createElement('div');
  banner.className = 'bucket-banner';
  banner.innerHTML = '<strong>FULL BUCKET 🪣</strong><span>All seven tiles · +40</span>';
  const wave = document.createElement('div');
  wave.className = 'bucket-wave';
  for (const [i, k] of cells.slice(0, 7).entries()) {
    const tile = document.createElement('i');
    tile.textContent = G.state.board[k]?.letter || '';
    tile.style.setProperty('--wave-delay', `${i * 55}ms`);
    wave.appendChild(tile);
  }
  banner.appendChild(wave);
  $('fxLayer').appendChild(banner);
  scheduleEffect(() => banner.remove(), 1250);
}

function presentPlacement(lastMove, result = null) {
  clearEffects({ stopSound: true });
  const cells = orderedCells(lastMove.cells || []);
  $('board').classList.add('word-impact');
  // Reapply the landing classes after clearEffects removed only stale effects.
  cells.forEach((k, i) => {
    const tile = cellEls[k]?.querySelector('.btile');
    if (tile) {
      tile.classList.add('land');
      tile.style.setProperty('--land-delay', `${i * 40}ms`);
    }
    if (PREMIUMS[k]) cellEls[k]?.classList.add('premium-fired');
  });
  const wordCells = result?.words?.slice().sort((a, b) => b.cells.length - a.cells.length)[0]?.cells || cells;
  showScoreFloat(lastMove.score, wordCells);
  const words = lastMove.words.map((word) => word.word).join(' + ');
  $('msg').className = 'good';
  $('msg').textContent = `${playerName(lastMove.player)} played ${words} for ${lastMove.score}${lastMove.fullBucket ? ' — FULL BUCKET! 🪣' : ''}`;
  if (lastMove.fullBucket) {
    showFullBucket(cells);
    sound.fullBucket(lastMove.score);
  } else {
    sound.wordScore(lastMove.score);
  }
  scheduleEffect(() => {
    $('board').classList.remove('word-impact');
    cellEls.forEach((cell) => cell.classList.remove('premium-fired'));
  }, 700);
  scheduleEffect(() => {
    if (G && !G.state.gameOver && !screens.game.classList.contains('hidden')) renderStatus();
  }, 900);
}

function updateMuteButton() {
  const mute = $('mute');
  mute.textContent = sound.muted ? '🔇' : '🔊';
  mute.setAttribute('aria-pressed', String(sound.muted));
  mute.setAttribute('aria-label', sound.muted ? 'Unmute sound' : 'Mute sound');
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
  const cascadeOrder = new Map((fx.cascadeCells || []).map((k, i) => [k, i]));
  const premiumCells = new Set(fx.premiumCells || []);
  for (let k = 0; k < cellEls.length; k++) {
    const cell = cellEls[k];
    cell.querySelector('.btile')?.remove();
    cell.classList.remove('drop-ok', 'premium-fired');
    const committed = G.state.board[k];
    const pend = pending.find((p) => idx(p.row, p.col) === k);
    if (committed) {
      const el = tileEl(committed.letter, committed.blank, 'btile');
      if (lastCells.has(k)) el.classList.add('lastplay');
      if (cascadeOrder.has(k)) {
        el.classList.add('land');
        el.style.setProperty('--land-delay', `${cascadeOrder.get(k) * 40}ms`);
      }
      cell.appendChild(el);
      if (premiumCells.has(k)) cell.classList.add('premium-fired');
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
    // Keep PLAY tappable so an explicit invalid attempt can receive local,
    // useful feedback instead of leaving the player with inert plain text.
    play.disabled = false;
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
  sound.tileClick();
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
      sound.tilePlace();
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
  sound.tilePlace();
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
      sound.tilePlace();
      render();
    });
    grid.appendChild(btn);
  }
})();

/* ---------------------------------------------------------------- moves */

function doMove(move) {
  if (G.mode === 'online' && !humanTurn()) return;
  let result = null;
  try {
    if (move.type === 'place') result = checkPlacement(G.state, move, isWord);
    G.state = applyMove(G.state, move, isWord);
  } catch (e) {
    $('msg').className = 'bad';
    $('msg').textContent = e.message;
    showInvalidFeedback();
    return;
  }
  clearTimeout(handoffTimer);
  clearTimeout(gameOverTimer);
  lastTransitionKey = transitionKey(G.state);
  save();
  pending = [];
  passArmed = false;

  if (G.mode === 'online') {
    const confirmedState = G.state;
    syncRack();
    clearEffects({ stopSound: true });
    render();
    pushOnline(confirmedState, () => {
      if (!G || G.state !== confirmedState) return;
      const fx = result ? placementFx(confirmedState.lastMove.cells) : {};
      render(fx);
      if (result) presentPlacement(confirmedState.lastMove, result);
      if (confirmedState.gameOver) {
        gameOverTimer = setTimeout(
          () => showGameOver(),
          move.type === 'place' ? 1100 : 400
        );
      }
    });
    return;
  }

  const fx = result ? placementFx(G.state.lastMove.cells) : {};
  if (G.state.gameOver) {
    handRevealed = true;
    render(fx);
    if (result) presentPlacement(G.state.lastMove, result);
    else clearEffects({ stopSound: true });
    gameOverTimer = setTimeout(
      () => showGameOver(),
      move.type === 'place' ? 1100 : 400
    );
    return;
  }

  if (G.mode === 'pass') {
    handRevealed = false; // curtain down before the next player's rack shows
    render(fx);
    if (result) presentPlacement(G.state.lastMove, result);
    else clearEffects({ stopSound: true });
    handoffTimer = setTimeout(
      () => showHandoff(G.state.currentPlayer),
      move.type === 'place' ? 850 : 350
    );
  } else {
    syncRack();
    render(fx);
    if (result) presentPlacement(G.state.lastMove, result);
    else clearEffects({ stopSound: true });
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
  clearTimeout(handoffTimer);
  clearTimeout(gameOverTimer);
  clearEffects({ stopSound: true });
  G = { mode, state: createInitialState({ numPlayers, seed: newSeed() }) };
  lastTransitionKey = transitionKey(G.state);
  resetLbPanel();
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
  clearEffects({ stopSound: true });
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
  'A fine day for words in the Queen City.',
];

const BOT_LINES = {
  winClose: [
    'SKIP tips his cap. “One more crossing and you might’ve had me.”',
    'SKIP whistles low. “That was close enough to rock the boat.”',
  ],
  winDecisive: [
    'SKIP dips his sails in respect. “You owned the board today.”',
    'SKIP nods toward shore. “Fair and square, wordsmith.”',
  ],
  loseClose: [
    'SKIP grins. “Only a few points in it. Run it back?”',
    'SKIP steadies the tiller. “That one could’ve gone either way.”',
  ],
  loseDecisive: [
    'SKIP grins. “The old skipper still knows these crossings.”',
    'SKIP taps the board. “Plenty of lake left for a rematch.”',
  ],
};

let previousResolutionLine = '';

function pickResolutionLine(lines) {
  const choices = lines.filter((line) => line !== previousResolutionLine);
  const line = choices[(Math.random() * choices.length) | 0] || lines[0];
  previousResolutionLine = line;
  return line;
}

function localOutcome(status) {
  if (status.winners.length > 1) return 'draw';
  if (G.mode === 'bot') return status.winners.includes(0) ? 'win' : 'lose';
  if (G.mode === 'online') return status.winners.includes(online.myPlayer) ? 'win' : 'lose';
  return 'win';
}

function animateFinalScores(rows) {
  if (reducedMotion.matches) return;
  const run = effectRun;
  const start = performance.now();
  const duration = 650;
  const frame = (now) => {
    if (run !== effectRun) return;
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - progress) ** 3;
    for (const row of rows) {
      const score = Number(row.dataset.score);
      row.textContent = Math.round(score * eased);
    }
    if (progress < 1) scoreRaf = requestAnimationFrame(frame);
    else scoreRaf = 0;
  };
  scoreRaf = requestAnimationFrame(frame);
}

function showGameOver({ celebrate = true } = {}) {
  clearTimeout(botTimer);
  clearTimeout(gameOverTimer);
  clearEffects({ stopSound: true });
  save(); // clears the save — game's done
  const st = getStatus(G.state);
  const names = st.winners.map(playerName);
  const outcome = localOutcome(st);

  $('go-title').textContent = st.winners.length > 1
    ? 'A TIE AT THE CROSSING'
    : (G.mode === 'bot' && st.winners[0] === BOT ? 'SKIP TAKES IT ⛵' : names[0].toUpperCase() + ' WINS! 🍁');

  const reason = st.reason === 'passes'
    ? 'Two full rounds of passes — the tiles have spoken. '
    : `${playerName(G.state.outPlayer)} went out and collected the leftovers. `;
  let reaction;
  if (st.winners.length > 1) {
    reaction = `${names.join(' & ')} split the maple candy.`;
  } else if (G.mode === 'bot') {
    const margin = Math.abs(G.state.scores[0] - G.state.scores[BOT]);
    const closeness = margin <= 12 ? 'Close' : 'Decisive';
    reaction = pickResolutionLine(BOT_LINES[outcome + closeness]);
  } else if (G.mode === 'online') {
    reaction = outcome === 'win'
      ? 'You found the last crossing. Your friend owes you a creemee.'
      : 'Your friend found the crossing first. The rematch button is right there.';
  } else {
    reaction = pickResolutionLine(WIN_LINES);
  }
  const line = reason + reaction;
  $('go-line').textContent = line;

  const card = $('go-card');
  card.classList.remove('result-win', 'result-lose', 'result-draw', 'celebrating');
  card.classList.add(`result-${outcome}`);
  if (celebrate) card.classList.add('celebrating');
  const lights = $('go-lights');
  lights.replaceChildren();
  for (let i = 0; i < 12; i++) {
    const light = document.createElement('i');
    light.style.setProperty('--light-delay', `${i * 70}ms`);
    lights.appendChild(light);
  }

  const table = $('go-table');
  table.innerHTML = '';
  const order = [...Array(G.state.numPlayers).keys()].sort((a, b) => G.state.scores[b] - G.state.scores[a]);
  const scoreEls = [];
  for (const p of order) {
    const adj = G.state.adjustments[p];
    const row = document.createElement('div');
    row.className = 'go-row' + (st.winners.includes(p) ? ' winner' : '');
    row.innerHTML = `<span class="nm"></span><span class="adj"></span><span class="fin"></span>`;
    row.querySelector('.nm').textContent = playerName(p);
    row.querySelector('.adj').textContent =
      (adj.leftover ? `−${adj.leftover} left over` : '') +
      (adj.bonus ? `${adj.leftover ? ' · ' : ''}+${adj.bonus} collected` : '');
    const scoreEl = row.querySelector('.fin');
    scoreEl.dataset.score = G.state.scores[p];
    scoreEl.textContent = celebrate && !reducedMotion.matches ? '0' : G.state.scores[p];
    scoreEl.setAttribute('aria-label', `${G.state.scores[p]} points`);
    scoreEls.push(scoreEl);
    table.appendChild(row);
  }
  show('gameover');
  if (G.mode === 'bot') {
    // Submit only on a fresh (celebrated) win over SKIP; losses and draws
    // still show the standings read-only. Online repaints re-call this with
    // celebrate:false, but those are never bot mode — never resubmit.
    const humanWon = celebrate && st.winners.length === 1 && st.winners[0] === 0;
    updateLeaderboard(humanWon ? botWinScore() : 0);
  } else {
    resetLbPanel(); // pass-and-play / online games never show the board
  }
  if (celebrate) {
    if (outcome === 'draw') sound.draw();
    else if (outcome === 'win') sound.win();
    else sound.lose();
    animateFinalScores(scoreEls);
  }
  $('againBtn').focus({ preventScroll: true });
}

/* ------------------------------------------------------------- leaderboard */
// Monthly board for vs-SKIP wins only. Score = your final point total,
// clamped to 1..999 (SKIP has a single difficulty, so no tier bonus).

const lbBox = $('lb');
const lbList = $('lbList');
const lbStatusEl = $('lbStatus');
const lbForm = $('lbForm');
const lbNameInput = $('lbNameInput');
const lbThisBtn = $('lbThisBtn');
const lbLastBtn = $('lbLastBtn');
const lbRenameBtn = $('lbRenameBtn');
let lbMonthOffset = 0;

if (lbEnabled()) {
  lbThisBtn.textContent = `🏆 ${monthLabel(0)}`;
  lbLastBtn.textContent = monthLabel(-1);
}

function resetLbPanel() {
  lbBox.classList.add('hidden');
  lbForm.classList.add('hidden');
  lbForm.dataset.pendingScore = '';
}

function botWinScore() {
  return Math.max(1, Math.min(999, G.state.scores[0]));
}

function lbScoreLabel(s) {
  return `🔡 ${s} pts`;
}

// score > 0 submits a fresh win; score 0 just shows the standings read-only
async function updateLeaderboard(score) {
  if (!lbEnabled()) return;
  lbBox.classList.remove('hidden');
  if (score > 0 && !lbGetName()) {
    // first win with no saved name: hold the score until they pick one
    lbForm.classList.remove('hidden');
    lbRenameBtn.classList.add('hidden');
    lbStatusEl.textContent = 'Pick a name to join the monthly leaderboard!';
    lbList.innerHTML = '';
    lbForm.dataset.pendingScore = String(score);
    return;
  }
  if (score > 0) {
    try { await submitScore(score); } catch { /* offline — still show the board */ }
  }
  renderLbBoard();
}

async function renderLbBoard() {
  lbForm.classList.add('hidden');
  lbRenameBtn.classList.remove('hidden');
  lbStatusEl.textContent = 'Loading…';
  try {
    const rows = await fetchTop(lbMonthOffset);
    const me = lbPlayerId();
    lbList.innerHTML = '';
    rows.slice(0, 10).forEach((r, i) => {
      const li = document.createElement('li');
      if (r.player_id === me) li.className = 'me';
      const medal = ['🥇', '🥈', '🥉'][i];
      li.innerHTML = '<span class="rank"></span><span class="nm"></span><span class="sc"></span>';
      li.querySelector('.rank').textContent = medal || `${i + 1}.`;
      li.querySelector('.nm').textContent = r.name;
      li.querySelector('.sc').textContent = lbScoreLabel(r.score);
      lbList.appendChild(li);
    });
    const myRank = rows.findIndex((r) => r.player_id === me);
    lbStatusEl.textContent = rows.length === 0
      ? 'No scores yet this month — be the first!'
      : myRank >= 0 ? `You're #${myRank + 1} of ${rows.length} this month` : '';
  } catch {
    lbStatusEl.textContent = 'Leaderboard unavailable (offline?)';
  }
}

$('lbSaveBtn').addEventListener('click', async () => {
  const name = lbNameInput.value.trim();
  if (!name) { lbNameInput.focus(); return; }
  const pending = Number(lbForm.dataset.pendingScore || 0);
  lbForm.dataset.pendingScore = '';
  try {
    await renamePlayer(name); // saves locally + renames any existing rows
    if (pending > 0) await submitScore(pending);
  } catch { /* offline — the name is still saved locally */ }
  renderLbBoard();
});
lbNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('lbSaveBtn').click();
});
lbRenameBtn.addEventListener('click', () => {
  lbNameInput.value = lbGetName();
  lbForm.classList.remove('hidden');
  lbRenameBtn.classList.add('hidden');
  lbNameInput.focus();
});
lbThisBtn.addEventListener('click', () => {
  lbMonthOffset = 0;
  lbThisBtn.classList.add('sel');
  lbLastBtn.classList.remove('sel');
  renderLbBoard();
});
lbLastBtn.addEventListener('click', () => {
  lbMonthOffset = -1;
  lbLastBtn.classList.add('sel');
  lbThisBtn.classList.remove('sel');
  renderLbBoard();
});

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
  clearTimeout(handoffTimer);
  clearTimeout(gameOverTimer);
  clearEffects({ stopSound: true });
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

/** Online repaints are cold unless onRemoteState marks one fresh transition. */
function applyOnlineState(newState, { transition = false, result = null } = {}) {
  if (!online) return;
  clearTimeout(gameOverTimer);
  clearEffects({ stopSound: true });
  if (drag) endDragCleanup();
  pending = [];
  selectedSlot = null;
  pendingBlankDrop = null;
  passArmed = false;
  swapPick = new Set();
  $('blankPicker').classList.add('hidden');
  $('swapOverlay').classList.add('hidden');
  G.state = newState;
  lastTransitionKey = transitionKey(newState);
  handRevealed = true;
  syncRack();
  const last = transition ? newState.lastMove : null;
  const fx = last?.type === 'place' ? placementFx(last.cells) : {};
  if (newState.gameOver && !transition) {
    showGameOver({ celebrate: false });
    return;
  }
  show('game');
  render(fx);
  if (last?.type === 'place') presentPlacement(last, result);
  if (newState.gameOver) {
    gameOverTimer = setTimeout(
      () => showGameOver(),
      last?.type === 'place' ? 1100 : 400
    );
  }
}

function onRemoteState(newState) {
  const wasReconnecting = pollErrors > 0;
  const transition = transitionKey(newState) !== lastTransitionKey &&
    !wasReconnecting &&
    !suppressNextOnlineEffect &&
    document.visibilityState === 'visible';
  let result = null;
  if (transition && newState.lastMove?.type === 'place' && dict) {
    const tiles = newState.lastMove.cells.map((k) => ({
      row: Math.floor(k / BOARD_SIZE),
      col: k % BOARD_SIZE,
      letter: newState.board[k].letter,
      blank: newState.board[k].blank,
    }));
    try {
      result = checkPlacement(G.state, { type: 'place', tiles }, isWord);
    } catch { /* a skipped room version still gets a safe new-tile anchor */ }
  }
  onlineAbandoned = false;
  pollErrors = 0;
  suppressNextOnlineEffect = false;
  applyOnlineState(newState, { transition, result });
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
  if (document.visibilityState === 'visible') suppressNextOnlineEffect = false;
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

async function pushOnline(newState, onConfirmed = () => {}) {
  if (!online) return;
  const over = getStatus(newState).status === 'over';
  let presented = false;
  const confirm = () => {
    if (presented) return;
    presented = true;
    onConfirmed();
  };
  try {
    await online.match.push(newState, { over });
    pollErrors = 0;
    confirm();
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
        confirm();
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
  clearTimeout(handoffTimer);
  clearTimeout(gameOverTimer);
  clearEffects({ stopSound: true });
  G = saved;
  lastTransitionKey = transitionKey(G.state);
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
  clearTimeout(handoffTimer);
  clearTimeout(gameOverTimer);
  clearEffects({ stopSound: true });
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
$('mute').addEventListener('click', () => {
  sound.toggleMuted();
  updateMuteButton();
});

document.addEventListener('pointerdown', sound.unlock, { once: true, capture: true });
document.addEventListener('keydown', sound.unlock, { once: true, capture: true });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  suppressNextOnlineEffect = true;
  clearEffects({ stopSound: true });
});

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

updateMuteButton();
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

/* ------------------------------------------------- crew-link invites */
// Text a link instead of reading letters aloud: ?join=ABCD opens the join
// panel with the code filled in, then scrubs the URL so refreshes don't
// re-trigger it. Canonical pattern: four-in-a-rowboat (ROOMS-INTEGRATION §6).

$('inviteBtn').addEventListener('click', async () => {
  const code = ($('lobbyCode').textContent || '').trim();
  if (!code) return;
  const url = `${location.origin}${location.pathname}?join=${code}`;
  const text = `🔡 Tiles down — challenge me — tap to join my Btown Crossings game: ${url}`;
  try {
    if (navigator.share && /Mobi|Android|iPhone|iPad/.test(navigator.userAgent)) {
      await navigator.share({ text });
    } else {
      await navigator.clipboard.writeText(url);
      $('inviteBtn').textContent = '✓ LINK COPIED';
      setTimeout(() => { $('inviteBtn').textContent = '📲 SEND AN INVITE'; }, 1800);
    }
  } catch { /* share sheet closed */ }
});

(() => {
  const code = new URLSearchParams(location.search).get('join');
  if (!code || !/^[A-Za-z0-9]{4}$/.test(code)) return;
  history.replaceState(null, '', location.pathname);
  openOnlinePanel('join');
  $('opCode').value = code.toUpperCase();
})();
