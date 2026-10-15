/* ================= backend: Supabase (accounts, sharing, storage) ================= */
const CFG_OK = !!(window.CS_CONFIG && CS_CONFIG.url && CS_CONFIG.anonKey && window.supabase);
const SB = CFG_OK ? window.supabase.createClient(CS_CONFIG.url, CS_CONFIG.anonKey, { auth: { persistSession: true, autoRefreshToken: true } }) : null;
const SINGLETON_COLS = new Set(['settings']);
const PROJECT_SCOPED = new Set(['tasks']);
S.me = null; S.profile = null; S.pubIds = new Set(); S.roles = {}; S.owners = {}; S.members = {};
const dbId = (col, id) => SINGLETON_COLS.has(col) ? `${id}.${S.me.id}` : id;
const appId = (col, id) => SINGLETON_COLS.has(col) ? String(id).replace(/\.[0-9a-f-]{36}$/i, '') : id;
function rowToDoc(row){ const d = Object.assign({}, row.data || {}, { id: appId(row.col, row.id) }); d._owner = row.owner; return d; }
function cleanDoc(doc){ const o = {}; Object.keys(doc).forEach(k => { if (k !== 'id' && k[0] !== '_') o[k] = doc[k]; }); return o; }
function projectRole(pid){ const p = S.projects[pid]; if (!p) return null; if (!S.me || !p._owner || p._owner === S.me.id) return 'owner'; return S.roles[pid] || 'viewer'; }
function isRO(col, doc){
  if (!S.me) return false;
  if (col === 'projects') return projectRole(doc.id) === 'viewer';
  if (PROJECT_SCOPED.has(col) && doc.projectId && S.projects[doc.projectId]) return projectRole(doc.projectId) === 'viewer';
  return false;
}
const isShared = p => p && S.me && p._owner && p._owner !== S.me.id;
const B = id => !id ? '' : /^https?:/.test(id) ? id : (SB && String(id).includes('/') ? SB.storage.from('files').getPublicUrl(id).data.publicUrl : '');
async function put(col, doc){
  if (isRO(col, doc)) { toast('You can view this project but not change it.'); render(); return; }
  doc.updated = Date.now();
  const prev = S[col][doc.id]; if (prev && prev._owner && !doc._owner) doc._owner = prev._owner;
  if (!doc._owner && S.me) doc._owner = S.me.id;
  S[col][doc.id] = doc; render();
  if (S.mode === 'db') {
    const row = { col, id: dbId(col, doc.id), data: cleanDoc(doc), project_id: PROJECT_SCOPED.has(col) && doc.projectId && S.projects[doc.projectId] ? doc.projectId : null };
    const { error } = await SB.from('records').upsert(row, { onConflict: 'col,id' });
    if (error) handleWriteError(error);
    if (col === 'projects') syncPublicProject(doc);
  } else saveLocal();
}
async function remove(col, id){
  const doc = S[col][id]; if (doc && isRO(col, doc)) { toast('You can view this project but not change it.'); return; }
  delete S[col][id]; render();
  if (S.mode === 'db') {
    const { error } = await SB.from('records').delete().eq('col', col).eq('id', dbId(col, id));
    if (error) handleWriteError(error);
    if (col === 'projects') await SB.from('records').delete().eq('col', 'pubprojects').eq('id', id);
  } else saveLocal();
}
function handleWriteError(e){
  console.warn(e);
  if (/row-level security|permission/i.test(e.message || '')) toast('You don’t have permission to change that.');
  else toast('That change didn’t save. Check your connection and try again.');
}
// public copy of a project, with only the parts its owner chose to show
const PUB_PARTS = { logline:'Logline', genres:'Genres', stage:'Stage', cover:'Cover image' };
async function syncPublicProject(p){
  if (S.mode !== 'db' || isShared(p)) return;
  if (!p.isPublic) { if (S.pubIds.has(p.id)) { S.pubIds.delete(p.id); await SB.from('records').delete().eq('col', 'pubprojects').eq('id', p.id); } return; }
  S.pubIds.add(p.id);
  const parts = p.publicParts || { logline: true, genres: true, stage: true, cover: true }; const SG = stagesFor(p.medium);
  const data = { title: p.title, medium: p.medium, mediumLabel: MEDIA[p.medium] || '', font: p.font || '', titleImg: p.titleImg || '',
    ...(parts.cover ? { cover: p.cover || '', coverPos: p.coverPos || null } : {}), ...(parts.logline ? { logline: p.logline || '' } : {}),
    ...(parts.genres ? { genres: p.genres || [] } : {}), ...(parts.stage ? { stage: stageIdx(p), stageName: SG[stageIdx(p)] || '', stages: SG.length } : {}), updated: Date.now() };
  const { error } = await SB.from('records').upsert({ col: 'pubprojects', id: p.id, data, is_public: true }, { onConflict: 'col,id' });
  if (error) console.warn(error);
}
// files (covers, documents, recordings, fonts)
const STORE = SB ? {
  upload: async (file, { type } = {}) => {
    if (file.size > 20 * 1024 * 1024) throw { code: 'too_large' };
    const ext = (file.name && file.name.includes('.')) ? '.' + file.name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    const path = `${S.me.id}/${(crypto.randomUUID ? crypto.randomUUID() : uid() + uid())}${ext}`;
    const { error } = await SB.storage.from('files').upload(path, file, { contentType: type || file.type || 'application/octet-stream', upsert: false });
    if (error) throw { code: /size|large/i.test(error.message) ? 'too_large' : 'upload_failed', message: error.message };
    return { id: path };
  },
  delete: async id => { if (id && String(id).startsWith(S.me.id + '/')) await SB.storage.from('files').remove([id]); }
} : null;
// loading + live updates
async function loadAll(){
  const all = []; let from = 0;
  for (;;) { const { data, error } = await SB.from('records').select('col,id,owner,project_id,data').in('col', COLS).range(from, from + 999);
    if (error) throw error; all.push(...data); if (data.length < 1000) break; from += 1000; }
  const fresh = {}; COLS.forEach(c => fresh[c] = {});
  all.forEach(r => { if (fresh[r.col]) { const d = rowToDoc(r); if (SINGLETON_COLS.has(r.col) && r.owner !== S.me.id) return; fresh[r.col][d.id] = d; } });
  COLS.forEach(c => S[c] = fresh[c]);
  const { data: sh } = await SB.from('shares').select('project_id,role').eq('user_id', S.me.id); S.roles = {}; (sh || []).forEach(s => S.roles[s.project_id] = s.role);
  const ownerIds = [...new Set(list('projects').map(p => p._owner).filter(o => o && o !== S.me.id))];
  if (ownerIds.length) { const { data: pr } = await SB.from('profiles').select('id,name').in('id', ownerIds); (pr || []).forEach(p => S.owners[p.id] = p.name || 'Someone'); }
  const { data: pubs } = await SB.from('records').select('id').eq('col', 'pubprojects').eq('owner', S.me.id); S.pubIds = new Set((pubs || []).map(x => x.id));
  S.loaded = new Set(COLS);
}
function subscribe(){
  SB.channel('live-' + S.me.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'records' }, pl => {
      const r = pl.new && pl.new.col ? pl.new : pl.old; if (!r || !COLS.includes(r.col)) return;
      if (pl.eventType === 'DELETE') { delete S[r.col][appId(r.col, r.id)]; }
      else { if (SINGLETON_COLS.has(r.col) && r.owner !== S.me.id) return; const d = rowToDoc(r); S[r.col][d.id] = d; }
      render();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'shares' }, () => { clearTimeout(subscribe.t); subscribe.t = setTimeout(() => loadAll().then(render).catch(() => {}), 400); })
    .subscribe();
}
/* ---------- sign in ---------- */
function authScreen(mode, msg){
  const v = $('#view'); document.body.classList.add('signed-out');
  v.innerHTML = `<section class="auth"><div class="auth-card">
    <div class="brand auth-brand"><span class="clap" aria-hidden="true"></span><h1>Callsheet</h1></div>
    <p class="auth-tag">A planner for writers, directors, actors and musicians. Track your projects, deadlines and jobs, and work on projects together.</p>
    <form id="auth-form" data-mode="${mode}" autocomplete="on">
      ${mode === 'signup' ? `<div class="field"><label for="au-name">Your name</label><input id="au-name" type="text" autocomplete="name" required></div>` : ''}
      ${mode !== 'newpass' ? `<div class="field"><label for="au-email">Email</label><input id="au-email" type="email" autocomplete="email" required></div>` : ''}
      ${mode !== 'reset' ? `<div class="field"><label for="au-pass">${mode === 'newpass' ? 'New password' : 'Password'}</label><input id="au-pass" type="password" minlength="8" autocomplete="${mode === 'signin' ? 'current-password' : 'new-password'}" required></div>` : ''}
      ${msg ? `<p class="auth-msg">${esc(msg)}</p>` : ''}
      <button class="btn primary auth-go" type="submit">${{ signin: 'Sign in', signup: 'Create account', reset: 'Email me a reset link', newpass: 'Save new password' }[mode]}</button>
    </form>
    <div class="auth-alt">${mode === 'signin' ? `<button class="linkish" data-act="auth-mode" data-m="signup">New here? Create an account</button><button class="linkish" data-act="auth-mode" data-m="reset">Forgot your password?</button>` : mode !== 'newpass' ? `<button class="linkish" data-act="auth-mode" data-m="signin">Already have an account? Sign in</button>` : ''}</div>
  </div></section>`;
  const f = $('#auth-form [autocomplete="name"]') || $('#auth-form input'); f && f.focus();
}
async function authSubmit(form){
  const mode = form.dataset.mode; const v = id => (($('#' + id) || {}).value || '').trim();
  const btn = form.querySelector('.auth-go'); btn.disabled = true; btn.textContent = 'One moment…';
  try {
    if (mode === 'signin') { const { error } = await SB.auth.signInWithPassword({ email: v('au-email'), password: $('#au-pass').value }); if (error) throw error; }
    else if (mode === 'signup') {
      const { data, error } = await SB.auth.signUp({ email: v('au-email'), password: $('#au-pass').value, options: { data: { name: v('au-name') }, emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error; if (!data.session) return authScreen('signin', 'Check your email to confirm your account, then sign in.');
    } else if (mode === 'reset') { const { error } = await SB.auth.resetPasswordForEmail(v('au-email'), { redirectTo: location.origin + location.pathname }); if (error) throw error; return authScreen('signin', 'If that email has an account, a reset link is on its way.'); }
    else if (mode === 'newpass') { const { error } = await SB.auth.updateUser({ password: $('#au-pass').value }); if (error) throw error; location.hash = ''; location.reload(); }
  } catch(e){ authScreen(mode, /Invalid login/i.test(e.message) ? 'That email and password don’t match.' : /registered/i.test(e.message) ? 'That email already has an account. Sign in instead.' : e.message || 'Something went wrong. Try again.'); }
}
/* ---------- onboarding ---------- */
function onboarding(){
  const p = S.profile || {}; const types = Object.entries(BASE_MEDIA);
  $('#view').innerHTML = `<section class="auth"><div class="auth-card wide"><div class="eyebrow">Welcome to Callsheet</div><h2 class="greet" style="margin:6px 0 4px">Let’s set you up.</h2>
    <p class="auth-tag">You can change all of this later in Settings.</p>
    <form id="onboard" autocomplete="off">
      <div class="field"><label for="ob-name">Your name</label><input id="ob-name" type="text" value="${esc(p.name || '')}" required></div>
      <fieldset class="field fontpick-wrap"><legend>What do you make?</legend><div class="ob-types">${types.map(([k, l]) => `<label class="ob-type" style="--c:${mcolor(k)}"><input type="checkbox" value="${k}" ${['film','short','tv','theatre'].includes(k) ? 'checked' : ''}><span>${ic(MED_ICON[k] || 'star')}${esc(l)}</span></label>`).join('')}</div></fieldset>
      <div class="field"><label for="ob-loc">Where are you based?</label><input id="ob-loc" type="text" value="${esc(p.location || '')}" placeholder="e.g. London"><span class="hint" style="margin:0">Used to find jobs and opportunities near you.</span></div>
      <div class="field check-field"><input type="checkbox" id="ob-public"><label for="ob-public" style="color:var(--ink);font-weight:500">Make a public profile (you choose which projects appear on it)</label></div>
      <div class="actions"><div class="r"><button class="btn primary" type="submit">Start planning ${ic('arrow')}</button></div></div>
    </form></div></section>`;
}
async function onboardSubmit(form){
  const name = $('#ob-name').value.trim(); if (!name) { $('#ob-name').focus(); return; }
  const picked = [...form.querySelectorAll('.ob-types input:checked')].map(x => x.value);
  const location_ = $('#ob-loc').value.trim();
  await SB.from('profiles').upsert({ id: S.me.id, name, location: location_, disciplines: picked, is_public: $('#ob-public').checked, updated_at: new Date().toISOString() });
  S.profile = { ...(S.profile || {}), name, location: location_, disciplines: picked, is_public: $('#ob-public').checked };
  saveSettings({ name, hidden: Object.keys(BASE_MEDIA).filter(k => !picked.includes(k)), jobs: { ...(CFG().jobs || {}), location: location_ || 'London' }, onboarded: true });
  S.tab = 'today'; render();
}
/* ---------- sharing ---------- */
async function loadMembers(pid){ const { data, error } = await SB.rpc('project_members', { pid }); if (!error) S.members[pid] = data || []; return S.members[pid] || []; }
async function openShare(pid){
  const p = S.projects[pid]; if (!p) return; const role = projectRole(pid); const canManage = role === 'owner' || role === 'editor';
  formCtx = { kind: 'share', pid };
  const draw = (members, msg) => {
    if (!formCtx || formCtx.kind !== 'share') return;
    const parts = p.publicParts || { logline: true, genres: true, stage: true, cover: true };
    $('#modal-root').innerHTML = `<div class="scrim" data-act="scrim"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="sh-title"><div class="ai-body">
      <h3 id="sh-title"><span class="hchip" style="--hc:var(--film)">${ic('users')}</span>Share “${esc(p.title)}”</h3>
      ${canManage ? `<form id="share-form" class="share-add" autocomplete="off"><input id="sh-email" type="email" placeholder="Add people by email" aria-label="Email address" required>
        <select id="sh-role" aria-label="Access"><option value="viewer">Viewer</option><option value="editor">Editor</option></select><button class="btn primary" type="submit">Share</button></form>
        <p class="hint" style="margin:0">Viewers can see the project and its steps. Editors can change them too. People without an account get access when they sign up with that email.</p>` : `<p class="ai-sub">${role === 'editor' ? 'You can edit this project.' : 'You can view this project.'}</p>`}
      ${msg ? `<p class="auth-msg">${esc(msg)}</p>` : ''}
      <div class="eyebrow" style="margin-top:6px">People with access</div>
      <div class="sheet members">${members ? members.map(m => `<div class="set-row"><span class="avatar" style="--c:var(--${['film','tv','comedy','theatre','short','music','acting'][[...(m.name || m.email || '?')].reduce((a, c) => a + c.charCodeAt(0), 0) % 7]})">${esc(((m.name || m.email || '?').trim()[0] || '?').toUpperCase())}</span>
        <div class="main"><b>${esc(m.name || m.email || 'Someone')}${m.user_id === S.me.id ? ' (you)' : ''}</b><span class="s">${esc(m.pending ? 'Invited · hasn’t signed up yet' : (m.email && m.name ? m.email : ''))}</span></div>
        <div class="side">${m.role === 'owner' ? '<span class="pill">Owner</span>' : canManage ? `<select class="status" data-act="sh-role" data-u="${esc(m.user_id || '')}" data-e="${esc(m.email || '')}" data-p="${m.pending ? 1 : ''}" aria-label="Access for ${esc(m.name || m.email)}"><option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>Viewer</option><option value="editor" ${m.role === 'editor' ? 'selected' : ''}>Editor</option><option value="__remove">Remove</option></select>` : `<span class="pill">${m.role === 'editor' ? 'Editor' : 'Viewer'}</span>`}</div></div>`).join('') : '<div class="muted-pad" style="padding:12px 16px">Loading…</div>'}</div>
      ${role === 'owner' ? `<div class="eyebrow" style="margin-top:10px">Public profile</div>
        <div class="card pub-box"><div class="field check-field"><input type="checkbox" id="pub-on" ${p.isPublic ? 'checked' : ''}><label for="pub-on" style="color:var(--ink);font-weight:600">Show this project on my public profile</label></div>
        <div class="pub-parts" ${p.isPublic ? '' : 'hidden'}><span class="hint" style="margin:0">The title always shows. Also show:</span>${Object.entries(PUB_PARTS).map(([k, l]) => `<label class="pub-part"><input type="checkbox" data-part="${k}" ${parts[k] ? 'checked' : ''}> ${l}</label>`).join('')}
        <span class="hint" style="margin:0">Steps, documents, notes and people are never public.</span></div></div>` : ''}
      <div class="actions">${role !== 'owner' ? `<button class="btn danger" data-act="sh-leave">Leave project</button>` : ''}<div class="r"><button class="btn ghost" data-act="close-modal">Done</button></div></div></div></div></div>`;
  };
  draw(S.members[pid] || null); const m = await loadMembers(pid); draw(m);
  openShare.redraw = (msg) => draw(S.members[pid], msg);
}
async function shareSubmit(){
  const pid = formCtx && formCtx.pid; const email = $('#sh-email').value.trim(); const role = $('#sh-role').value; if (!email) return;
  const { data, error } = await SB.rpc('share_project', { pid, invitee_email: email, share_role: role });
  if (error) return openShare.redraw('Couldn’t share: ' + error.message);
  await loadMembers(pid); openShare.redraw(data === 'invited' ? `${email} doesn’t have an account yet. They’ll get access when they sign up with that email.` : data === 'owner' ? 'That’s the project’s owner.' : `Shared with ${email}.`);
  const pr = S.projects[pid]; if (pr && !pr.sharedOnce) put('projects', { ...pr, sharedOnce: true });
}
async function shareRoleChange(el){
  const pid = formCtx && formCtx.pid; const v = el.value; const uidv = el.dataset.u, email = el.dataset.e, pending = !!el.dataset.p;
  let error;
  if (v === '__remove') ({ error } = pending ? await SB.from('invites').delete().eq('project_id', pid).eq('email', email) : await SB.from('shares').delete().eq('project_id', pid).eq('user_id', uidv));
  else ({ error } = pending ? await SB.from('invites').update({ role: v }).eq('project_id', pid).eq('email', email) : await SB.from('shares').update({ role: v }).eq('project_id', pid).eq('user_id', uidv));
  await loadMembers(pid); openShare.redraw(error ? 'That didn’t work: ' + error.message : v === '__remove' ? 'Removed.' : 'Access updated.');
}
/* ---------- public profile page ---------- */
async function viewPublicProfile(uidv){
  const v = $('#view'); v.innerHTML = `<div class="empty"><strong>Loading profile…</strong></div>`;
  const { data: prof } = await SB.from('profiles').select('id,name,bio,location,disciplines,links,is_public').eq('id', uidv).maybeSingle();
  if (!prof || (!prof.is_public && (!S.me || S.me.id !== uidv))) { v.innerHTML = `<div class="sheet"><div class="empty"><strong>This profile isn’t public</strong>It may be private, or the link may be wrong.</div></div>`; return; }
  const { data: rows } = await SB.from('records').select('id,data').eq('col', 'pubprojects').eq('owner', uidv);
  const ps = (rows || []).map(r => ({ id: r.id, ...r.data }));
  v.innerHTML = `<section class="pubprof">
    ${S.me ? `<button class="btn ghost back" data-act="pub-back">${ic('back')} Back to my planner</button>` : `<div class="pub-signin"><a class="btn small" href="${location.pathname}">Make your own Callsheet</a></div>`}
    <div class="pp-head"><span class="avatar pp-av" style="--c:var(--film)">${esc((prof.name || '?').trim()[0] || '?')}</span><div><h2 class="page-title" style="font-size:clamp(34px,6vw,54px)">${esc(prof.name || 'Callsheet user')}</h2>
      <div class="pp-meta">${[...(prof.disciplines || []).map(d => MEDIA[d] || d), prof.location].filter(Boolean).map(x => `<span class="pill">${esc(x)}</span>`).join('')}</div></div></div>
    ${prof.bio ? `<p class="pp-bio">${esc(prof.bio)}</p>` : ''}
    ${(prof.links || []).length ? `<div class="pp-links">${prof.links.filter(l => /^https?:\/\//.test(l.url || '')).map(l => `<a class="btn small" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${ic('ext')} ${esc(l.label || l.url.replace(/^https?:\/\//, ''))}</a>`).join('')}</div>` : ''}
    <div class="section-head">${hd('layers','film','Projects')}</div>
    ${ps.length ? `<div class="board posters">${ps.map(p => `<div class="strip pcard pub-card" style="--c:${mcolor(p.medium)}"><span class="pc-art">${posterArt(p)}<span class="pc-shade"></span><span class="pc-top"><span class="pc-med">${ic(MED_ICON[p.medium] || 'clap')}${esc(p.mediumLabel || MEDIA[p.medium] || '')}</span>${p.stageName ? `<span class="pc-no">${String((p.stage || 0) + 1).padStart(2, '0')}<small>/${String(p.stages || 0).padStart(2, '0')}</small></span>` : ''}</span>${titleHtml(p, 'pc-title')}</span>
      <span class="pc-body">${p.stageName ? `<span class="pc-stage"><span class="stage-name">${esc(p.stageName)}</span></span>` : ''}${p.logline ? `<span class="log">${esc(p.logline)}</span>` : ''}${(p.genres || []).length ? `<span class="genres">${p.genres.map(g => `<span class="genre">${esc(g)}</span>`).join('')}</span>` : ''}</span></div>`).join('')}</div>` : `<div class="sheet"><div class="empty"><strong>No public projects yet</strong></div></div>`}
  </section>`;
}
/* ---------- import from the Claude version of Callsheet ---------- */
async function importJSON(file){
  let j; try { j = JSON.parse(await file.text()); } catch(_){ toast('That file isn’t a Callsheet export.'); return; }
  const cols = j.collections || j; let n = 0; const rows = [];
  // files bundled in the export (covers, PDFs, recordings): upload them and point items at the new copies
  const moved = {}; const files = j.files || {}; const fids = Object.keys(files);
  for (let i = 0; i < fids.length; i++) { const f = files[fids[i]]; toast(`Uploading files ${i + 1} of ${fids.length}…`);
    try { const bin = Uint8Array.from(atob(f.b64), c => c.charCodeAt(0)); const blob = new File([bin], f.name || 'file', { type: f.type || 'application/octet-stream' });
      moved[fids[i]] = (await STORE.upload(blob, { type: blob.type })).id; } catch(e){ console.warn('file import failed', fids[i], e); } }
  const fix = v => typeof v === 'string' && v && !v.includes('/') ? (moved[v] || '') : v;
  for (const col of COLS) { const items = cols[col]; if (!items) continue;
    for (const [id, raw] of Object.entries(items)) { const doc = { ...raw }; delete doc.id;
      if (col === 'projects') { doc.cover = fix(doc.cover); doc.titleImg = fix(doc.titleImg); doc.docs = (doc.docs || []).map(d => d.kind === 'file' ? (moved[d.assetId] ? { ...d, assetId: moved[d.assetId] } : null) : d).filter(Boolean); }
      if (col === 'songs') doc.recs = (doc.recs || []).map(r => r.kind === 'file' ? (moved[r.assetId] ? { ...r, assetId: moved[r.assetId] } : null) : r).filter(Boolean);
      if (col === 'settings') { if (id !== 'main') continue; doc.customFonts = (doc.customFonts || []).map(f => f.kind === 'file' ? (moved[f.assetId] ? { ...f, assetId: moved[f.assetId] } : null) : f).filter(Boolean); doc.onboarded = true; }
      rows.push({ col, id: col === 'settings' ? `${id}.${S.me.id}` : id, data: doc, project_id: col === 'tasks' && doc.projectId && (cols.projects || {})[doc.projectId] ? doc.projectId : null }); n++; } }
  toast(`Importing ${n} items…`);
  // projects go in first, on their own, so the tasks that belong to them are allowed in afterwards
  for (const part of [rows.filter(r => r.col === 'projects'), rows.filter(r => r.col !== 'projects')])
    for (let i = 0; i < part.length; i += 200) { const { error } = await SB.from('records').upsert(part.slice(i, i + 200), { onConflict: 'col,id' }); if (error) { toast('Import stopped: ' + error.message); return; } }
  await loadAll(); render(); const lost = fids.length - Object.keys(moved).length;
  toast(`Imported ${n} items${fids.length ? ` and ${Object.keys(moved).length} files` : ''}.${lost ? ` ${lost} files couldn’t be uploaded.` : ''}`);
}
