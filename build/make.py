"""Builds index.html from the single-user Callsheet (source.html) by swapping in
accounts, a shared database, sharing and public profiles. Run: python3 build/make.py"""
import re, os
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
s = open(os.path.join(HERE, 'source.html')).read()
def rep(a, b, n=1):
    global s
    c = s.count(a)
    assert c == n, (c, a[:100])
    s = s.replace(a, b)

# ---- files: /_blob/<id> → storage URL
s = re.sub(r"/_blob/\$\{esc\(([^)]+)\)\}", r"${esc(B(\1))}", s)
s = s.replace("'/_blob/' + d.assetId", "B(d.assetId)").replace("'/_blob/' + r.assetId", "B(r.assetId)")
s = s.replace("url('/_blob/${c.assetId}')", "url('${B(c.assetId)}')")
assert '/_blob/' not in s, [m.start() for m in re.finditer('/_blob/', s)][:5]

# ---- storage layer → Supabase backend
a = s.index("async function put(col, doc){"); b = s.index("function touchProject(pid)")
s = s[:a] + open(os.path.join(HERE, 'chunk_backend.js')).read() + "\n" + s[b:]

# ---- per-project read-only for shared projects
rep("  const st = stageIdx(p); const ro = !S.canWrite; const SG = stagesFor(p.medium);", "  const st = stageIdx(p); const ro = !S.canWrite || isRO('projects', p); const SG = stagesFor(p.medium);")
rep("  const ro = !S.canWrite; const subs = t.subs || [];", "  const ro = !S.canWrite || isRO('tasks', t); const subs = t.subs || [];")
rep("  const ro = !S.canWrite; const d = t.due ? daysUntil(t.due) : null;\n", "  const ro = !S.canWrite || isRO('tasks', t); const d = t.due ? daysUntil(t.due) : null;\n")

# ---- project page: share button, shared-by badge, assignees
rep("""    <div class="ph-over"><div class="ph-kicker">${ic(MED_ICON[p.medium] || 'clap')}${esc(MEDIA[p.medium] || 'Other')}${p.folder ? ' · ' + esc(p.folder) : ''}${p.example ? ' · Example' : ''}</div>""",
    """    <div class="ph-over"><div class="ph-kicker">${ic(MED_ICON[p.medium] || 'clap')}${esc(MEDIA[p.medium] || 'Other')}${p.folder && !isShared(p) ? ' · ' + esc(p.folder) : ''}${isShared(p) ? ` · Shared by ${esc(S.owners[p._owner] || 'someone')} · ${projectRole(p.id) === 'editor' ? 'you can edit' : 'view only'}` : ''}</div>""")
rep("""    ${ro || (S.coverEdit && S.coverEdit.pid === p.id) ? '' : `<span class="phead-actions">""",
    """    ${S.mode === 'db' && !(S.coverEdit && S.coverEdit.pid === p.id) ? `<span class="phead-actions share-act"><button class="btn small glass" data-act="share-open" data-pid="${p.id}">${ic('users')} ${isShared(p) ? (projectRole(p.id) === 'editor' ? 'Editor' : 'Viewer') : (S.members[p.id] || []).length > 1 ? 'Shared · ' + (S.members[p.id].length - 1) : 'Share'}</button></span>` : ''}
    ${ro || (S.coverEdit && S.coverEdit.pid === p.id) ? '' : `<span class="phead-actions">""")
rep("function viewProject(p){", """function viewProject(p){
  if (S.mode === 'db' && (isShared(p) || p.sharedOnce) && !S.members[p.id] && !viewProject.loading) { viewProject.loading = true; loadMembers(p.id).then(() => { viewProject.loading = false; render(); }); }""")
# assignee on tasks
rep("""    [['projectId','select','Project',{opts:projOpts(true)}],['jobId','select','Job',{opts:jobOpts()}]],""",
    """    [['projectId','select','Project',{opts:projOpts(true)}],['jobId','select','Job',{opts:jobOpts()}]],
    ...(v && v.projectId && (S.members[v.projectId] || []).filter(m => !m.pending).length > 1 ? [['assignee','select','Who’s doing it',{opts:[['','Anyone']].concat(S.members[v.projectId].filter(m => !m.pending).map(m => [m.user_id, (m.name || m.email || 'Someone') + (m.user_id === S.me.id ? ' (you)' : '')]))}]] : []),""")
rep("  task: { col:'tasks', title:['New task','Edit task'], fields: () => [", "  task: { col:'tasks', title:['New task','Edit task'], fields: (v) => [")
rep("""<div class="meta"><span class="pill">${IMPACT[+t.impact||2]}</span>${energyPill(t)}""",
    """<div class="meta">${t.assignee && t.projectId && S.members[t.projectId] ? `<span class="pill who">${ic('users')}${esc(((S.members[t.projectId].find(m => m.user_id === t.assignee) || {}).name || 'Someone').split(' ')[0])}${t.assignee === (S.me || {}).id ? ' (you)' : ''}</span>` : ''}<span class="pill">${IMPACT[+t.impact||2]}</span>${energyPill(t)}""")
# Today: only your work from shared projects
rep("""    const p = S.projects[t.projectId]; if (p && p.archived) return;
    if (S.energy !== 'any'""", """    const p = S.projects[t.projectId]; if (p && p.archived) return;
    if (S.me && t.assignee && t.assignee !== S.me.id) return;
    if (p && isShared(p) && t.assignee !== S.me.id && t._owner !== S.me.id) return;
    if (S.energy !== 'any'""")

# ---- projects list: shared with you
rep("""  const all = list('projects').filter(p => !p.archived);
  const genres""", """  const sharedWithMe = list('projects').filter(p => !p.archived && isShared(p));
  const all = list('projects').filter(p => !p.archived && !isShared(p));
  const genres""")
rep("""  if (archived.length) h += `<div class="section-head"><h2>Shelved</h2>""", """  if (sharedWithMe.length) h += `<div class="section-head">${hd('users','film','Shared with you')}</div><div class="board posters">${sharedWithMe.map(p => stripCard(p).replace('<span class="pc-body">', `<span class="pc-body"><span class="shared-by">${ic('users')} ${esc(S.owners[p._owner] || 'Someone')} · ${projectRole(p.id) === 'editor' ? 'Editor' : 'Viewer'}</span>`)).join('')}</div>`;
  if (archived.length) h += `<div class="section-head"><h2>Shelved</h2>""")
rep("  const archived = list('projects').filter(p => p.archived);", "  const archived = list('projects').filter(p => p.archived && !isShared(p));")

# ---- notices
rep("""  if (S.mode === 'local') html += `<div class="notice"><span>Saving on this device only. Open the planner from your Claude app to sync it across phone and laptop.</span></div>`;""",
    """  if (S.mode === 'local') html += `<div class="notice"><span>Demo mode: nothing is connected yet, so this only saves on this device.</span></div>`;""")
rep("""  if (!S.canWrite) html += `<div class="notice"><span>You’re viewing this planner. Only its owner can make changes.</span></div>`;\n""", "")

# ---- render guards (signed out / onboarding / public profile)
rep("function render(){\n", "function render(){\n  if (S.mode !== 'local' && (!S.me || S.onboarding || S.publicView)) return;\n")
rep("function onboarding(){", "function onboarding(){\n  S.onboarding = true; document.body.classList.add('signed-out');")
rep("  S.tab = 'today'; render();\n}", "  S.onboarding = false; document.body.classList.remove('signed-out'); S.tab = 'today'; render();\n}")
rep("async function viewPublicProfile(uidv){", "async function viewPublicProfile(uidv){\n  S.publicView = true; document.body.classList.add('signed-out');")

# ---- search panels and Claude-only features stay hidden until the free search arrives
rep("function scoutPanel(k){", "function scoutPanel(k){\n  if (!S.mcp) return '';")
rep("""  const g = !S.mcp ? `<p class="hint">Google Calendar isn’t linked in this view. Open Callsheet in Claude with the Google Calendar connector on to read your busy times and send sessions there.</p>`""",
    """  const g = !S.mcp ? `<p class="hint">Syncing with Google Calendar, Apple Calendar and Deputy is coming in a later update. Planning, sessions and events all work already.</p>`""")
s = s.replace("""    <div class="field"><label for="cal-deputy">""", """    <div class="field sync-only"><label for="cal-deputy">""", 1)
s = s.replace("""    <div class="field"><label for="cal-apple">""", """    <div class="field sync-only"><label for="cal-apple">""", 1)
rep("""    <div class="two"><div class="field"><label for="cal-target">""", """    <div class="two sync-only"><div class="field"><label for="cal-target">""")
rep("""    <div class="field check-field"><input type="checkbox" id="cal-push\"""", """    <div class="field check-field sync-only"><input type="checkbox" id="cal-push\"""")

# ---- settings: profile + account
rep("""  let th = 'dark'; try { th = localStorage.getItem('callsheet-theme') || 'dark'; } catch(_){}""", """  if (S.mode === 'db') h += profileSettings();
  let th = 'dark'; try { th = localStorage.getItem('callsheet-theme') || 'dark'; } catch(_){}""")
rep("function viewSettings(){", r"""function profileSettings(){
  const p = S.profile || {}; const links = (p.links || []).concat([{}, {}, {}]).slice(0, 3); const pub = location.origin + location.pathname + '#/u/' + S.me.id;
  return `<section class="set-sec"><div class="section-head">${hd('users','film','Your profile')}${p.is_public ? `<span style="display:flex;gap:6px"><button class="btn small" data-act="pub-copy" data-u="${esc(pub)}">${ic('copy')} Copy public link</button><a class="btn small" href="#/u/${S.me.id}" data-act="pub-view">${ic('ext')} View</a></span>` : ''}</div>
   <form class="card" id="profile-form" autocomplete="off"><div class="two"><div class="field"><label for="pf-name">Name</label><input id="pf-name" type="text" value="${esc(p.name || '')}"></div>
   <div class="field"><label for="pf-loc">Based in</label><input id="pf-loc" type="text" value="${esc(p.location || '')}" placeholder="e.g. London"></div></div>
   <div class="field"><label for="pf-bio">Short bio</label><textarea id="pf-bio" rows="3" placeholder="Writer-director making dark comedies for stage and screen…">${esc(p.bio || '')}</textarea></div>
   <fieldset class="field fontpick-wrap"><legend>What you make</legend><div class="ob-types">${Object.entries(BASE_MEDIA).map(([k, l]) => `<label class="ob-type" style="--c:${mcolor(k)}"><input type="checkbox" value="${k}" ${(p.disciplines || []).includes(k) ? 'checked' : ''}><span>${ic(MED_ICON[k] || 'star')}${esc(l)}</span></label>`).join('')}</div></fieldset>
   <div class="field pf-links"><span class="lbl">Links (website, Spotlight, IMDb, showreel…)</span>${links.map((l, i) => `<div class="two"><input type="text" class="pf-ll" data-i="${i}" value="${esc(l.label || '')}" placeholder="Label" aria-label="Link ${i + 1} label"><input type="url" class="pf-lu" data-i="${i}" value="${esc(l.url || '')}" placeholder="https://" aria-label="Link ${i + 1} address"></div>`).join('')}</div>
   <div class="field check-field"><input type="checkbox" id="pf-public" ${p.is_public ? 'checked' : ''}><label for="pf-public" style="color:var(--ink);font-weight:600">Public profile</label></div>
   <p class="hint" style="margin-top:-6px">A public profile shows your name, bio, links and the projects you choose (in each project’s Share box). Everything else stays private.</p>
   <div class="actions"><div class="r"><button class="btn primary" type="submit">Save profile</button></div></div></form></section>
  <section class="set-sec"><div class="section-head">${hd('gear','short','Account')}</div><div class="sheet">
   <div class="set-row"><div class="main"><b>${esc(S.me.email || '')}</b><span class="s">Signed in</span></div><div class="side"><button class="btn small" data-act="signout">Sign out</button></div></div>
   <div class="set-row"><div class="main"><b>Import from the Claude version of Callsheet</b><span class="s">Brings in projects, tasks, deadlines, jobs, songs and settings from an export file. Uploaded files need adding again.</span></div><div class="side"><button class="btn small" data-act="import-json">${ic('upload')} Import file</button></div></div>
   <div class="set-row"><div class="main"><b>Export everything</b><span class="s">Download all your Callsheet data as a file.</span></div><div class="side"><button class="btn small" data-act="export-json">Download</button></div></div>
  </div></section>`;
}
function viewSettings(){""")

# ---- actions, submits and changes
rep("  if (a === 'dash-day') {", r"""  if (a === 'auth-mode') { authScreen(el.dataset.m); return; }
  if (a === 'share-open') { openShare(el.dataset.pid); return; }
  if (a === 'sh-leave') { if (!el.classList.contains('armed')) { el.classList.add('armed'); el.textContent = 'Tap again to leave'; return; } const pid = formCtx && formCtx.pid; await SB.from('shares').delete().eq('project_id', pid).eq('user_id', S.me.id); closeModal(); S.openProject = null; await loadAll(); render(); toast('You’ve left the project'); return; }
  if (a === 'signout') { await SB.auth.signOut(); location.reload(); return; }
  if (a === 'pub-copy') { try { await navigator.clipboard.writeText(el.dataset.u); toast('Public link copied'); } catch(_){ infoModal('Your public link', `<input type="text" value="${esc(el.dataset.u)}" style="width:100%" readonly>`); } return; }
  if (a === 'pub-view') { e.preventDefault(); location.hash = el.getAttribute('href'); viewPublicProfile(S.me.id); window.scrollTo(0,0); return; }
  if (a === 'pub-back') { S.publicView = false; document.body.classList.remove('signed-out'); history.replaceState(null, '', location.pathname); if (S.me && S.started) render(); else location.reload(); return; }
  if (a === 'import-json') { const fi = $('#file-input'); fi.dataset.mode = 'import'; fi.accept = '.json,application/json'; fi.value = ''; fi.click(); return; }
  if (a === 'export-json') { const o = { app: 'callsheet', exported: new Date().toISOString(), collections: {} }; COLS.forEach(c => { o.collections[c] = {}; list(c).filter(d => !d._owner || d._owner === S.me.id).forEach(d => o.collections[c][d.id] = cleanDoc(d)); });
    const blob = new Blob([JSON.stringify(o, null, 1)], { type: 'application/json' }); const aEl = document.createElement('a'); aEl.href = URL.createObjectURL(blob); aEl.download = 'callsheet-export.json'; aEl.click(); return; }
  if (a === 'dash-day') {""")
rep("  if (e.target.id === 'name-form') {", r"""  if (e.target.id === 'auth-form') { e.preventDefault(); authSubmit(e.target); return; }
  if (e.target.id === 'onboard') { e.preventDefault(); onboardSubmit(e.target); return; }
  if (e.target.id === 'share-form') { e.preventDefault(); shareSubmit(); return; }
  if (e.target.id === 'profile-form') { e.preventDefault(); const f = e.target;
    const links = [0,1,2].map(i => ({ label: (f.querySelector(`.pf-ll[data-i="${i}"]`).value || '').trim(), url: (f.querySelector(`.pf-lu[data-i="${i}"]`).value || '').trim() })).filter(l => l.url).map(l => ({ ...l, url: /^https?:\/\//i.test(l.url) ? l.url : 'https://' + l.url }));
    const upd = { name: $('#pf-name').value.trim(), location: $('#pf-loc').value.trim(), bio: $('#pf-bio').value.trim().slice(0, 600), disciplines: [...f.querySelectorAll('.ob-types input:checked')].map(x => x.value), links, is_public: $('#pf-public').checked, updated_at: new Date().toISOString() };
    const { error } = await SB.from('profiles').update(upd).eq('id', S.me.id); if (error) { toast('Couldn’t save: ' + error.message); return; }
    S.profile = { ...S.profile, ...upd }; if (upd.name && upd.name !== CFG().name) saveSettings({ name: upd.name }); toast('Profile saved'); render(); return; }
  if (e.target.id === 'name-form') {""")
rep("document.addEventListener('submit', e => {", "document.addEventListener('submit', async e => {")
rep("  if (el.dataset.act === 'job-status') {", r"""  if (el.dataset.act === 'sh-role') { shareRoleChange(el); return; }
  if (el.id === 'pub-on' || (el.dataset && el.dataset.part)) { const p = S.projects[formCtx && formCtx.pid]; if (!p) return;
    const parts = {}; document.querySelectorAll('.pub-part input').forEach(x => parts[x.dataset.part] = x.checked);
    put('projects', { ...p, isPublic: $('#pub-on').checked, publicParts: parts }); const box = document.querySelector('.pub-parts'); if (box) box.hidden = !$('#pub-on').checked;
    toast($('#pub-on').checked ? 'Shown on your public profile' : 'Hidden from your public profile'); return; }
  if (el.dataset.act === 'job-status') {""")
# import via file input
rep("  if (!f || !S.assets) return;\n  if (mode === 'font') {", "  if (f && mode === 'import') { importJSON(f); return; }\n  if (!f || !S.assets) return;\n  if (mode === 'font') {")

# ---- boot
a = s.index("/* ---------- boot ---------- */"); b = s.index("})();\n</script>", a)
s = s[:a] + r"""/* ---------- boot ---------- */
async function start(user){
  if (S.started) return; S.started = true; S.me = user; S.mode = 'db'; S.assets = STORE;
  document.body.classList.remove('signed-out');
  $('#view').innerHTML = `<div class="empty"><strong>Opening your planner…</strong>Loading projects, tasks and deadlines.</div>`;
  try {
    const { data: prof } = await SB.from('profiles').select('*').eq('id', user.id).maybeSingle();
    S.profile = prof || { id: user.id, name: (user.user_metadata || {}).name || '' };
    await loadAll(); subscribe();
  } catch(e){ $('#view').innerHTML = `<div class="sheet"><div class="empty"><strong>Couldn’t open your planner</strong>${esc(e.message || 'Check your connection and reload.')}</div></div>`; return; }
  if (!CFG().onboarded) { onboarding(); return; }
  render();
}
async function boot(){
  if (!CFG_OK) { S.mode = 'local'; loadLocal(); S.loaded = new Set(COLS); render(); return; }
  const pub = location.hash.match(/^#\/u\/([0-9a-f-]{36})/i);
  const { data: { session } } = await SB.auth.getSession();
  SB.auth.onAuthStateChange((ev, sess) => {
    if (ev === 'PASSWORD_RECOVERY') { S.recovering = true; authScreen('newpass'); return; }
    if (ev === 'SIGNED_IN' && sess && !S.started && !S.recovering && !pub) start(sess.user);
  });
  if (pub) { if (session) S.me = session.user; viewPublicProfile(pub[1]); return; }
  if (!session) { authScreen('signin'); return; }
  if (/type=recovery/.test(location.hash)) return;
  start(session.user);
}
boot();
""" + s[b:]

# ---- document wrapper (full page for hosting)
head = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="Callsheet: a planner for writers, directors, actors and musicians.">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"></script>
<script src="config.js"></script>
"""
_i = s.index('</style>') + len('</style>')
s = head + s[:_i] + "\n</head>\n<body>\n" + s[_i:] + "\n</body>\n</html>\n"

# ---- extra styles
css = """
.pf-links{display:grid;gap:8px}.pf-links .lbl{font-size:13px;font-weight:600;color:var(--muted)}
#profile-form .check-field{margin-top:6px}

/* accounts, sharing, public profiles */
body.signed-out header.top, body.signed-out #fab{display:none !important}
body.signed-out main{padding-top:0}
.sync-only{display:none !important}
.auth{min-height:calc(100vh - 40px);display:grid;place-items:center;padding:40px 0}
.auth-card{width:min(440px,100%);background:var(--surface);background-image:var(--sheen);border:1px solid var(--line);border-radius:22px;padding:28px 24px;box-shadow:var(--shadow);display:grid;gap:14px}
.auth-card.wide{width:min(620px,100%)}
.auth-brand h1{font-stretch:75%;text-transform:uppercase;font-size:34px;letter-spacing:.03em}
.auth-tag{margin:0;color:var(--muted);font-size:14.5px}
.auth-card form{display:grid;gap:12px}
.auth-card .field input{border:1px solid var(--line);background:var(--surface-2);border-radius:11px;padding:11px 12px;width:100%;font-size:16px}
.auth-go{justify-content:center;padding:12px}
.auth-msg{margin:0;padding:10px 12px;border-radius:10px;background:color-mix(in srgb,var(--hl) 10%,var(--surface));border:1px solid color-mix(in srgb,var(--hl) 40%,transparent);font-size:14px}
.auth-alt{display:grid;gap:6px;justify-items:center;font-size:14px}
.auth-alt .linkish{color:var(--muted)}
.ob-types{display:flex;flex-wrap:wrap;gap:8px}
.ob-type input{position:absolute;opacity:0;pointer-events:none}
.ob-type span{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:999px;border:1px solid var(--line);background:var(--surface-2);cursor:pointer;font-weight:600}
.ob-type span .ic{color:var(--c)}
.ob-type input:checked + span{border-color:var(--c);background:color-mix(in srgb,var(--c) 18%,var(--surface));box-shadow:0 0 14px -6px var(--c)}
.ob-type input:focus-visible + span{outline:2px solid var(--hl)}
.share-add{display:grid;grid-template-columns:1fr auto auto;gap:8px}
.share-add input,.share-add select{border:1px solid var(--line);background:var(--surface-2);border-radius:11px;padding:9px 11px;min-width:0}
.members .set-row{grid-template-columns:auto 1fr auto}
.members .avatar{width:34px;height:34px;font-size:14px}
.pub-box{display:grid;gap:8px}
.pub-parts{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center}
.pub-part{display:inline-flex;gap:6px;align-items:center;font-size:14px}
.shared-by{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--muted)}
.shared-by .ic{width:13px;height:13px}
.pill.who .ic{width:12px;height:12px}
.phead.hero-p .phead-actions.share-act{left:12px;right:auto}
.pubprof{display:grid;gap:14px;padding-top:10px}
.pub-signin{display:flex;justify-content:flex-end}
.pp-head{display:flex;gap:16px;align-items:center}
.pp-av{width:72px;height:72px;font-size:30px;flex:none}
.pp-meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.pp-bio{max-width:65ch;font-size:16px;margin:0}
.pp-links{display:flex;gap:8px;flex-wrap:wrap}
.pub-card{cursor:default}
@media (max-width:640px){ .share-add{grid-template-columns:1fr 1fr} .share-add input{grid-column:1 / -1} }
"""
i = s.index('</style>'); s = s[:i] + css + s[i:]
open(os.path.join(ROOT, 'index.html'), 'w').write(s)
print('built index.html', len(s))
