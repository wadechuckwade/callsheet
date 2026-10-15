// @ts-nocheck
// Callsheet calendar server function (Supabase Edge Function, free tier).
//
//   POST  { url }        Signed-in users only. Fetches a calendar link (Apple, Google, Outlook,
//                        Deputy…) and returns its .ics text, because browsers can't read other
//                        sites' calendars directly.
//   GET   ?feed=<token>  Public, secret link. Returns the person's Callsheet sessions, events
//                        and followed deadlines as a calendar that Apple/Google/Outlook subscribe to.
//
// Deploy with JWT verification OFF (the feed is opened by calendar apps, which can't sign in);
// the POST route checks the user's sign-in itself.

const env = (k) => (globalThis.Deno ? Deno.env.get(k) : process.env[k]) || '';
const SB_URL = () => env('SUPABASE_URL');
const SB_KEY = () => env('SUPABASE_ANON_KEY') || env('SUPABASE_PUBLISHABLE_KEY');
const MAX_BYTES = 5 * 1024 * 1024;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// ---------- fetching someone's calendar link ----------
function checkUrl(raw) {
  let s = String(raw || '').trim();
  if (/^webcals?:\/\//i.test(s)) s = 'https://' + s.replace(/^webcals?:\/\//i, '');
  let u; try { u = new URL(s); } catch (_) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h.includes('.') || h === 'localhost' || /\.(local|internal|localhost|lan|home|corp)$/.test(h)) return null;
  if (/^[\d.]+$/.test(h) || h.includes(':')) return null; // no raw IP addresses
  if (u.port && !['80', '443'].includes(u.port)) return null;
  return u;
}
async function readCapped(res) {
  const reader = res.body.getReader(); const chunks = []; let n = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > MAX_BYTES) { try { await reader.cancel(); } catch (_) {} throw { code: 'too_big' }; } chunks.push(value); }
  const all = new Uint8Array(n); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  return new TextDecoder().decode(all);
}
async function fetchCalendar(raw) {
  let u = checkUrl(raw); if (!u) throw { code: 'bad_url' };
  for (let hop = 0; hop < 4; hop++) {
    let res;
    try { res = await fetch(u.toString(), { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Callsheet calendar sync', Accept: 'text/calendar, */*' } }); }
    catch (e) { throw { code: e && e.name === 'TimeoutError' ? 'timeout' : 'unreachable' }; }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = checkUrl(new URL(res.headers.get('location'), u).toString()); if (!u) throw { code: 'bad_url' }; continue; }
    if (res.status === 401 || res.status === 403) throw { code: 'private' };
    if (res.status === 404 || res.status === 410) throw { code: 'not_found' };
    if (!res.ok) throw { code: 'unreachable', status: res.status };
    const text = (await readCapped(res)).replace(/^\uFEFF/, '');
    if (!/^\s*BEGIN:VCALENDAR/i.test(text)) throw { code: 'not_calendar' };
    return text;
  }
  throw { code: 'unreachable' };
}
async function signedInUser(req) {
  const auth = req.headers.get('authorization') || '';
  if (!/^Bearer\s+\S+/i.test(auth)) return null;
  const r = await fetch(SB_URL() + '/auth/v1/user', { headers: { Authorization: auth, apikey: req.headers.get('apikey') || SB_KEY() } });
  if (!r.ok) return null;
  const u = await r.json(); return u && u.id ? u : null;
}

// ---------- the Callsheet feed ----------
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) {
  const bytes = new TextEncoder().encode(line); if (bytes.length <= 75) return line;
  const out = []; let cur = ''; let len = 0;
  for (const ch of line) { const b = new TextEncoder().encode(ch).length; if (len + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; len = 0; } cur += ch; len += b; }
  out.push(cur); return out.join('\r\n ');
}
const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
const validTime = (t) => /^\d{1,2}:\d{2}$/.test(t || '');
const dateVal = (d) => d.replace(/-/g, '');
const nextDay = (d) => { const [y, m, dd] = d.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, dd + 1)); return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`; };
const fmtCache = {};
function tzOffsetMs(ms, tz) {
  const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  const p = {}; f.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
function wallToUtc(date, hm, tz) {
  const [y, m, d] = date.split('-').map(Number); const [h, mi] = hm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - tzOffsetMs(guess, tz); t = guess - tzOffsetMs(t, tz); return t;
}
const utcStamp = (ms) => { const x = new Date(ms); return `${x.getUTCFullYear()}${pad(x.getUTCMonth() + 1)}${pad(x.getUTCDate())}T${pad(x.getUTCHours())}${pad(x.getUTCMinutes())}00Z`; };

function buildFeed(tz, items) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch (_) { tz = 'Europe/London'; }
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Callsheet//Calendar feed//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Callsheet', 'X-WR-CALDESC:Sessions\\, events and deadlines from Callsheet', `X-WR-TIMEZONE:${tz}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  const now = utcStamp(Date.now());
  const timed = (date, start, end) => {
    const s = wallToUtc(date, start, tz);
    let e = end && validTime(end) ? wallToUtc(date, end, tz) : s + 3600000;
    if (e <= s) e = wallToUtc(nextDay(date), end && validTime(end) ? end : start, tz);
    return [`DTSTART:${utcStamp(s)}`, `DTEND:${utcStamp(e)}`];
  };
  const allDay = (date) => [`DTSTART;VALUE=DATE:${dateVal(date)}`, `DTEND;VALUE=DATE:${dateVal(nextDay(date))}`];
  for (const it of items || []) {
    const d = it.data || {}; if (!validDate(d.date)) continue;
    const ev = ['BEGIN:VEVENT', `UID:${it.col}-${it.id}@callsheet`, `DTSTAMP:${it.updated ? utcStamp(Date.parse(it.updated)) : now}`];
    if (it.col === 'sessions') {
      if (!validTime(d.start)) continue;
      ev.push(...timed(d.date, d.start, d.end), `SUMMARY:${esc(d.title || 'Creative session')}`, `DESCRIPTION:${esc('Planned in Callsheet')}`,
        'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(d.title || 'Creative session')}`, 'TRIGGER:-PT10M', 'END:VALARM');
    } else if (it.col === 'events') {
      ev.push(...(d.allDay || !validTime(d.start) ? allDay(d.date) : timed(d.date, d.start, d.end)), `SUMMARY:${esc(d.title || 'Event')}`);
      if (d.location) ev.push(`LOCATION:${esc(d.location)}`);
      if (d.notes) ev.push(`DESCRIPTION:${esc(d.notes)}`);
      if (d.kind === 'shift' || d.kind === 'busy') ev.push('TRANSP:OPAQUE');
    } else if (it.col === 'deadlines') {
      ev.push(...allDay(d.date), `SUMMARY:${esc('Deadline: ' + (d.title || ''))}`, 'TRANSP:TRANSPARENT');
      const desc = [d.org, d.notes].filter(Boolean).join('\n\n'); if (desc) ev.push(`DESCRIPTION:${esc(desc)}`);
      if (d.url && /^https?:\/\//.test(d.url)) ev.push(`URL:${String(d.url).replace(/[\r\n]/g, "")}`);
      ev.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc('Deadline in a week: ' + (d.title || ''))}`, 'TRIGGER:-P6DT15H', 'END:VALARM');
    } else continue;
    ev.push('END:VEVENT'); L.push(...ev);
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}
async function feed(token) {
  if (!/^[a-f0-9]{40,80}$/.test(token || '')) return new Response('Not found', { status: 404, headers: CORS });
  const r = await fetch(SB_URL() + '/rest/v1/rpc/calendar_feed_items', { method: 'POST', headers: { apikey: SB_KEY(), Authorization: 'Bearer ' + SB_KEY(), 'Content-Type': 'application/json' }, body: JSON.stringify({ feed_token: token }) });
  if (!r.ok) return new Response('Calendar unavailable', { status: 502, headers: CORS });
  const j = await r.json();
  if (!j || !j.items) return new Response('This calendar link has been turned off. Get a new one in Callsheet → Settings → Calendar.', { status: 404, headers: CORS });
  return new Response(buildFeed(j.tz, j.items), { headers: { ...CORS, 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="callsheet.ics"', 'Cache-Control': 'max-age=300' } });
}

async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = new URL(req.url);
  if (req.method === 'GET') return feed(url.searchParams.get('feed'));
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const user = await signedInUser(req); if (!user) return json({ error: 'auth' }, 401);
  let body; try { body = await req.json(); } catch (_) { return json({ error: 'bad_request' }, 400); }
  try { return json({ ics: await fetchCalendar(body && body.url) }); }
  catch (e) { return json({ error: (e && e.code) || 'unreachable', status: e && e.status }, 200); }
}

if (globalThis.Deno) Deno.serve(handler);
else if (typeof module !== 'undefined') module.exports = { handler, buildFeed, checkUrl, wallToUtc };
