// Online-rooms wiring test: drives the real vendored client (js/rooms.js)
// against the local shim (scripts/rooms-shim.mjs) as two simulated phones,
// then plays a full online game through the real engine. No network and no
// Supabase are involved.
//
//   node scripts/test-rooms.mjs

import { createRooms } from './rooms-shim.mjs';
import { createInitialState, legalMoves, applyMove, getStatus } from '../js/engine.js';

const GAME = 'btown-crossings';

/* ------------------------------------------------- two-phone environment */

const stores = new Map();
let current = 'A';
globalThis.localStorage = {
  getItem: (key) => (stores.get(current).has(key) ? stores.get(current).get(key) : null),
  setItem: (key, value) => stores.get(current).set(key, String(value)),
  removeItem: (key) => stores.get(current).delete(key),
};
function device(id) {
  if (!stores.has(id)) stores.set(id, new Map());
  current = id;
}
device('A');
device('B');

let passed = 0;
function t(condition, label) {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok — ${label}`);
}
async function expectCode(promise, code, label) {
  try {
    await promise;
    t(false, `${label} (no error thrown)`);
  } catch (err) {
    t(err && err.code === code, `${label} (got ${err && err.code})`);
  }
}

// Drive the exact rooms-shim RPCs in memory. This is equivalent to its tiny
// HTTP wrapper but also runs in sandboxes that forbid opening a loopback port.
const shim = createRooms();
globalThis.BTOWN_ROOMS_URL = 'http://rooms.test';
globalThis.fetch = async (url, options = {}) => {
  const match = new URL(url).pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
  if (!match || options.method !== 'POST' || !shim.rpcs[match[1]]) {
    return new Response(JSON.stringify({ message: 'not a room rpc' }), { status: 404 });
  }
  try {
    const body = shim.rpcs[match[1]](JSON.parse(options.body || '{}')) ?? {};
    return new Response(JSON.stringify(body), { status: 200 });
  } catch (err) {
    const status = err.rpc ? 400 : 500;
    return new Response(JSON.stringify({ message: err.message }), { status });
  }
};
const { OnlineMatch, savedSession } = await import('../js/rooms.js');

/* ------------------------------------------------------------ the tests */

// create + join
device('A');
const initial = createInitialState({ numPlayers: 2, seed: 103 });
const host = await OnlineMatch.create({
  game: GAME, name: 'Maple A', state: initial, seats: 2,
});
t(
  /^[A-Z2-9]{4}$/.test(host.code) &&
    host.seat === initial.currentPlayer &&
    host.status === 'waiting',
  'host creates room in the engine player who moves first',
);
t(savedSession(GAME)?.roomId === host.roomId, 'host session saved');

device('B');
await expectCode(
  OnlineMatch.join({ game: GAME, code: 'ZZZZ', name: 'X' }),
  'not_found',
  'bad code rejected',
);
await expectCode(
  OnlineMatch.join({ game: 'four-in-a-rowboat', code: host.code, name: 'X' }),
  'wrong_game',
  'wrong game rejected',
);
const guest = await OnlineMatch.join({
  game: GAME, code: ` ${host.code.toLowerCase()} `, name: 'Maple B',
});
t(guest.seat === 1 && guest.status === 'playing', 'guest joins (sloppy code accepted) and game starts');
t(guest.opponents().length === 1 && guest.opponents()[0].name === 'Maple A', 'guest sees host name');

device('A');
await host._fetch();
t(host.status === 'playing' && host.opponents()[0].name === 'Maple B', 'host poll sees game start');

// referee: push, sync, conflict
const afterHost = applyMove(host.state, { type: 'pass' });
await host.push(afterHost);
t(host.version === 1, 'host pushes move, version 1');

device('B');
await guest._fetch();
t(guest.state.currentPlayer === 1 && guest.state.passStreak === 1, 'guest poll receives the move');
const afterGuest = applyMove(guest.state, {
  type: 'exchange',
  tiles: [guest.state.racks[guest.state.currentPlayer][0]],
});
await guest.push(afterGuest);
t(guest.version === 2, 'guest pushes reply, version 2');

device('A');
const staleState = applyMove(afterHost, { type: 'pass' });
await expectCode(host.push(staleState), 'version_conflict', 'stale push rejected');
t(
  host.version === 2 &&
    host.state.currentPlayer === 0 &&
    host.state.lastMove.type === 'exchange',
  'conflict refetches the truth',
);

// Full game through the engine. legalMoves() supplies pass/exchange choices;
// placements need a dictionary-driven proposal, so this seeded phone test
// randomly chooses among the concrete legal moves until the pass endgame.
device('A');
await host._fetch();
device('B');
await guest._fetch();
const phones = {
  0: { match: host, device: 'A' },
  1: { match: guest, device: 'B' },
};
let randomState = 0x5eed1234;
const random = () => {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) | 0;
  return (randomState >>> 0) / 4294967296;
};
function randomConcreteMove(state) {
  const moves = legalMoves(state).filter((move) => move.type !== 'place');
  // Give passing two tickets so the guaranteed pass endgame arrives quickly,
  // while still exercising seeded random exchanges and their bag RNG state.
  const pass = moves.find((move) => move.type === 'pass');
  const choices = pass ? moves.concat(pass) : moves;
  const picked = choices[Math.floor(random() * choices.length)];
  if (picked.type === 'pass') return picked;
  const rack = state.racks[state.currentPlayer];
  const count = 1 + Math.floor(random() * picked.maxTiles);
  const offset = Math.floor(random() * rack.length);
  const tiles = Array.from({ length: count }, (_, i) => rack[(offset + i) % rack.length]);
  return { type: 'exchange', tiles };
}

let movesPlayed = 0;
while (getStatus(host.state).status !== 'over' && movesPlayed < 400) {
  const mover = phones[host.state.currentPlayer];
  device(mover.device);
  await mover.match._fetch();
  const next = applyMove(mover.match.state, randomConcreteMove(mover.match.state));
  await mover.match.push(next, { over: getStatus(next).status === 'over' });
  movesPlayed++;

  device('A');
  await host._fetch();
  device('B');
  await guest._fetch();
  t(
    JSON.stringify(host.state) === JSON.stringify(guest.state),
    `phones agree after random legal move ${movesPlayed}`,
  );
}
t(movesPlayed <= 400, 'online simulation respects the 400-move cap');
t(JSON.stringify(host.state) === JSON.stringify(guest.state), 'end states are JSON-identical');
t(
  getStatus(host.state).status === 'over' && host.status === 'over',
  'full online game reaches the engine endgame',
);

// rematch: either phone can deal; the fresh engine state again opens on host
device('B');
const rematch = createInitialState({ numPlayers: 2, seed: 204 });
const versionBeforeRematch = guest.version;
await guest.push(rematch, {});
t(
  guest.status === 'playing' &&
    guest.version === versionBeforeRematch + 1 &&
    guest.state.currentPlayer === host.seat,
  'rematch deal accepted with host moving first',
);

// resume after a refresh
device('A');
const resumed = await OnlineMatch.resume({ game: GAME });
t(
  resumed.roomId === host.roomId && resumed.seat === 0 && resumed.status === 'playing',
  'resume reattaches to the room',
);

// leave: other side sees the flag, session cleared
await resumed.leave();
t(savedSession(GAME) === null, 'leave clears the session');
device('B');
await guest._fetch();
t(guest.status === 'over' && guest.opponents()[0].left === true, 'guest sees host left');

// full room turns a third phone away
device('A');
const h2 = await OnlineMatch.create({
  game: GAME, name: 'A', state: createInitialState({ numPlayers: 2, seed: 305 }),
});
device('B');
await OnlineMatch.join({ game: GAME, code: h2.code, name: 'B' });
device('C');
await expectCode(
  OnlineMatch.join({ game: GAME, code: h2.code, name: 'C' }),
  'room_started',
  'third phone turned away',
);

// Missing backend becomes a clean not_ready RoomsError.
{
  const workingFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 404 });
  const freshRooms = await import('../js/rooms.js?not-ready');
  try {
    await freshRooms.OnlineMatch.create({ game: GAME, name: 'A', state: {} });
    t(false, 'missing backend reads as not_ready (no error thrown)');
  } catch (err) {
    t(
      err instanceof freshRooms.RoomsError && err.code === 'not_ready',
      'missing backend reads as not_ready',
    );
  }
  globalThis.fetch = workingFetch;
}

console.log(`\nALL ROOMS TESTS PASSED (${passed} checks)`);
process.exit(0);
