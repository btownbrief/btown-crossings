// Monthly public leaderboard backed by Supabase.
// Database schema lives in supabase/schema.sql; one-time setup steps in
// supabase/SETUP.md. Until the two values below are filled in, every
// export here quietly no-ops and the game hides all leaderboard UI.
//
// No login: each browser mints a random player id + secret token in
// localStorage. The server stores only each player's BEST score per month;
// boards roll over monthly and past months stay stored ("cemented").

// >>> Paste your Supabase project values here (Dashboard → Settings → API) <<<
const SUPABASE_URL = 'https://jnouvwxomrcffqwilqkq.supabase.co/';      // e.g. 'https://abcdefgh.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_RkMJQopffWlV6DSwCRkndQ_Xw6GJMf3'; // the long "anon / public" key (safe to ship)

const GAME = 'btown-crossings';

export function lbEnabled() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

function stored(key, make) {
  let v = localStorage.getItem(key);
  if (!v) { v = make(); localStorage.setItem(key, v); }
  return v;
}
// shared "btown-" keys so future games on the same domain reuse the identity
export function playerId() {
  return stored('btown-player-id', () => crypto.randomUUID());
}
function playerToken() {
  return stored('btown-player-token', () =>
    [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''));
}
export function getName() { return localStorage.getItem('btown-player-name') || ''; }
export function setName(n) { localStorage.setItem('btown-player-name', n.trim().slice(0, 20)); }

// Retry transient failures. A cold Supabase project (free tier sleeps after
// idle) or a brief network blip can drop the first request; without a retry a
// single miss leaves the UI stuck on "unavailable". All RPCs here are
// idempotent (best-score upsert / name upsert / read), so re-sending is safe.
// Only network errors and 5xx are retried; a 4xx is a real error, fail fast.
async function rpc(fn, args, attempts = 3) {
  const headers = { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
  // legacy JWT-style anon keys also go in the Authorization header;
  // new sb_publishable_ keys must not (they aren't bearer tokens)
  if (SUPABASE_ANON_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
  const url = `${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(args) });
    } catch (e) {
      lastErr = e; // network/DNS blip — retry
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 400 * attempt));
      continue;
    }
    if (res.ok) {
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
    if (res.status < 500) throw new Error(`${fn} failed: ${res.status}`); // client error — retrying won't help
    lastErr = new Error(`${fn} failed: ${res.status}`); // cold start / server error — retry
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 400 * attempt));
  }
  throw lastErr;
}

// offset 0 = this month, -1 = last month (matches the server's month_key)
function monthDate(offset) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return d;
}
export function monthKey(offset = 0) {
  const d = monthDate(offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function monthLabel(offset = 0) {
  return monthDate(offset).toLocaleString('en-US', { month: 'long' });
}

export async function submitScore(score) {
  if (!lbEnabled() || !getName() || score <= 0) return;
  await rpc('submit_score', {
    p_game: GAME,
    p_player: playerId(),
    p_token: playerToken(),
    p_name: getName(),
    p_score: Math.floor(score),
  });
}

export async function renamePlayer(name) {
  setName(name);
  if (!lbEnabled()) return;
  await rpc('rename_player', { p_player: playerId(), p_token: playerToken(), p_name: getName() });
}

// returns [{ name, score, player_id }] sorted best-first
export async function fetchTop(monthOffset = 0) {
  if (!lbEnabled()) return [];
  return (await rpc('get_leaderboard', { p_game: GAME, p_month: monthKey(monthOffset) })) || [];
}
