/* ---------- linked calendars (Apple, Google, Outlook, Deputy…) via .ics links ---------- */
// Reading .ics files: events, all-day events, time zones and repeating events.
const ICS_WIN_TZ = { 'GMT Standard Time':'Europe/London', 'Greenwich Standard Time':'Atlantic/Reykjavik', 'W. Europe Standard Time':'Europe/Berlin', 'Romance Standard Time':'Europe/Paris',
  'Central Europe Standard Time':'Europe/Budapest', 'Central European Standard Time':'Europe/Warsaw', 'E. Europe Standard Time':'Europe/Bucharest', 'FLE Standard Time':'Europe/Kiev', 'GTB Standard Time':'Europe/Athens',
  'Eastern Standard Time':'America/New_York', 'Central Standard Time':'America/Chicago', 'Mountain Standard Time':'America/Denver', 'Pacific Standard Time':'America/Los_Angeles',
  'AUS Eastern Standard Time':'Australia/Sydney', 'India Standard Time':'Asia/Kolkata', 'Tokyo Standard Time':'Asia/Tokyo', 'China Standard Time':'Asia/Shanghai', 'UTC':'UTC', 'Coordinated Universal Time':'UTC' };
const ICS_FMT = {};
function icsTzOk(tz){ try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch(_){ return false; } }
function icsTz(raw){
  if (!raw) return '';
  let t = String(raw).replace(/^"|"$/g, '').replace(/^\//, '');
  if (ICS_WIN_TZ[t]) return ICS_WIN_TZ[t];
  if (icsTzOk(t)) return t;
  const m = t.match(/[A-Z][a-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?/); if (m && icsTzOk(m[0])) return m[0];
  if (/London|Dublin|Edinburgh|Lisbon/.test(t)) return 'Europe/London';
  return '';
}
function icsOffset(ms, tz){
  const f = ICS_FMT[tz] || (ICS_FMT[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  const p = {}; f.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
// wall-clock time {y,mo,d,h,mi,s} in a zone → epoch ms. Floating times (no zone) use this device's zone.
function icsInstant(w, tz){
  if (w.utc) return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  if (!tz) return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s).getTime();
  const g = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s); let t = g - icsOffset(g, tz); t = g - icsOffset(t, tz); return t;
}
function icsWall(v){
  const m = String(v || '').trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/); if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0), date: !m[4], utc: !!m[7] };
}
function icsDur(v){
  const m = String(v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/); if (!m) return null;
  const ms = ((+(m[2] || 0) * 7 + +(m[3] || 0)) * 86400 + +(m[4] || 0) * 3600 + +(m[5] || 0) * 60 + +(m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}
const icsUnesc = s => String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
function icsProps(block){
  const out = {};
  block.forEach(line => {
    const i = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/); if (i < 0) return;
    const head = line.slice(0, i), value = line.slice(i + 1); const parts = head.split(';'); const name = parts.shift().toUpperCase();
    const params = {}; parts.forEach(p => { const k = p.indexOf('='); if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, ''); });
    (out[name] = out[name] || []).push({ value, params });
  });
  return out;
}
const ICS_DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
// all dates (as wall-clock {y,mo,d}) a repeat rule produces from the first occurrence, up to `toMs`
function icsExpand(first, rule, toMs, fromMs, inst){
  const r = {}; rule.split(';').forEach(p => { const [k, v] = p.split('='); if (k) r[k.toUpperCase()] = v || ''; });
  const freq = r.FREQ; const iv = Math.max(1, +r.INTERVAL || 1); const count = r.COUNT ? +r.COUNT : 0;
  const until = r.UNTIL ? icsWall(r.UNTIL) : null; const untilMs = until ? (until.date ? Date.UTC(until.y, until.mo - 1, until.d, 23, 59, 59) : inst(until)) : Infinity;
  const byday = (r.BYDAY || '').split(',').filter(Boolean).map(x => { const m = x.match(/^([+-]?\d+)?([A-Z]{2})$/); return m ? { n: m[1] ? +m[1] : 0, wd: ICS_DAYS[m[2]] } : null; }).filter(Boolean);
  const bymd = (r.BYMONTHDAY || '').split(',').filter(Boolean).map(Number);
  const bymo = (r.BYMONTH || '').split(',').filter(Boolean).map(Number);
  const out = []; let n = 0; const day = (y, mo, d) => new Date(Date.UTC(y, mo - 1, d));
  const push = dt => { const w = { ...first, y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() }; const ms = inst(w);
    if (ms < inst(first)) return true; if (ms > untilMs || ms > toMs) return false; n++; if (ms >= fromMs - 86400000 * 40) out.push(w); return !(count && n >= count); };
  const nthOfMonth = (y, mo, b) => { const res = []; const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    for (let d = 1; d <= last; d++) if (day(y, mo, d).getUTCDay() === b.wd) res.push(d);
    if (!b.n) return res; const pick = b.n > 0 ? res[b.n - 1] : res[res.length + b.n]; return pick ? [pick] : []; };
  let guard = 0;
  // jump ahead for long-running repeats with no COUNT (a daily event that started years ago)
  const lag = Math.floor((fromMs - 86400000 * 45 - Date.UTC(first.y, first.mo - 1, first.d)) / 86400000);
  const k0 = unit => (!count && lag > 0) ? Math.floor(Math.floor(lag / unit) / iv) * iv : 0;
  if (freq === 'DAILY') { for (let k = k0(1); guard++ < 3000; k += iv) { const dt = day(first.y, first.mo, first.d + k);
      if (bymo.length && !bymo.includes(dt.getUTCMonth() + 1)) continue; if (byday.length && !byday.some(b => b.wd === dt.getUTCDay())) continue; if (!push(dt)) break; } }
  else if (freq === 'WEEKLY') { const wds = byday.length ? byday.map(b => b.wd) : [day(first.y, first.mo, first.d).getUTCDay()];
    const wkst = ICS_DAYS[r.WKST] != null ? ICS_DAYS[r.WKST] : 1; const f0 = day(first.y, first.mo, first.d); const back = (f0.getUTCDay() - wkst + 7) % 7;
    outer: for (let k = k0(7); guard++ < 1500; k += iv) { const ws = day(first.y, first.mo, first.d - back + k * 7);
      const ds = wds.map(wd => new Date(ws.getTime() + ((wd - wkst + 7) % 7) * 86400000)).sort((a, b) => a - b);
      for (const dt of ds) if (!push(dt)) break outer; } }
  else if (freq === 'MONTHLY') { outer: for (let k = k0(31); guard++ < 600; k += iv) { const y = first.y + Math.floor((first.mo - 1 + k) / 12); const mo = ((first.mo - 1 + k) % 12) + 1;
      const last = new Date(Date.UTC(y, mo, 0)).getUTCDate(); let ds = [];
      if (byday.length) byday.forEach(b => ds.push(...nthOfMonth(y, mo, b)));
      else if (bymd.length) ds = bymd.map(d => d < 0 ? last + d + 1 : d).filter(d => d >= 1 && d <= last);
      else if (first.d <= last) ds = [first.d];
      for (const d of [...new Set(ds)].sort((a, b) => a - b)) if (!push(day(y, mo, d))) break outer; } }
  else if (freq === 'YEARLY') { outer: for (let k = 0; guard++ < 120; k += iv) { const y = first.y + k; const mos = bymo.length ? bymo : [first.mo];
      for (const mo of mos) { let ds = [];
        if (byday.length) byday.forEach(b => ds.push(...nthOfMonth(y, mo, b)));
        else { const d = bymd.length ? bymd[0] : first.d; if (d <= new Date(Date.UTC(y, mo, 0)).getUTCDate()) ds = [d]; }
        for (const d of [...new Set(ds)].sort((a, b) => a - b)) if (!push(day(y, mo, d))) break outer; } } }
  else out.push(first);
  return out;
}
// Parse an .ics file into occurrences between fromMs and toMs.
// Each: { uid, title, loc, free, allDay, sd/ed (YYYY-MM-DD, all-day; ed exclusive) or s/e (epoch ms) }
function icsParse(text, fromMs, toMs){
  const lines = String(text || '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const events = []; let cur = null; let depth = 0;
  for (const line of lines) {
    if (/^BEGIN:VEVENT$/i.test(line)) { cur = []; depth = 0; continue; }
    if (!cur) continue;
    if (/^BEGIN:/i.test(line)) { depth++; continue; }
    if (/^END:VEVENT$/i.test(line)) { events.push(icsProps(cur)); cur = null; continue; }
    if (/^END:/i.test(line)) { depth--; continue; }
    if (depth === 0) cur.push(line);
  }
  const one = (p, k) => p[k] && p[k][0];
  const overrides = {}; const out = [];
  const occ = (p, w, tz, durMs, allDayDays) => {
    const base = { uid: (one(p, 'UID') || {}).value || '', title: icsUnesc((one(p, 'SUMMARY') || {}).value || '') || 'Busy', loc: icsUnesc((one(p, 'LOCATION') || {}).value || ''),
      free: /TRANSPARENT/i.test((one(p, 'TRANSP') || {}).value || '') };
    if (w.date) { const sd = `${w.y}-${pad(w.mo)}-${pad(w.d)}`; const e = new Date(Date.UTC(w.y, w.mo - 1, w.d + allDayDays));
      return { ...base, allDay: true, sd, ed: `${e.getUTCFullYear()}-${pad(e.getUTCMonth() + 1)}-${pad(e.getUTCDate())}` }; }
    const s = icsInstant(w, tz); return { ...base, s, e: s + durMs };
  };
  const timing = p => {
    const ds = one(p, 'DTSTART'); if (!ds) return null; const w = icsWall(ds.value); if (!w) return null;
    if ((ds.params.VALUE || '').toUpperCase() === 'DATE') w.date = true;
    const tz = w.utc || w.date ? '' : icsTz(ds.params.TZID);
    const de = one(p, 'DTEND'); const du = one(p, 'DURATION'); let durMs = 0, days = 1;
    if (w.date) { const ew = de && icsWall(de.value); if (ew) days = Math.max(1, Math.round((Date.UTC(ew.y, ew.mo - 1, ew.d) - Date.UTC(w.y, w.mo - 1, w.d)) / 86400000)); else if (du) days = Math.max(1, Math.round(icsDur(du.value) / 86400000)); }
    else if (de) { const ew = icsWall(de.value); durMs = ew ? icsInstant(ew, ew.utc ? '' : (icsTz(de.params.TZID) || tz)) - icsInstant(w, tz) : 3600000; }
    else if (du) durMs = icsDur(du.value) || 0;
    if (durMs < 0) durMs = 0;
    return { w, tz, durMs, days };
  };
  const key = (w, tz) => w.date ? `${w.y}-${w.mo}-${w.d}` : String(icsInstant(w, tz));
  events.forEach(p => { const rid = one(p, 'RECURRENCE-ID'); if (!rid) return; const uid = (one(p, 'UID') || {}).value || ''; const w = icsWall(rid.value); if (!w) return;
    if ((rid.params.VALUE || '').toUpperCase() === 'DATE') w.date = true;
    (overrides[uid] = overrides[uid] || new Set()).add(key(w, w.utc || w.date ? '' : icsTz(rid.params.TZID)));
    if (/CANCELLED/i.test((one(p, 'STATUS') || {}).value || '')) return;
    const t = timing(p); if (t) out.push(occ(p, t.w, t.tz, t.durMs, t.days)); });
  events.forEach(p => {
    if (one(p, 'RECURRENCE-ID')) return; if (/CANCELLED/i.test((one(p, 'STATUS') || {}).value || '')) return;
    const t = timing(p); if (!t) return; const uid = (one(p, 'UID') || {}).value || '';
    const rr = one(p, 'RRULE');
    const ex = new Set(); (p.EXDATE || []).forEach(x => x.value.split(',').forEach(v => { const w = icsWall(v); if (w) { if (t.w.date) w.date = true; ex.add(key(w, w.utc || w.date ? '' : (icsTz(x.params.TZID) || t.tz))); } }));
    const skip = overrides[uid] || new Set();
    const ws = rr ? icsExpand(t.w, rr.value, toMs, fromMs, w => icsInstant(w, t.tz)) : [t.w];
    (p.RDATE || []).forEach(x => x.value.split(',').forEach(v => { const w = icsWall(v); if (w) ws.push(t.w.date ? { ...t.w, y: w.y, mo: w.mo, d: w.d } : { ...w, utc: w.utc }); }));
    ws.forEach(w => { const k = key(w, t.tz); if (ex.has(k) || skip.has(k)) return; out.push(occ(p, w, t.tz, t.durMs, t.days)); });
  });
  return out.filter(o => o.allDay ? (Date.parse(o.ed) > fromMs && Date.parse(o.sd) < toMs) : (o.e > fromMs && o.s < toMs));
}
// Spread occurrences into the calendar's per-day busy list (same shape the Google Calendar sync used).
function icsToDays(out, list_, link){
  list_.forEach((o, i) => {
    const base = { id: `${link.id}:${o.uid || i}:${o.allDay ? o.sd : o.s}`, title: o.title, free: o.free, shift: !!link.work, cal: link.name || 'Calendar', link: '', loc: o.loc, src: link.id };
    if (o.allDay) { let d = o.sd; let n = 0; do { (out[d] = out[d] || []).push({ ...base, allDay: true }); d = addDays(d, 1); } while (d < o.ed && ++n < 62); return; }
    const sd = new Date(o.s), ed = new Date(Math.max(o.e, o.s)); let cur = new Date(sd); let n = 0;
    if (o.e <= o.s) { (out[dstr(cur)] = out[dstr(cur)] || []).push({ ...base, s: cur.getHours() * 60 + cur.getMinutes(), en: cur.getHours() * 60 + cur.getMinutes() + 15 }); return; }
    while (cur < ed && n++ < 14) {
      const dayEnd = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
      const s = cur.getHours() * 60 + cur.getMinutes(); const en = ed < dayEnd ? ed.getHours() * 60 + ed.getMinutes() : 1440;
      (out[dstr(cur)] = out[dstr(cur)] || []).push({ ...base, s, en: Math.max(en, s + 15) });
      cur = dayEnd;
    }
  });
  return out;
}

// ---------- linking calendars ----------
const ICS_ERR = { bad_url: 'That doesn’t look like a calendar link. It should start with webcal:// or https://.', not_found: 'That calendar link no longer works. Get a fresh one and add it again.',
  private: 'That calendar is private. Use its public or secret iCal link instead (see “How to get a link”).', not_calendar: 'That link opens a web page, not a calendar. Use the calendar’s iCal / .ics / webcal link.',
  too_big: 'That calendar is too big to read (over 5 MB).', timeout: 'That calendar took too long to answer. Try again in a minute.', unreachable: 'Couldn’t reach that calendar. Check the link and try again.',
  auth: 'You’ve been signed out. Reload the page and sign in.', no_server: 'Calendar syncing isn’t switched on for this Callsheet yet (the “calendar” server function hasn’t been set up).' };
function calLinks(){
  const c = CFG().cal || {};
  if (Array.isArray(c.links)) return c.links.filter(l => l && l.url);
  const out = []; if (c.deputyUrl) out.push({ id: 'deputy', name: 'Deputy shifts', url: c.deputyUrl, work: true }); if (c.appleUrl) out.push({ id: 'apple', name: 'Apple Calendar', url: c.appleUrl, work: false });
  return out;
}
const icsOn = () => S.mode === 'db' && !S.mcp;
async function icsFetch(url){
  const { data } = await SB.auth.getSession(); const tok = data && data.session && data.session.access_token;
  let r; try { r = await fetch(CS_CONFIG.url.replace(/\/$/, '') + '/functions/v1/calendar', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CS_CONFIG.anonKey, Authorization: 'Bearer ' + tok }, body: JSON.stringify({ url }) }); }
  catch(_){ throw { code: 'no_server' }; }
  if (r.status === 404) throw { code: 'no_server' };
  if (r.status === 401) throw { code: 'auth' };
  let j; try { j = await r.json(); } catch(_){ throw { code: 'no_server' }; }
  if (j.error) throw { code: j.error };
  return j.ics;
}
const ICS_KEY = () => 'callsheet-ics-' + (S.me ? S.me.id : '');
function icsRange(){ const t = todayStr(); return [Date.parse(addDays(t, -120) + 'T00:00:00'), Date.parse(addDays(t, 430) + 'T00:00:00')]; }
function icsRestore(){
  try { const c = JSON.parse(localStorage.getItem(ICS_KEY()) || 'null'); if (!c || !c.days) return;
    const ids = new Set(calLinks().map(l => l.id)); const days = {};
    Object.entries(c.days).forEach(([d, arr]) => { const keep = arr.filter(g => ids.has(g.src)); if (keep.length) days[d] = keep; });
    S.gcal = days; S.gcalAt = c.at || 0; S.gcalState = 'ok'; S.icsErr = c.errs || {}; } catch(_){}
}
async function icsLoad(force){
  if (!icsOn()) return; const links = calLinks();
  if (!links.length) { if (Object.keys(S.gcal || {}).length) { S.gcal = {}; render(); } S.gcalState = 'none'; return; }
  if (S.gcalState === 'loading') return;
  if (!force && S.gcalAt && Date.now() - S.gcalAt < 20 * 60000) return;
  S.gcalState = 'loading'; if (S.tab === 'calendar') render();
  const [from, to] = icsRange(); const days = {}; const errs = {}; let okN = 0;
  await Promise.all(links.map(async l => {
    try { const text = await icsFetch(l.url); icsToDays(days, icsParse(text, from, to), l); okN++; }
    catch(e){ errs[l.id] = (e && e.code) || 'unreachable';
      Object.entries(S.gcal || {}).forEach(([d, arr]) => arr.forEach(g => { if (g.src === l.id) (days[d] = days[d] || []).push(g); })); } // keep the last good copy
  }));
  S.gcal = days; S.icsErr = errs; S.gcalAt = Date.now();
  S.gcalState = okN ? 'ok' : 'error'; S.gcalMsg = okN ? '' : (ICS_ERR[Object.values(errs)[0]] || ICS_ERR.unreachable);
  try { localStorage.setItem(ICS_KEY(), JSON.stringify({ at: S.gcalAt, days, errs })); } catch(_){}
  // the Claude version copied Deputy/Apple events into Callsheet; linked calendars replace those copies
  if (okN) list('events').filter(e => (e.source === 'deputy' || e.source === 'apple') && (!e._owner || e._owner === S.me.id)).forEach(e => remove('events', e.id));
  render();
}
function linkHost(u){ try { return new URL(String(u).replace(/^webcals?:/i, 'https:')).hostname.replace(/^www\./, ''); } catch(_){ return ''; } }
function guessCalName(u){ const h = linkHost(u);
  return /icloud\.com/.test(h) ? 'Apple Calendar' : /google\.com/.test(h) ? 'Google Calendar' : /outlook|office365|live\.com/.test(h) ? 'Outlook' : /deputy/.test(h) ? 'Deputy shifts' : /rotacloud|planday|wheniwork|sling|7shifts|homebase|rotaready/.test(h) ? 'Work rota' : (h || 'Calendar'); }
const isWorkHost = u => /deputy|rotacloud|planday|wheniwork|sling|7shifts|homebase|rotaready|harri|fourth/.test(linkHost(u));

// ---------- Callsheet → your calendar (subscription link) ----------
async function feedToken(reset){
  const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'Europe/London';
  const { data, error } = await SB.rpc('calendar_feed', { reset: !!reset, tz });
  if (error) { S.feedErr = /calendar_feed/.test(error.message || '') ? 'no_db' : 'err'; return ''; }
  S.feedErr = ''; S.feedTok = data; return data;
}
const feedUrl = () => S.feedTok ? `${CS_CONFIG.url.replace(/\/$/, '')}/functions/v1/calendar?feed=${S.feedTok}` : '';
function linkedCalSettings(){
  if (S.mode !== 'db') return `<section class="set-sec"><div class="section-head">${hd('cal','tv','Your calendars')}</div><div class="card"><p class="hint" style="margin:0">Sign in to link Apple Calendar, Google Calendar, Outlook or your work rota.</p></div></section>`;
  if (S.feedTok === undefined && !S.feedLoading) { S.feedLoading = true; feedToken(false).then(() => { S.feedLoading = false; if (S.tab === 'settings') render(); }); }
  const links = calLinks(); const errs = S.icsErr || {}; const ro = !S.canWrite;
  const fu = feedUrl(); const web = fu.replace(/^https:/, 'webcal:');
  const row = l => `<div class="set-row"><span class="tdot" style="--c:var(--${l.work ? 'work' : 'personal'})">${ic(l.work ? 'inbox' : 'calendar')}</span>
    <div class="main"><b>${esc(l.name || 'Calendar')}</b><span class="s">${esc(linkHost(l.url))} · ${l.work ? 'Work: Callsheet keeps a gap around these' : 'Personal: Callsheet plans around these'}${errs[l.id] ? ` · <span class="err-t">${esc(ICS_ERR[errs[l.id]] || ICS_ERR.unreachable)}</span>` : ''}</span></div>
    <div class="side">${ro ? '' : `<select class="status" data-act="cl-kind" data-id="${esc(l.id)}" aria-label="Type of calendar"><option value="0" ${l.work ? '' : 'selected'}>Personal</option><option value="1" ${l.work ? 'selected' : ''}>Work shifts</option></select><button class="iconbtn" data-act="cl-del" data-id="${esc(l.id)}" aria-label="Remove ${esc(l.name)}" title="Remove">${ic('trash')}</button>`}</div></div>`;
  return `<section class="set-sec" id="cal-links"><div class="section-head">${hd('cal','tv','Your calendars')}${links.length ? `<button class="btn small" data-act="gc-refresh">${ic('trend')} Sync now</button>` : ''}</div>
  <p class="hint" style="margin-top:-4px">Callsheet shows your other calendars and plans creative time around them. It only reads them and never changes anything in them.</p>
  ${links.length ? `<div class="sheet">${links.map(row).join('')}</div>` : ''}
  ${ro ? '' : `<form class="card cl-add-form" id="callink-form" autocomplete="off">
    <div class="field"><label for="cl-url">Add a calendar link</label><input id="cl-url" type="text" inputmode="url" placeholder="webcal://… or https://…/basic.ics" required></div>
    <div class="two"><div class="field"><label for="cl-name">Name (optional)</label><input id="cl-name" type="text" placeholder="e.g. Personal, Deputy shifts"></div>
    <div class="field"><label for="cl-work">What’s in it</label><select id="cl-work"><option value="auto">Work out from the link</option><option value="0">Personal things</option><option value="1">Work shifts</option></select></div></div>
    ${S.clMsg ? `<p class="auth-msg">${esc(S.clMsg)}</p>` : ''}
    <div class="actions"><details class="howto"><summary>How to get a link</summary>
      <p><b>Apple Calendar (iPhone):</b> Calendar app → Calendars → ⓘ next to the calendar → turn on <i>Public Calendar</i> → Share Link → Copy.<br><b>Apple Calendar (Mac):</b> right-click the calendar → Share Calendar → tick <i>Public</i> → copy the link.</p>
      <p><b>Google Calendar:</b> on a computer, open calendar.google.com → ⚙ Settings → click the calendar under “Settings for my calendars” → scroll to <i>Secret address in iCal format</i> → copy it. This stays private.</p>
      <p><b>Outlook:</b> outlook.com → ⚙ Settings → Calendar → Shared calendars → Publish a calendar → choose “Can view all details” → copy the ICS link.</p>
      <p><b>Deputy:</b> Profile → <i>Add your shifts to your personal calendar app</i> → Webcal → Copy link. Most rota apps (RotaCloud, Planday, When I Work) have a similar “calendar feed” or “iCal” link.</p>
      <p class="hint" style="margin:0">Anyone who has one of these links can read that calendar, so only paste them here. Callsheet keeps your links in your own account; people you share projects with can’t see them.</p></details>
      <div class="r"><button class="btn primary" type="submit" ${S.clBusy ? 'disabled' : ''}>${S.clBusy ? 'Checking…' : 'Add calendar'}</button></div></div></form>`}
  <div class="eyebrow" style="margin-top:14px">Callsheet in your calendar</div>
  <div class="card feed-card">
    <p style="margin:0 0 10px">Add your booked sessions, your events and the deadlines you follow to Apple Calendar, Google Calendar or Outlook. They update by themselves.</p>
    ${S.feedErr === 'no_db' ? `<p class="hint err-t">${esc(ICS_ERR.no_server)}</p>` : !fu ? `<p class="hint">Getting your link…</p>` : `
    <div class="feed-btns"><a class="btn" href="${esc(web)}">${ic('calendar')} Add to Apple Calendar</a><a class="btn" href="https://calendar.google.com/calendar/r?cid=${encodeURIComponent(web)}" target="_blank" rel="noopener">${ic('calendar')} Add to Google Calendar</a><button class="btn" data-act="feed-copy" data-u="${esc(fu)}">${ic('copy')} Copy link</button></div>
    <p class="hint" style="margin:10px 0 0">Apple Calendar checks for changes every hour or so (you can change how often in the calendar’s settings). Google Calendar can take several hours to pick up changes. Google’s button only works on a computer. On a phone, add it in Google Calendar on the web and it’ll then show up in the app.</p>
    <p class="hint" style="margin:6px 0 0">This link is private to you. If you’ve shared it by mistake, <button class="linkish" data-act="feed-reset">make a new link</button> and the old one will stop working.</p>`}
  </div></section>`;
}
async function calLinkSubmit(){
  const raw = $('#cl-url').value.trim(); if (!raw) return;
  const url = /^[a-z]+:\/\//i.test(raw) ? raw : 'https://' + raw;
  if (calLinks().some(l => l.url === url)) { S.clMsg = 'That calendar is already linked.'; render(); return; }
  S.clBusy = true; S.clMsg = ''; render();
  try {
    const text = await icsFetch(url); const [from, to] = icsRange(); const occ = icsParse(text, from, to);
    const kind = $('#cl-work') ? $('#cl-work').value : 'auto';
    const link = { id: 'cal' + uid(), name: ($('#cl-name') && $('#cl-name').value.trim()) || guessCalName(url), url, work: kind === 'auto' ? isWorkHost(url) : kind === '1' };
    saveSettings({ cal: { ...(CFG().cal || {}), links: [...calLinks(), link] } });
    S.gcal = icsToDays({ ...(S.gcal || {}) }, occ, link); S.gcalState = 'ok'; S.gcalAt = 0;
    S.clBusy = false; render(); toast(`Linked ${link.name}: ${occ.length} event${occ.length === 1 ? '' : 's'} found`); icsLoad(true);
  } catch(e){ S.clBusy = false; S.clMsg = ICS_ERR[e && e.code] || ICS_ERR.unreachable; render(); }
}
