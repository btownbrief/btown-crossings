// BTOWN GAME ROOMS — vendored online-multiplayer client, identical in every
// Btown game repo. Canonical copy: four-in-a-rowboat/js/rooms.js. Server
// side: btownbrief.github.io/supabase/rooms-2026-07-30.sql (same Supabase
// project + anon key as the leaderboard; see leaderboard.js).
//
// The model: a room is a 4-letter code plus the game's entire engine state
// as opaque JSON and a version number. Whoever just moved pushes the new
// state with the version they last saw; the server accepts it only if the
// version still matches, so two phones can never trample each other. The
// other phone polls a couple times a second-ish and re-renders. Turn-based
// games don't need anything faster, and plain polling keeps this file
// dependency-free like the rest of the fleet.
//
// This file knows NOTHING about any particular game. Games talk to it
// through OnlineMatch below and keep every rule inside their pure engine.

const SUPABASE_URL = 'https://jnouvwxomrcffqwilqkq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_RkMJQopffWlV6DSwCRkndQ_Xw6GJMf3';

// Tests point this at a local shim server (see scripts/test-rooms.mjs).
const BASE = (globalThis.BTOWN_ROOMS_URL || SUPABASE_URL).replace(/\/+$/, '');

const POLL_VISIBLE_MS = 2500;
const POLL_HIDDEN_MS = 10000;
const AWAY_AFTER_S = 35; // no check-in for this long → shown as "away"

/**
 * Every failure is a RoomsError whose .code is one of:
 *   offline, not_ready (SQL not installed yet), not_found, wrong_game
 *   (.detail = the game the code belongs to), room_full, room_started,
 *   not_seated, version_conflict, state_too_big, http_<status>, …
 */
export class RoomsError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'RoomsError';
    this.code = code;
    this.detail = detail;
  }
}

async function rpc(fn, args) {
  let res;
  try {
    res = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch {
    throw new RoomsError('offline');
  }
  if (res.status === 404) throw new RoomsError('not_ready');
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const raw = (body && body.message) || `http_${res.status}`;
    if (raw.startsWith('wrong_game:')) throw new RoomsError('wrong_game', raw.slice(11));
    throw new RoomsError(raw);
  }
  return body;
}

/* --------------------------------------------------- identity + sessions */
// Same per-origin identity keys every Btown game already shares.

export function playerId() {
  let id = localStorage.getItem('btown-player-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('btown-player-id', id);
  }
  return id;
}
export function getName() {
  return localStorage.getItem('btown-player-name') || '';
}
export function setName(name) {
  localStorage.setItem('btown-player-name', String(name).trim().slice(0, 24));
}

// One secret per device, shared across rooms — proves seat ownership.
function deviceToken() {
  let t = localStorage.getItem('btown-room-token');
  if (!t) {
    t = crypto.randomUUID();
    localStorage.setItem('btown-room-token', t);
  }
  return t;
}

const sessionKey = (game) => `btown-room-${game}`;

/** The room this device last sat in for `game`, or null. Lets the menu
 *  offer "rejoin your game" after a refresh or an accidental close. */
export function savedSession(game) {
  try {
    const s = JSON.parse(localStorage.getItem(sessionKey(game)));
    return s && s.roomId ? s : null;
  } catch {
    return null;
  }
}
export function clearSession(game) {
  localStorage.removeItem(sessionKey(game));
}

/* ------------------------------------------------------------ the match */

/**
 * One live online game. Create/join/resume, then start() polling; push()
 * after each local move. All game rules stay in the game's engine — this
 * object only ferries state.
 *
 *   const match = await OnlineMatch.create({ game, name, state, seats });
 *   const match = await OnlineMatch.join({ game, code, name });
 *   const match = await OnlineMatch.resume({ game });
 *   match.code / .seat / .state / .status / .version / .seats
 *   match.start({ onState, onStatus, onPresence, onError });
 *   await match.push(newState, { over });   // after MY move
 *   await match.leave();
 */
export class OnlineMatch {
  constructor(game, session) {
    this.game = game;
    this.roomId = session.roomId;
    this.code = session.code;
    this.seat = session.seat;
    this.state = session.state ?? null;
    this.status = session.status ?? 'waiting';
    this.version = session.version ?? 0;
    this.seats = session.seats ?? [];
    this.maxSeats = session.maxSeats ?? null;
    this.now = session.now ?? 0;
    this._cb = {};
    this._timer = 0;
    this._stopped = false;
    this._inFlight = false;
    this._onVis = null;
  }

  static async create({ game, name, state, seats = 2 }) {
    const res = await rpc('room_create', {
      p_game: game, p_name: name, p_player: playerId(),
      p_token: deviceToken(), p_state: state, p_seats: seats,
    });
    setName(name);
    const m = new OnlineMatch(game, {
      roomId: res.room_id, code: res.code, seat: res.seat,
      state, status: 'waiting', version: 0,
      seats: [{ seat: 0, name, left: false }], maxSeats: seats,
    });
    m._save();
    return m;
  }

  static async join({ game, code, name }) {
    const res = await rpc('room_join', {
      p_code: code, p_game: game, p_name: name,
      p_player: playerId(), p_token: deviceToken(),
    });
    setName(name);
    const m = new OnlineMatch(game, {
      roomId: res.room_id, code: String(code).trim().toUpperCase(),
      seat: res.seat, state: res.state, status: res.status,
      version: res.version, seats: res.seats, maxSeats: res.max_seats,
    });
    m._save();
    return m;
  }

  /** Reattach to the saved session. Throws not_found once the room has
   *  been swept (caller should clearSession and fall through to the menu). */
  static async resume({ game }) {
    const saved = savedSession(game);
    if (!saved) throw new RoomsError('not_found');
    const m = new OnlineMatch(game, saved);
    await m._fetch();
    return m;
  }

  _save() {
    localStorage.setItem(sessionKey(this.game), JSON.stringify({
      roomId: this.roomId, code: this.code, seat: this.seat,
    }));
  }

  /** Names of everyone else at the table, with presence. */
  opponents() {
    return (this.seats || [])
      .filter((s) => s.seat !== this.seat)
      .map((s) => ({
        seat: s.seat,
        name: s.name,
        left: !!s.left,
        away: !s.left && this.now && s.last_seen ? this.now - s.last_seen > AWAY_AFTER_S : false,
      }));
  }

  async _fetch() {
    const res = await rpc('room_get', { p_room: this.roomId, p_token: deviceToken() });
    // Overlapping requests (poll vs. conflict refetch) can resolve out of
    // order; a room's version only ever grows, so an older response must
    // never overwrite a newer state.
    if (res.version < this.version) return res;
    const statusChanged = res.status !== this.status;
    const versionChanged = res.version !== this.version;
    this.state = res.state;
    this.status = res.status;
    this.version = res.version;
    this.seats = res.seats;
    this.maxSeats = res.max_seats ?? this.maxSeats;
    this.now = res.now;
    if (this._stopped) return res; // stop() mid-flight: keep state, skip callbacks
    if (versionChanged && this._cb.onState) this._cb.onState(this.state, this);
    if (statusChanged && this._cb.onStatus) this._cb.onStatus(this.status, this);
    if (this._cb.onPresence) this._cb.onPresence(this.opponents(), this);
    return res;
  }

  /** Begin polling. Callbacks fire only on actual change (except
   *  onPresence, which fires every poll — it carries the away clock). */
  start(callbacks = {}) {
    this.stop(); // restarting (lobby → game) must never leave two loops
    this._cb = callbacks;
    this._stopped = false;
    const gen = (this._gen = (this._gen || 0) + 1);
    // Exactly ONE pending timer at any moment: every (re)schedule goes
    // through here, and every tick clears whatever else was pending, so a
    // visibility change during a slow fetch can't fork a second loop.
    const schedule = (ms) => {
      clearTimeout(this._timer);
      this._timer = setTimeout(tick, ms);
    };
    const tick = async () => {
      if (this._stopped || gen !== this._gen) return;
      clearTimeout(this._timer);
      if (this._inFlight) {
        // start() was called from inside a poll callback (lobby → game):
        // the old fetch is still settling — come back, don't die.
        schedule(50);
        return;
      }
      this._inFlight = true;
      try {
        await this._fetch();
      } catch (err) {
        // A vanished room means the other side left long ago — surface it.
        if (!this._stopped && gen === this._gen && this._cb.onError) this._cb.onError(err, this);
      } finally {
        this._inFlight = false;
      }
      if (!this._stopped && gen === this._gen) {
        schedule(document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS);
      }
    };
    this._onVis = () => {
      if (!document.hidden && !this._stopped && gen === this._gen) {
        tick();
      }
    };
    document.addEventListener('visibilitychange', this._onVis);
    tick();
    return this;
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._timer);
    if (this._onVis) document.removeEventListener('visibilitychange', this._onVis);
  }

  /**
   * Publish the state after MY move (engine-applied on this phone).
   * `over: true` marks the game finished; pushing a fresh deal to a
   * finished room starts the rematch. On 'version_conflict' the room is
   * refetched (onState fires with the truth) and the error is rethrown —
   * callers usually just drop their attempted move.
   */
  async push(newState, { over = false } = {}) {
    try {
      const res = await rpc('room_push', {
        p_room: this.roomId, p_token: deviceToken(), p_state: newState,
        p_version: this.version, p_status: over ? 'over' : 'playing',
      });
      this.state = newState;
      this.version = res.version;
      this.status = over ? 'over' : 'playing';
      return res;
    } catch (err) {
      if (err instanceof RoomsError && err.code === 'version_conflict') {
        await this._fetch().catch(() => {});
      }
      throw err;
    }
  }

  async leave() {
    this.stop();
    clearSession(this.game);
    try {
      await rpc('room_leave', { p_room: this.roomId, p_token: deviceToken() });
    } catch {
      /* leaving a swept room is fine */
    }
  }
}
