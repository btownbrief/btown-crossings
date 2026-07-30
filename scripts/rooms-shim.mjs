// Local stand-in for the Supabase rooms backend, used by test-rooms.mjs
// (and handy for offline playtesting: `node scripts/rooms-shim.mjs 8787`
// then load the game with ?rooms=http://localhost:8787).
//
// It mirrors btownbrief.github.io/supabase/rooms-2026-07-30.sql: same RPC
// names, same error messages, same version-lock referee. The SQL file is
// the authority — it has its own test suite against real Postgres; this
// shim only needs to be faithful enough to exercise js/rooms.js and the
// game's online UI.

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const hash = (t) => createHash('sha256').update(String(t ?? '')).digest('hex');
const nowS = () => Math.floor(Date.now() / 1000);

export function createRooms() {
  const rooms = new Map(); // id -> room
  let nextId = 1;

  const byCode = (code) =>
    [...rooms.values()].find((r) => r.code === String(code ?? '').trim().toUpperCase());
  const seatOf = (room, token) =>
    room.seats.findIndex((s) => s.token_hash === hash(token));
  const publicSeats = (room) =>
    room.seats.map(({ token_hash, ...pub }) => pub);
  const fail = (message) => {
    const e = new Error(message);
    e.rpc = true;
    throw e;
  };
  const checkState = (state) => {
    if (state === null || state === undefined) fail('bad_state');
    if (JSON.stringify(state).length > 131072) fail('state_too_big');
  };
  const checkIdentity = (player, token) => {
    const tl = String(token ?? '').length;
    const pl = String(player ?? '').length;
    if (tl < 8 || tl > 64 || pl < 1 || pl > 64) fail('bad_identity');
  };
  const cleanName = (name) => String(name ?? '').trim().slice(0, 24) || 'Player';

  const rpcs = {
    room_create({ p_game, p_name, p_player, p_token, p_state, p_seats = 2 }) {
      if (!/^[a-z0-9-]{1,40}$/.test(p_game ?? '')) fail('bad_game');
      checkIdentity(p_player, p_token);
      if (!(p_seats >= 2 && p_seats <= 4)) fail('bad_seats');
      checkState(p_state);
      for (const [id, r] of rooms) {
        if (r.game === p_game && r.status === 'waiting' &&
            r.seats.some((s) => s.player_id === p_player && s.token_hash === hash(p_token))) {
          rooms.delete(id);
        }
      }
      let code;
      do {
        code = [...randomBytes(4)].map((b) => ALPHABET[b % 31]).join('');
      } while (byCode(code));
      const id = `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;
      rooms.set(id, {
        id, code, game: p_game, status: 'waiting', max_seats: p_seats,
        seats: [{ seat: 0, name: cleanName(p_name), player_id: p_player,
                  token_hash: hash(p_token), last_seen: nowS(), left: false }],
        state: p_state, version: 0,
      });
      return { room_id: id, code, seat: 0 };
    },

    room_join({ p_code, p_game, p_name, p_player, p_token }) {
      checkIdentity(p_player, p_token);
      const r = byCode(p_code);
      if (!r) fail('not_found');
      if (r.game !== p_game) fail(`wrong_game:${r.game}`);
      const mine = seatOf(r, p_token);
      if (mine >= 0) {
        return { room_id: r.id, seat: mine, status: r.status, state: r.state,
                 version: r.version, seats: publicSeats(r), max_seats: r.max_seats };
      }
      if (r.status !== 'waiting') fail('room_started');
      if (r.seats.length >= r.max_seats) fail('room_full');
      const seat = r.seats.length;
      r.seats.push({ seat, name: cleanName(p_name), player_id: p_player,
                     token_hash: hash(p_token), last_seen: nowS(), left: false });
      if (r.seats.length >= r.max_seats) r.status = 'playing';
      return { room_id: r.id, seat, status: r.status, state: r.state,
               version: r.version, seats: publicSeats(r), max_seats: r.max_seats };
    },

    room_get({ p_room, p_token }) {
      const r = rooms.get(p_room);
      if (!r) fail('not_found');
      const seat = seatOf(r, p_token);
      if (seat < 0) fail('not_seated');
      if (nowS() - r.seats[seat].last_seen > 15) r.seats[seat].last_seen = nowS();
      return { status: r.status, state: r.state, version: r.version, seat,
               seats: publicSeats(r), max_seats: r.max_seats, code: r.code, now: nowS() };
    },

    room_push({ p_room, p_token, p_state, p_version, p_status = 'playing' }) {
      if (!['playing', 'over'].includes(p_status)) fail('bad_status');
      checkState(p_state);
      const r = rooms.get(p_room);
      if (!r) fail('not_found');
      const seat = seatOf(r, p_token);
      if (seat < 0) fail('not_seated');
      if (r.status === 'waiting') fail('not_started');
      if (r.version !== (p_version ?? -1)) fail('version_conflict');
      r.state = p_state;
      r.version += 1;
      r.status = p_status;
      r.seats[seat].last_seen = nowS();
      return { version: r.version };
    },

    room_leave({ p_room, p_token }) {
      const r = rooms.get(p_room);
      if (!r) return { ok: true };
      const seat = seatOf(r, p_token);
      if (seat < 0) fail('not_seated');
      r.seats[seat].left = true;
      r.status = 'over';
      return { ok: true };
    },
  };

  return { rooms, rpcs };
}

export function startShim(port = 0) {
  const { rooms, rpcs } = createRooms();
  const server = createServer((req, res) => {
    const m = req.url.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    const send = (status, body) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
      });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return send(200, {});
    if (!m || req.method !== 'POST' || !rpcs[m[1]]) return send(404, { message: 'not a room rpc' });
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try {
        send(200, rpcs[m[1]](JSON.parse(raw || '{}')) ?? {});
      } catch (e) {
        if (e.rpc) return send(400, { message: e.message });
        send(500, { message: String(e) });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({ server, rooms, port: server.address().port,
                url: `http://127.0.0.1:${server.address().port}` }));
  });
}

// Standalone: node scripts/rooms-shim.mjs [port]
if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await startShim(Number(process.argv[2] || 8787));
  console.log(`rooms shim listening at ${url}`);
}
