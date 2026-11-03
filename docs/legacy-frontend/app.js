/* Core Vision Studio frontend. Plain JS, no build step. Talks to the FastAPI backend under /api. */
const $ = id => document.getElementById(id);
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
const COL = { mineralization: '#ff8a3d', alteration: '#2fbf9b', vein: '#4c8dff', structure: '#ff4d6a', lithology: '#9aa3b2' };
const CATS = Object.keys(COL);
const OPEN = c => c === 'vein' || c === 'structure';
const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 12);
const numOr = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
const BUSY = s => s === 'queued' || s === 'analyzing';

let HEALTH = {}, PROJS = [], P = null, H = null, IM = null, sel = null, mode = 'edit', lay = null, tmp = null, T = null, view = 1;
const HIST = {}; // image id -> {u:[], r:[]} snapshots of the feature list

/* ---------- API ---------- */
async function api(method, path, body, isForm) {
  const o = { method, headers: {} };
  if (body !== undefined) {
    if (isForm) o.body = body; else { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  }
  const r = await fetch(path, o);
  if (!r.ok) {
    let m = 'HTTP ' + r.status;
    try { const j = await r.json(); m = typeof j.detail === 'string' ? j.detail : (j.detail || []).map(d => d.msg).join('; ') || m; } catch (e) { }
    throw new Error(m);
  }
  return r.status === 204 ? null : r.json();
}
let toastT;
function toast(m) { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 4000); }
const guard = fn => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message || String(e)); } };

/* ---------- geometry helpers ---------- */
const cen = pts => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
function pathD(pts, closed) {
  const n = pts.length; if (n < 3) return 'M' + pts.map(p => p.join(' ')).join('L');
  const g = i => closed ? pts[(i + n * 2) % n] : pts[Math.max(0, Math.min(n - 1, i))]; let d = 'M' + g(0).join(' ');
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = g(i - 1), b = g(i), c = g(i + 1), e = g(i + 2);
    d += `C${b[0] + (c[0] - a[0]) / 6} ${b[1] + (c[1] - a[1]) / 6} ${c[0] - (e[0] - b[0]) / 6} ${c[1] - (e[1] - b[1]) / 6} ${c[0]} ${c[1]}`;
  }
  return d + (closed ? 'Z' : '');
}
const dTxt = f => f.from_m == null ? '' : f.from_m.toFixed(2) + (f.to_m - f.from_m > .004 ? '–' + f.to_m.toFixed(2) : '') + ' m';

/* ---------- projects ---------- */
function pjSel() {
  const s = $('pj'); s.textContent = '';
  if (!PROJS.length) s.append(el('option', null, 'No project'));
  PROJS.forEach(p => { const o = el('option', null, p.name); o.value = p.id; s.append(o); });
  if (P) s.value = P.id;
}
async function loadProjects() { PROJS = await api('GET', '/api/projects'); pjSel(); }
async function openProject(id, keep) {
  if (!id) { P = H = IM = null; sel = null; all(); return; }
  const hid = keep && H && H.id, iid = keep && IM && IM.id;
  P = await api('GET', '/api/projects/' + id);
  H = (hid && P.holes.find(h => h.id === hid)) || P.holes[0] || null;
  IM = (iid && H && H.images.find(i => i.id === iid)) || null;
  sel = null;
  $('pdep').value = P.deposit_style || ''; $('pcrs').value = P.crs_epsg ?? '';
  try { localStorage.setItem('cv.project', id); } catch (e) { }
  all(); poll();
}
$('npj').onclick = guard(async () => {
  const n = $('pname').value.trim(); if (!n) return;
  const p = await api('POST', '/api/projects', { name: n }); $('pname').value = '';
  await loadProjects(); await openProject(p.id);
});
$('pj').onchange = guard(() => openProject($('pj').value));
$('pdep').onchange = guard(async () => { if (!P) return; P.deposit_style = $('pdep').value; await api('PATCH', '/api/projects/' + P.id, { deposit_style: P.deposit_style }); });
$('pcrs').onchange = guard(async () => { if (!P) return; const v = parseInt($('pcrs').value); await api('PATCH', '/api/projects/' + P.id, { crs_epsg: Number.isFinite(v) ? v : null }); });
$('dpj').onclick = guard(async () => {
  if (!P || !confirm(`Delete project "${P.name}" with all holes, images and logs? This cannot be undone.`)) return;
  await api('DELETE', '/api/projects/' + P.id); P = H = IM = null; await loadProjects(); await openProject(PROJS[0] && PROJS[0].id);
});
async function importCsv(input, kind) {
  const f = input.files[0]; input.value = ''; if (!f || !P) return;
  const fd = new FormData(); fd.append('file', f);
  const r = await api('POST', `/api/projects/${P.id}/import/${kind}`, fd, true);
  toast(kind === 'collars' ? `Collars: ${r.created} new, ${r.updated} updated` : `Surveys loaded for ${r.holes} hole(s)`
    + (r.errors.length ? ` · ${r.errors.length} issue(s): ${r.errors.slice(0, 3).join('; ')}` : ''));
  await openProject(P.id, true);
}
$('icol').onchange = guard(() => importCsv($('icol'), 'collars'));
$('isur').onchange = guard(() => importCsv($('isur'), 'surveys'));
$('exp').onchange = () => { const v = $('exp').value; $('exp').value = ''; if (v && P) location.href = `/api/projects/${P.id}/export/${v}`; };

/* ---------- holes ---------- */
$('nh').onclick = guard(async () => {
  if (!P) { toast('Create a project first.'); return; }
  const n = $('hn').value.trim(); if (!n) { toast('Give the hole a name.'); return; }
  const h = await api('POST', `/api/projects/${P.id}/holes`, {
    name: n, x: numOr($('hx').value, 0), y: numOr($('hy').value, 0), z: numOr($('hz').value, 0),
    azimuth: numOr($('haz').value, 0), dip: numOr($('hdip').value, 60), length: Math.max(1, numOr($('hlen').value, 100))
  });
  P.holes.push(h); H = h; IM = null; sel = null; $('hn').value = ''; all();
});
// On narrow screens the work area sits above the sidebar, so bring it into view after picking from the list.
const focusMain = () => { if (matchMedia('(max-width:860px)').matches) $('main').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
const statusMark = im => im.status === 'queued' ? '⋯' : im.status === 'analyzing' ? '⟳' : im.status === 'error' ? '⚠' : '';
function holesUI() {
  const w = $('holes'); w.textContent = '';
  $('ppn').hidden = !P;
  if (!P) { w.append(el('div', 'mu', 'Create a project to begin.')); $('ahole').textContent = ''; return; }
  if (!P.holes.length) w.append(el('div', 'mu tiny', 'No holes yet. Add one below or import a collar CSV.'));
  P.holes.forEach(h => {
    const d = el('div', 'hl' + (h === H ? ' on' : ''));
    d.append(el('b', null, h.name), el('small', null, `  E${h.x} N${h.y} RL${h.z} · az ${h.azimuth}° dip ${h.dip}° · ${h.length} m${h.surveys.length ? ' · surveyed' : ''}`));
    d.onclick = () => { H = h; IM = null; sel = null; all(); focusMain(); };
    h.images.forEach(im => {
      const r = el('div', 'il' + (im === IM ? ' on' : ''));
      r.append(el('span', null, `${im.from_m ?? '?'}–${im.to_m ?? '?'} m`), el('span', 'mu', (im.name || '').slice(0, 14)),
        el('span', 'mu', statusMark(im) || `${im.features.length} ft`));
      r.title = im.error || '';
      r.onclick = e => { e.stopPropagation(); H = h; IM = im; sel = null; mode = 'edit'; all(); focusMain(); };
      d.append(r);
    });
    w.append(d);
  });
  $('ahole').textContent = H ? 'Adding to: ' + H.name : 'Select or add a hole.';
  if (H && !$('afrom').value && H.images.length) { const last = H.images[H.images.length - 1]; if (last.to_m != null) $('afrom').value = last.to_m; }
}

/* ---------- images ---------- */
$('addgo').onclick = guard(async () => {
  const f = $('afile').files[0]; if (!H || !f) { $('ast').textContent = 'Pick a hole and a photo.'; return; }
  const fr = $('afrom').value.trim(), to = $('ato').value.trim();
  if (fr && to && parseFloat(to) <= parseFloat(fr)) { $('ast').textContent = '"To" must be greater than "From".'; return; }
  const fd = new FormData(); fd.append('file', f); if (fr) fd.append('from_m', fr); if (to) fd.append('to_m', to);
  fd.append('direction', $('adir').value); fd.append('analyze', $('aai').checked && HEALTH.ai_configured ? 'true' : 'false');
  $('ast').textContent = 'Uploading…'; $('addgo').disabled = true;
  try {
    const im = await api('POST', `/api/holes/${H.id}/images`, fd, true);
    H.images.push(im); IM = im; sel = null; mode = 'edit';
    $('afile').value = ''; $('afrom').value = im.to_m ?? ''; $('ato').value = '';
    $('ast').textContent = ''; all(); poll(); focusMain();
  } finally { $('addgo').disabled = false; if ($('ast').textContent === 'Uploading…') $('ast').textContent = ''; }
});
function replaceImage(fresh) {
  for (const h of (P ? P.holes : [])) {
    const i = h.images.findIndex(x => x.id === fresh.id);
    if (i >= 0) { const wasCur = IM && IM.id === fresh.id; h.images[i] = fresh; if (wasCur) { IM = fresh; sel = null; } return; }
  }
}
let pollT = null;
function poll() {
  clearTimeout(pollT); if (!P) return;
  const busy = P.holes.flatMap(h => h.images).filter(i => BUSY(i.status)); if (!busy.length) return;
  pollT = setTimeout(async () => {
    let changed = false;
    for (const im of busy) {
      try { const f = await api('GET', '/api/images/' + im.id); if (f.status !== im.status) { replaceImage(f); changed = true; if (f.status === 'error') toast('Analysis failed: ' + f.error); } } catch (e) { }
    }
    if (changed) all(); poll();
  }, 2500);
}
const reanalyze = guard(async () => {
  if (!HEALTH.ai_configured) { toast('AI is not configured on the server. Set ANTHROPIC_API_KEY in .env and restart.'); return; }
  const f = await api('POST', `/api/images/${IM.id}/analyze`); replaceImage(f); all(); poll();
});

/* ---------- feature saving, undo/redo ---------- */
const hist = () => HIST[IM.id] || (HIST[IM.id] = { u: [], r: [] });
const snapState = () => JSON.stringify(IM.features);
function snap() { const h = hist(); h.u.push(snapState()); if (h.u.length > 100) h.u.shift(); h.r = []; }
function restore(s) { IM.features = JSON.parse(s); sel = null; save(); main(); }
function undo() { if (!IM) return; const h = hist(); if (!h.u.length) return; h.r.push(snapState()); restore(h.u.pop()); }
function redo() { if (!IM) return; const h = hist(); if (!h.r.length) return; h.u.push(snapState()); restore(h.r.pop()); }
let svT, svImg;
function save() {
  if (!IM) return; const img = IM; if (svImg && svImg !== img) flushSave(); svImg = img;
  clearTimeout(svT); svT = setTimeout(flushSave, 450);
}
async function flushSave() {
  clearTimeout(svT); const img = svImg; svImg = null; if (!img) return;
  const body = img.features.map(f => ({ id: f.id, label: f.label, category: f.category, confidence: f.confidence, closed: f.closed, pts: f.pts, source: f.source || 'user', verified: !!f.verified }));
  try {
    const out = await api('PUT', `/api/images/${img.id}/features`, body);
    const byId = Object.fromEntries(out.map(f => [f.id, f]));
    img.features.forEach(f => { const s = byId[f.id]; if (s) { f.from_m = s.from_m; f.to_m = s.to_m; f.closed = s.closed; } });
    if (img === IM) { insp(); holesUI(); }
  } catch (e) { toast('Save failed: ' + e.message); }
}
window.addEventListener('beforeunload', () => { if (svImg) flushSave(); });

/* ---------- main area ---------- */
const pn = (t, ...n) => { const p = el('div', 'pn'); p.append(el('h3', null, t), ...n); return p; };
const btn = (t, f, cls) => { const x = el('button', 'btn s' + (cls ? ' ' + cls : ''), t); x.onclick = f; return x; };
function main() {
  const m = $('main'); m.textContent = ''; lay = null;
  if (!P) { m.append(pn('Workflow', el('div', 'mu', '1 Create a project · 2 Add holes (collar, azimuth, dip, length) or import a collar CSV · 3 Add downhole surveys if you have them · 4 Add core photos with their depth range · 5 Review and edit annotations · 6 Open the 3D model · 7 Export the interval log.'))); return; }
  if (IM) return editor(m);
  if (H) return holePage(m);
  m.append(pn('Workflow', el('div', 'mu', 'Add a hole on the left, or import a collar CSV, to begin.')));
}

/* hole page: collar, survey, strip log, images */
function holePage(m) {
  const h = H, wrap = el('div', 'split'), left = el('div'), right = el('div');
  const f = {}, fld = (k, l, v) => { const d = el('div'); const i = el('input'); i.value = v; f[k] = i; d.append(el('label', null, l), i); return d; };
  const g1 = el('div', 'g3'), g2 = el('div', 'g3');
  g1.append(fld('x', 'Easting', h.x), fld('y', 'Northing', h.y), fld('z', 'RL (m)', h.z));
  g2.append(fld('azimuth', 'Azimuth °', h.azimuth), fld('dip', 'Dip ° down', h.dip), fld('length', 'Length m', h.length));
  const nm = el('input'); nm.value = h.name;
  const row = el('div', 'tb'); row.style.marginTop = '10px';
  row.append(btn('Save collar', guard(async () => {
    const body = { name: nm.value.trim() || h.name }; for (const k in f) body[k] = numOr(f[k].value, h[k]);
    Object.assign(h, await api('PATCH', '/api/holes/' + h.id, body)); toast('Hole saved'); all();
  })), btn('Delete hole', guard(async () => {
    if (!confirm(`Delete hole ${h.name} and its ${h.images.length} image(s)?`)) return;
    await api('DELETE', '/api/holes/' + h.id); P.holes.splice(P.holes.indexOf(h), 1); H = P.holes[0] || null; IM = null; all();
  }), 'danger'));
  left.append(pn('Hole ' + h.name, el('label', null, 'Name'), nm, g1, g2, row));

  const ta = el('textarea'); ta.rows = 7; ta.placeholder = 'depth, azimuth, dip\n0, 90, 60\n50, 92, 58\n100, 95, 55';
  ta.value = h.surveys.map(s => `${s.depth}, ${s.azimuth}, ${s.dip}`).join('\n');
  const sv = btn('Save survey', guard(async () => {
    const rows = ta.value.split(/\n/).map(l => l.trim()).filter(l => l && !/^[a-z]/i.test(l)).map(l => l.split(/[\s,;\t]+/).map(Number));
    if (rows.some(r => r.length < 3 || r.slice(0, 3).some(v => !Number.isFinite(v)))) { toast('Each line needs depth, azimuth, dip as numbers.'); return; }
    h.surveys = await api('PUT', `/api/holes/${h.id}/surveys`, rows.map(r => ({ depth: r[0], azimuth: r[1], dip: r[2] })));
    toast(`Survey saved (${h.surveys.length} stations)`); all();
  }));
  left.append(pn('Downhole survey', ta, el('div', 'mu tiny', 'One station per line. Leave empty for a straight hole from the collar azimuth/dip. Paths use minimum-curvature desurvey.'), Object.assign(el('div', 'tb'), { style: 'margin-top:8px' })));
  left.lastChild.lastChild.append(sv);

  const imgs = el('div');
  if (!h.images.length) imgs.append(el('div', 'mu tiny', 'No core photos yet. Use "Add core image" on the left.'));
  h.images.forEach(im => {
    const r = el('div', 'il'); r.style.cursor = 'pointer';
    r.append(el('b', null, `${im.from_m ?? '?'}–${im.to_m ?? '?'} m`), el('span', 'mu', im.name), el('span', 'badge', im.status), el('u', null, `${im.features.length} features`));
    r.onclick = () => { IM = im; sel = null; all(); }; imgs.append(r);
  });
  left.append(pn('Core images', imgs));
  right.append(pn('Downhole log', stripLog(h)));
  wrap.append(left, right); m.append(wrap);
}
function stripLog(h) {
  const NS = 'http://www.w3.org/2000/svg', W = 360, Hh = 620, top = 24, ax = 44, cw = (W - ax - 30) / (CATS.length + 1);
  const L = Math.max(1, h.length), y = d => top + (Math.min(L, Math.max(0, d)) / L) * (Hh - top - 10);
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
  const mk = (t, a) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); svg.append(e); return e; };
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500].find(s => L / s <= 12) || 1000;
  for (let d = 0; d <= L + 1e-6; d += step) {
    mk('line', { x1: ax - 4, x2: W - 10, y1: y(d), y2: y(d), stroke: 'currentColor', 'stroke-opacity': .12 });
    mk('text', { x: ax - 8, y: y(d) + 3, 'text-anchor': 'end', 'font-size': 10, fill: 'currentColor', opacity: .6 }).textContent = d;
  }
  const cols = ['core', ...CATS];
  cols.forEach((c, i) => mk('text', { x: ax + i * cw + cw / 2, y: 14, 'text-anchor': 'middle', 'font-size': 9, fill: 'currentColor', opacity: .7 }).textContent = c === 'mineralization' ? 'mineral.' : c === 'alteration' ? 'alter.' : c === 'lithology' ? 'lith.' : c);
  h.images.forEach(im => {
    if (im.from_m == null || im.to_m == null) return;
    const r = mk('rect', { x: ax + 2, y: y(im.from_m), width: cw - 4, height: Math.max(1, y(im.to_m) - y(im.from_m)), fill: 'currentColor', 'fill-opacity': .18, rx: 2, style: 'cursor:pointer' });
    r.onclick = () => { IM = im; sel = null; all(); };
    r.append(Object.assign(document.createElementNS(NS, 'title'), { textContent: `${im.name} ${im.from_m}–${im.to_m} m` }));
    im.features.forEach(f => {
      if (f.from_m == null) return; const i = CATS.indexOf(f.category) + 1;
      const y0 = y(f.from_m), hgt = Math.max(2, y(f.to_m) - y0);
      const b = mk('rect', { x: ax + i * cw + 2, y: y0, width: cw - 4, height: hgt, fill: COL[f.category], 'fill-opacity': .35 + .6 * f.confidence / 100, rx: 1.5, style: 'cursor:pointer' });
      b.append(Object.assign(document.createElementNS(NS, 'title'), { textContent: `${f.label} · ${f.confidence}% · ${dTxt(f)}${f.verified ? ' · verified' : ''}` }));
      b.onclick = () => { IM = im; sel = f; mode = 'edit'; all(); };
    });
  });
  mk('text', { x: 6, y: Hh / 2, 'font-size': 10, fill: 'currentColor', opacity: .6, transform: `rotate(-90 10 ${Hh / 2})`, 'text-anchor': 'middle' }).textContent = 'depth (m)';
  const d = el('div', 'strip'); d.append(svg); return d;
}

/* image editor */
function editor(m) {
  const left = el('div', 'pn'), tb = el('div', 'tb');
  tb.append(btn('← ' + H.name, () => { IM = null; sel = null; all(); }));
  [['view', 'View', 'V'], ['edit', 'Edit', 'E'], ['draw', 'Draw', 'D']].forEach(([k, l, key]) => {
    const b = btn(l, () => { mode = k; if (k === 'view') sel = null; main(); }, mode === k ? 'on' : ''); b.title = `${l} (${key})`; tb.append(b);
  });
  const dc = el('select'); dc.id = 'dcat'; CATS.forEach(c => { const o = el('option', null, c); o.value = c; dc.append(o); });
  const dl = el('input'); dl.type = 'text'; dl.id = 'dlab'; dl.placeholder = 'label for new';
  const u = btn('↶', undo), r = btn('↷', redo); u.title = 'Undo (Ctrl+Z)'; r.title = 'Redo (Ctrl+Y)';
  tb.append(dc, dl, u, r);
  const tb2 = el('div', 'tb');
  const fi = el('input'), ti = el('input'); fi.className = ti.className = 'num'; fi.placeholder = 'from m'; ti.placeholder = 'to m';
  fi.value = IM.from_m ?? ''; ti.value = IM.to_m ?? '';
  const fm = el('select'); [['lr', 'depth →'], ['rl', 'depth ←'], ['tb', 'depth ↓'], ['bt', 'depth ↑']].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; fm.append(o); }); fm.value = IM.direction || 'lr';
  const meta = guard(async () => {
    const f = fi.value.trim(), t = ti.value.trim(), body = { direction: fm.value };
    if (f === '') body.clear_from = true; else body.from_m = parseFloat(f);
    if (t === '') body.clear_to = true; else body.to_m = parseFloat(t);
    if (body.from_m != null && body.to_m != null && body.to_m <= body.from_m) { toast('"To" must be greater than "From".'); return; }
    const out = await api('PATCH', '/api/images/' + IM.id, body);
    IM.from_m = out.from_m; IM.to_m = out.to_m; IM.direction = out.direction;
    const byId = Object.fromEntries(out.features.map(x => [x.id, x])); IM.features.forEach(x => { if (byId[x.id]) { x.from_m = byId[x.id].from_m; x.to_m = byId[x.id].to_m; } });
    holesUI(); insp();
  });
  fi.onchange = ti.onchange = fm.onchange = meta;
  tb2.append(el('span', 'mu tiny', 'Core run'), fi, el('span', 'mu', '–'), ti, fm,
    btn(IM.analysis ? 'Re-analyze' : 'Analyze', reanalyze),
    btn('Delete image', guard(async () => {
      if (!confirm('Delete this image and its annotations?')) return;
      await api('DELETE', '/api/images/' + IM.id); H.images.splice(H.images.indexOf(IM), 1); IM = null; sel = null; all();
    }), 'danger'));
  left.append(tb, tb2);
  const vw = el('div', 'vw'), img = el('img'); img.src = `/api/images/${IM.id}/file`; img.alt = IM.name; vw.append(img);
  lay = el('div', 'lay'); vw.append(lay);
  if (BUSY(IM.status)) vw.append(el('div', 'busy', IM.status === 'queued' ? 'Queued for analysis…' : 'Claude is logging this core…'));
  left.append(vw);
  if (IM.status === 'error') left.append(el('div', 'err tiny', 'Analysis failed: ' + IM.error));
  left.append(el('div', 'mu tiny', 'Edit: click a shape, drag points or the shape, double-click an edge to add a point, double-click a point to delete it. Draw: sketch freehand around the area. Keys: V/E/D modes, Del delete, Esc deselect, Ctrl+Z / Ctrl+Y undo/redo.'));
  lay.onpointerdown = e => {
    if (mode !== 'draw') return; e.preventDefault(); const pts = [xy(e)]; tmp = pts;
    const mv = ev => { const q = xy(ev), l = pts[pts.length - 1]; if (Math.hypot(q[0] - l[0], q[1] - l[1]) > 7) { pts.push(q); ov(); } },
      up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); tmp = null; finish(pts); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  };
  const side = el('div'); side.id = 'insp';
  const split = el('div', 'split'); split.append(left, side); m.append(split);
  ov(); insp();
}
const xy = e => { const r = lay.getBoundingClientRect(); return [Math.min(1000, Math.max(0, (e.clientX - r.left) / r.width * 1000)), Math.min(1000, Math.max(0, (e.clientY - r.top) / r.height * 1000))]; };
function finish(pts) {
  if (pts.length < 4) { ov(); return; }
  const k = Math.ceil(pts.length / 28), r = pts.filter((_, i) => i % k === 0), cat = $('dcat').value;
  snap();
  const a = { id: uid(), label: $('dlab').value || cat, category: cat, confidence: 100, closed: !OPEN(cat), pts: r, source: 'user', verified: true, from_m: null, to_m: null };
  IM.features.push(a); sel = a; mode = 'edit'; save(); main();
}
function drag(e, fn) {
  e.preventDefault(); snap(); let moved = false;
  const mv = ev => { moved = true; fn(xy(ev)); ov(); },
    up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); if (moved) save(); else hist().u.pop(); insp(); };
  addEventListener('pointermove', mv); addEventListener('pointerup', up);
}
function ov() {
  if (!lay) return; lay.textContent = '';
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 1000 1000'); svg.setAttribute('preserveAspectRatio', 'none'); svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
  const mk = (d, c, fill, fo, w, dash) => {
    const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); p.setAttribute('fill', fill ? c : 'none'); p.setAttribute('fill-opacity', fo);
    p.setAttribute('stroke', c); p.setAttribute('stroke-width', w); p.setAttribute('vector-effect', 'non-scaling-stroke'); p.setAttribute('stroke-linejoin', 'round');
    if (dash) p.setAttribute('stroke-dasharray', dash); return p;
  };
  IM.features.forEach(a => {
    const c = COL[a.category], p = mk(pathD(a.pts, a.closed), c, a.closed, a === sel ? .42 : .2, a === sel ? 3.5 : 2, a.confidence >= 70 ? '' : a.confidence >= 40 ? '7 4' : '2 4');
    p.style.cssText = 'cursor:pointer;pointer-events:' + (mode === 'draw' ? 'none' : a.closed ? 'all' : 'stroke');
    p.onpointerdown = e => {
      if (mode === 'draw') return; e.stopPropagation(); sel = a;
      if (mode === 'edit') { const s = xy(e), o = a.pts.map(q => q.slice()); ov(); insp(); drag(e, q => { a.pts = o.map(r => [Math.min(1000, Math.max(0, r[0] + q[0] - s[0])), Math.min(1000, Math.max(0, r[1] + q[1] - s[1]))]); }); }
      else { ov(); insp(); }
    };
    p.ondblclick = e => {
      if (mode !== 'edit') return; const q = xy(e), n = a.pts.length; let bi = 0, bd = 1e9;
      for (let i = 0; i < (a.closed ? n : n - 1); i++) { const A = a.pts[i], B = a.pts[(i + 1) % n], d = ((A[0] + B[0]) / 2 - q[0]) ** 2 + ((A[1] + B[1]) / 2 - q[1]) ** 2; if (d < bd) { bd = d; bi = i; } }
      snap(); a.pts.splice(bi + 1, 0, q); ov(); save();
    };
    svg.append(p);
  });
  if (tmp && tmp.length > 1) svg.append(mk('M' + tmp.map(p => p.join(' ')).join('L'), '#ffd23f', false, 0, 2.5));
  lay.append(svg);
  IM.features.forEach(a => { const c = cen(a.pts), t = el('div', 'tag', `${a.label} ${a.confidence}%${a.verified ? ' ✓' : ''}`); t.style.cssText = `left:${c[0] / 10}%;top:${c[1] / 10}%;background:${COL[a.category]}`; lay.append(t); });
  if (mode === 'edit' && sel && IM.features.includes(sel)) sel.pts.forEach((p, i) => {
    const h = el('div', 'hd'); h.style.cssText = `left:${p[0] / 10}%;top:${p[1] / 10}%`;
    h.onpointerdown = e => { e.stopPropagation(); drag(e, q => { sel.pts[i] = q; }); };
    h.ondblclick = e => { e.stopPropagation(); if (sel.pts.length > (sel.closed ? 3 : 2)) { snap(); sel.pts.splice(i, 1); ov(); save(); } };
    lay.append(h);
  });
}
function insp() {
  const b = $('insp'); if (!b || !IM) return; b.textContent = '';
  const r = IM.analysis || {}, k = r.kpi;
  if (sel && IM.features.includes(sel)) {
    const a = sel, c = el('div', 'pn'); c.append(el('h3', null, 'Edit annotation'));
    const l = el('input'); l.value = a.label; l.onfocus = () => snap(); l.oninput = () => { a.label = l.value; ov(); save(); };
    const cs = el('select'); CATS.forEach(x => { const o = el('option', null, x); o.value = x; cs.append(o); }); cs.value = a.category;
    cs.onchange = () => { snap(); a.category = cs.value; a.closed = !OPEN(a.category) && a.pts.length >= 3; ov(); save(); insp(); };
    const rg = el('input'); rg.type = 'range'; rg.min = 0; rg.max = 100; rg.value = a.confidence; const rv = el('span', 'mu', a.confidence + '%');
    rg.onpointerdown = () => snap(); rg.oninput = () => { a.confidence = +rg.value; rv.textContent = a.confidence + '%'; ov(); save(); };
    const vf = el('input'); vf.type = 'checkbox'; vf.checked = !!a.verified; vf.onchange = () => { snap(); a.verified = vf.checked; ov(); save(); };
    const vl = el('label', 'ck'); vl.style.marginTop = '8px'; vl.append(vf, 'Verified by geologist (kept on re-analyze)');
    const sc = f => { snap(); const q = cen(a.pts); a.pts = a.pts.map(p => [Math.min(1000, Math.max(0, q[0] + (p[0] - q[0]) * f)), Math.min(1000, Math.max(0, q[1] + (p[1] - q[1]) * f))]); ov(); save(); };
    c.append(el('label', null, 'Label'), l, el('label', null, 'Category'), cs, el('label', null, 'Confidence'), rg, rv, vl,
      el('div', 'mu tiny', `Depth ${dTxt(a) || '(set the core run from/to)'} · source ${a.source || 'user'}`));
    const row = el('div', 'tb'); row.style.marginTop = '8px';
    row.append(btn('Grow', () => sc(1.12)), btn('Shrink', () => sc(.89)),
      btn('Delete', () => { snap(); IM.features.splice(IM.features.indexOf(a), 1); sel = null; save(); ov(); insp(); }, 'danger'),
      btn('Done', () => { sel = null; ov(); insp(); }));
    c.append(row); b.append(c); return;
  }
  const s = el('div', 'pn'); s.append(el('h3', null, 'Summary'), el('div', null, r.headline || (BUSY(IM.status) ? 'Analyzing…' : 'Not analyzed yet')));
  if (k) [['Sulphides', k.sulphide_pct + '%'], ['Veins', k.vein_pct + '%'], ['Alteration', k.alteration_score + '/5'], ['Prospectivity', k.prospectivity]].forEach(([a, v]) => s.append(el('span', 'ch', a + ' ' + v)));
  const mins = r.minerals || [];
  if (mins.length) {
    const t = el('table'); t.append(Object.assign(el('tr'), { innerHTML: '<th>Mineral</th><th>%</th><th>conf</th><th></th>' }));
    mins.forEach((x, i) => {
      const tr = el('tr'); tr.append(el('td', null, x.name + (x.style ? ' · ' + x.style : '')), el('td', null, (+x.pct || 0) + '%'), el('td', null, (+x.conf || 0) + '%'));
      const d = el('td'), rb = el('div', 'rb'), bi = el('i'); bi.style.width = Math.min(100, +x.pct || 0) + '%'; bi.style.background = Object.values(COL)[i % 5]; rb.append(bi); d.append(rb); tr.append(d); t.append(tr);
    });
    s.append(t);
  }
  if ((r.lithology || []).length) { const d = el('div'); d.style.marginTop = '6px'; r.lithology.forEach(x => d.append(el('span', 'ch', `${x.unit} ${x.pct}%`))); s.append(d); }
  if (IM.model) s.append(el('div', 'mu tiny', 'Model: ' + IM.model + ' · indicative visual estimate, verify against assay'));
  b.append(s);
  const l = el('div', 'pn'); l.append(el('h3', null, 'Annotations (' + IM.features.length + ')'));
  IM.features.slice().sort((x, y) => (x.from_m ?? 1e9) - (y.from_m ?? 1e9)).forEach(a => {
    const row = el('div', 'il'), d = el('i'); d.style.cssText = 'width:9px;height:9px;border-radius:50%;flex:none;background:' + COL[a.category];
    row.append(d, el('span', null, a.label), el('span', 'mu', a.confidence + '%'), el('span', 'badge', a.verified ? '✓ verified' : a.source || 'user'), el('u', null, dTxt(a)));
    row.style.cursor = 'pointer'; row.onclick = () => { sel = a; mode = 'edit'; main(); }; l.append(row);
  });
  b.append(l);
}
document.addEventListener('keydown', e => {
  if (view !== 1 || !IM) return;
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if ((e.ctrlKey || e.metaKey) && !typing && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && !typing && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'v' || k === 'e' || k === 'd') { mode = { v: 'view', e: 'edit', d: 'draw' }[k]; if (mode === 'view') sel = null; main(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); snap(); IM.features.splice(IM.features.indexOf(sel), 1); sel = null; save(); main(); }
  else if (e.key === 'Escape' && sel) { sel = null; ov(); insp(); }
});

/* ---------- 3D model, drilling simulation, cross-hole correlation ---------- */
async function build3d() {
  const box = $('cv'), tip = $('tip');
  if (T) { T.stop(); T = null; }
  [...box.children].forEach(c => c !== tip && c.remove());
  const msg = t => { const m = el('div', 'mu', t); m.style.padding = '16px'; box.append(m); };
  if (!P) return msg('Create a project first.');
  let M; try { M = await api('GET', `/api/projects/${P.id}/model`); } catch (e) { return msg('Could not load model: ' + e.message); }
  if (view !== 2) return;
  [...box.children].forEach(c => c !== tip && c.remove());
  const hs = M.holes;
  if (!hs.length) return msg('Add a hole (collar E/N/RL, azimuth, dip, length) to see it here.');
  if (typeof THREE === 'undefined') return msg('three.js did not load (offline?).');
  let R; try { R = new THREE.WebGLRenderer({ antialias: true }); } catch (e) { return msg('WebGL is unavailable in this browser.'); }
  box.prepend(R.domElement); R.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  const sc = new THREE.Scene(), cam = new THREE.PerspectiveCamera(50, 1, .1, 1e7), V = (x, y, z) => new THREE.Vector3(x, y, z);
  const W = p => V(p.x, p.z, -p.y); // east → x, RL → y (up), north → -z
  hs.forEach(h => { h.P = h.path.map(W); h.D = h.path.map(p => p.depth); });
  const posAt = (h, d) => {
    const D = h.D; d = Math.max(0, Math.min(h.length, d)); let lo = 0, hi = D.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (D[m] <= d) lo = m; else hi = m; }
    const t = D[hi] === D[lo] ? 0 : (d - D[lo]) / (D[hi] - D[lo]); return h.P[lo].clone().lerp(h.P[hi], t);
  };
  const pts = hs.flatMap(h => h.P), bb = new THREE.Box3().setFromPoints(pts), ctr0 = bb.getCenter(V(0, 0, 0)), sz = bb.getSize(V(0, 0, 0));
  const span = Math.max(sz.x, sz.y, sz.z, 30), r0 = span / 450, ctr = ctr0.clone();
  sc.add(new THREE.AmbientLight(0xffffff, .65)); const dl = new THREE.DirectionalLight(0xffffff, .8); dl.position.set(1, 2, 1); sc.add(dl);
  const grid = new THREE.GridHelper(span * 1.8, 18, 0x8a93a5, 0x3a4150); grid.position.set(ctr.x, bb.max.y, ctr.z); sc.add(grid);
  const bg = new THREE.BoxGeometry(sz.x + span * .4, sz.y + span * .15, sz.z + span * .4);
  const blk = new THREE.Mesh(bg, new THREE.MeshBasicMaterial({ color: 0x8a6d3b, transparent: true, opacity: .07, depthWrite: false })); blk.position.copy(ctr); sc.add(blk);
  const ed = new THREE.LineSegments(new THREE.EdgesGeometry(bg), new THREE.LineBasicMaterial({ color: 0x8a6d3b, transparent: true, opacity: .5 })); ed.position.copy(ctr); sc.add(ed);
  const label = (t, p) => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64; const g = c.getContext('2d'); g.font = '600 30px system-ui'; g.fillStyle = '#fff'; g.fillText(t, 6, 42);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false })); s.scale.set(span * .18, span * .045, 1); s.position.copy(p).add(V(0, span * .04, 0)); sc.add(s);
  };
  const RAD = 8;
  const tube = (h, d0, d1, r, mat) => {
    const n = Math.max(2, Math.min(120, Math.ceil((d1 - d0) / Math.max(.05, h.length / 240)) + 1)), ps = [];
    for (let i = 0; i < n; i++) ps.push(posAt(h, d0 + (d1 - d0) * i / (n - 1)));
    const segs = Math.max(2, (n - 1) * 2), g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ps, false, 'centripetal'), segs, r, RAD, false);
    const m = new THREE.Mesh(g, mat); sc.add(m); return { m, segs };
  };
  const reveal = (t, frac) => t.m.geometry.setDrawRange(0, Math.floor(Math.max(0, Math.min(1, frac)) * t.segs) * RAD * 6);
  const HO = [], SG = [], QD = [], hit = [];
  hs.forEach(h => {
    const ghost = tube(h, 0, h.length, r0 * .9, new THREE.MeshBasicMaterial({ color: 0xbfc5d0, transparent: true, opacity: .12, depthWrite: false }));
    const base = tube(h, 0, h.length, r0, new THREE.MeshLambertMaterial({ color: 0xbfc5d0 }));
    const bit = new THREE.Mesh(new THREE.ConeGeometry(r0 * 3, r0 * 8, 12), new THREE.MeshLambertMaterial({ color: 0xffd23f })); sc.add(bit);
    const ft = new THREE.Mesh(new THREE.BoxGeometry(r0 * 10, r0 * 14, r0 * 10), new THREE.MeshLambertMaterial({ color: 0xff8a3d })); ft.position.copy(posAt(h, 0)); sc.add(ft);
    label(h.name + (h.surveyed ? '' : ' *'), posAt(h, 0));
    HO.push({ h, base, bit, ghost });
    h.intervals.forEach(a => {
      const d0 = Math.max(0, Math.min(h.length, a.from_m)), d1 = Math.min(h.length, Math.max(a.to_m, d0 + Math.max(.15, h.length / 250)));
      if (d1 <= d0) return;
      const lith = a.category === 'lithology';
      const t = tube(h, d0, d1, r0 * (lith ? 1.4 : 1.9), new THREE.MeshLambertMaterial({ color: parseInt(COL[a.category].slice(1), 16), transparent: true, opacity: lith ? .45 : .95 }));
      t.m.userData = { t: `${a.label} · ${a.category} · ${a.confidence}%${a.verified ? ' · verified' : ''}<br>${h.name} ${a.from_m.toFixed(1)}–${a.to_m.toFixed(1)} m` };
      const s = { t, h, d0, d1, a, lith }; SG.push(s); hit.push(t.m);
    });
  });
  /* correlation: join same-label mineralization/vein intervals between each hole and its nearest neighbour */
  const seen = {};
  hs.forEach((h, i) => {
    let bj = -1, bd = 1e18;
    hs.forEach((g, j) => { if (j === i) return; const d = posAt(h, 0).distanceToSquared(posAt(g, 0)); if (d < bd) { bd = d; bj = j; } });
    if (bj < 0) return; const key = [i, bj].sort().join('-'); if (seen[key]) return; seen[key] = 1; const g = hs[bj];
    const best = hh => { const m = {}; SG.filter(s => s.h === hh && (s.a.category === 'mineralization' || s.a.category === 'vein')).forEach(s => { const k = s.a.label.toLowerCase().trim(); if (!m[k] || s.a.confidence > m[k].a.confidence) m[k] = s; }); return m; };
    const A = best(h), B = best(g);
    Object.keys(A).forEach(k => {
      if (!B[k]) return; const a = A[k], b = B[k], gm = new THREE.BufferGeometry(), v = [posAt(a.h, a.d0), posAt(a.h, a.d1), posAt(b.h, b.d1), posAt(b.h, b.d0)];
      gm.setFromPoints([v[0], v[1], v[2], v[0], v[2], v[3]]); gm.computeVertexNormals();
      const q = new THREE.Mesh(gm, new THREE.MeshBasicMaterial({ color: parseInt(COL[a.a.category].slice(1), 16), transparent: true, opacity: .32, side: THREE.DoubleSide, depthWrite: false }));
      sc.add(q); QD.push({ m: q, at: Math.max(a.d0, b.d0) });
    });
  });
  const maxL = Math.max(...hs.map(h => h.length)); let cur = maxL, play = false, showQ = $('cq').checked, showS = $('cs').checked, showL = $('cl').checked;
  const sl = $('dsl'); sl.max = maxL; sl.value = maxL;
  const upd = () => {
    HO.forEach(o => {
      const L = Math.max(.001, Math.min(cur, o.h.length)); reveal(o.base, L / o.h.length);
      const p = posAt(o.h, L), q = posAt(o.h, Math.min(o.h.length, L + .5)), dir = q.clone().sub(p);
      if (dir.lengthSq() < 1e-12) dir.copy(p.clone().sub(posAt(o.h, Math.max(0, L - .5))));
      o.bit.quaternion.setFromUnitVectors(V(0, -1, 0), dir.normalize()); o.bit.position.copy(p);
    });
    SG.forEach(s => { const v = (s.lith ? showL : showS) && cur > s.d0; s.t.m.visible = v; if (v) reveal(s.t, (Math.min(cur, s.d1) - s.d0) / (s.d1 - s.d0)); });
    QD.forEach(q => q.m.visible = showQ && cur >= q.at);
    $('dro').textContent = 'bit depth ' + cur.toFixed(1) + ' m';
  };
  let th = .8, ph = 1.05, rad = span * 1.7;
  const camU = () => { cam.position.set(ctr.x + rad * Math.sin(ph) * Math.cos(th), ctr.y + rad * Math.cos(ph), ctr.z + rad * Math.sin(ph) * Math.sin(th)); cam.lookAt(ctr); };
  const cv = R.domElement; let dr = null, pan = false;
  cv.oncontextmenu = e => e.preventDefault();
  cv.onpointerdown = e => { dr = [e.clientX, e.clientY]; pan = e.button === 2 || e.shiftKey; cv.setPointerCapture(e.pointerId); };
  cv.onpointerup = () => dr = null;
  cv.onpointermove = e => {
    if (dr) {
      const dx = e.clientX - dr[0], dy = e.clientY - dr[1]; dr = [e.clientX, e.clientY]; tip.style.display = 'none';
      if (pan) {
        const k = rad / cv.clientHeight * .9, right = V(0, 0, 0).setFromMatrixColumn(cam.matrixWorld, 0), up = V(0, 0, 0).setFromMatrixColumn(cam.matrixWorld, 1);
        ctr.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
      } else { th -= dx * .008; ph = Math.min(3, Math.max(.05, ph - dy * .008)); }
      return;
    }
    const r = cv.getBoundingClientRect(), rc = new THREE.Raycaster();
    rc.setFromCamera({ x: (e.clientX - r.left) / r.width * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 }, cam);
    const hI = rc.intersectObjects(hit.filter(m => m.visible))[0];
    if (hI) { tip.innerHTML = hI.object.userData.t; tip.style.display = 'block'; tip.style.left = (e.clientX - r.left + 12) + 'px'; tip.style.top = (e.clientY - r.top + 12) + 'px'; }
    else tip.style.display = 'none';
  };
  cv.onwheel = e => { e.preventDefault(); rad = Math.max(span * .05, Math.min(span * 8, rad * (1 + Math.sign(e.deltaY) * .1))); };
  const rs = () => { const w = box.clientWidth, h = box.clientHeight; R.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); };
  const ro = new ResizeObserver(rs); ro.observe(box); rs();
  let raf, last = performance.now();
  const loop = t => {
    raf = requestAnimationFrame(loop); const dt = (t - last) / 1000; last = t;
    if (play) { cur += dt * maxL / 25 * (+$('spd').value); if (cur >= maxL) { cur = maxL; play = false; $('pl').textContent = '▶ Drill'; } sl.value = cur; }
    upd(); camU(); R.render(sc, cam);
  };
  raf = requestAnimationFrame(loop);
  $('pl').onclick = () => { if (!play && cur >= maxL) cur = 0; play = !play; $('pl').textContent = play ? '❚❚ Pause' : '▶ Drill'; };
  sl.oninput = () => { cur = +sl.value; play = false; $('pl').textContent = '▶ Drill'; };
  $('cq').onchange = () => showQ = $('cq').checked; $('cs').onchange = () => showS = $('cs').checked; $('cl').onchange = () => showL = $('cl').checked;
  $('rv').onclick = () => { th = .8; ph = 1.05; rad = span * 1.7; ctr.copy(ctr0); };
  T = {
    stop() {
      cancelAnimationFrame(raf); ro.disconnect();
      sc.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
      R.dispose(); cv.remove();
    }
  };
  upd();
}
$('rf').onclick = guard(async () => { if (P) { await openProject(P.id, true); } });

/* ---------- shell ---------- */
function all() { pjSel(); holesUI(); main(); if (view === 2) build3d(); }
const tab = n => {
  view = n; $('v1').hidden = n !== 1; $('v2').hidden = n !== 2; $('t1').classList.toggle('on', n === 1); $('t2').classList.toggle('on', n === 2);
  if (n === 2) { flushSave().then(build3d); } else if (T) { T.stop(); T = null; }
};
$('t1').onclick = () => tab(1); $('t2').onclick = () => tab(2);

(async () => {
  try { HEALTH = await api('GET', '/api/health'); } catch (e) { HEALTH = {}; }
  (HEALTH.deposit_styles || []).forEach(d => $('pdep').append(el('option', null, d)));
  if (!HEALTH.ai_configured) {
    const b = $('banner'); b.hidden = false;
    b.textContent = 'AI logging is off: no ANTHROPIC_API_KEY on the server. Add it to .env and restart. You can still upload photos and annotate by hand.';
    $('aai').checked = false; $('aai').disabled = true;
  }
  try {
    await loadProjects();
    let last = null; try { last = localStorage.getItem('cv.project'); } catch (e) { }
    const p = PROJS.find(p => p.id === last) || PROJS[0];
    await openProject(p && p.id);
  } catch (e) { toast('Cannot reach the server: ' + e.message); all(); }
})();
