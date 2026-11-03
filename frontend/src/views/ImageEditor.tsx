import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Drill, Eye, Maximize2, Minus, MousePointer2, PenLine, Plus, Redo2, RectangleHorizontal, Scissors, Sparkles, Trash2, Undo2 } from 'lucide-react';
import { findImage, useCanEdit, useStore } from '../store';
import { api, type Category, type CoreBreak, type CoreImage, type Direction, type Feature, type Pt } from '../api';
import { BUSY, CATEGORIES, COLORS, centroid, clamp, depthText, fmt, isOpen, runText, smoothPath, uid } from '../lib/geo';
import { rqdColor } from './Geotech';
import { CommitInput, Field } from '../components/ui';

type Mode = 'view' | 'edit' | 'draw' | 'rows' | 'breaks';

export const imageBoxes = (im: CoreImage): number[][] => im.core_boxes ?? im.analysis?.core_boxes ?? [];

export default function ImageEditor({ holeId, imageId }: { holeId: string; imageId: string }) {
  const { project, navigate, setFeatures, snapshot, dropSnapshot, undo, redo, history, analyze, patchImage, deleteImage, setBreaks, loadGeotech } = useStore();
  const hole = project?.holes.find(h => h.id === holeId);
  const im = findImage(project, imageId);
  const canEdit = useCanEdit();
  const [mode, setModeRaw] = useState<Mode>(canEdit ? 'edit' : 'view');
  const setMode = (m: Mode) => setModeRaw(canEdit ? m : 'view'); // viewers stay in View mode
  const [selId, setSelId] = useState<string | null>(null);
  const [drawCat, setDrawCat] = useState<Category>('mineralization');
  const [drawLabel, setDrawLabel] = useState('');
  const [tmp, setTmp] = useState<Pt[] | null>(null);
  const [tmpBox, setTmpBox] = useState<number[] | null>(null);
  const [natural, setNatural] = useState(true);
  const lay = useRef<HTMLDivElement>(null);

  useEffect(() => { setSelId(null); setTmp(null); setTmpBox(null); loadGeotech(imageId); }, [imageId, loadGeotech]);
  const features = im?.features ?? [];
  const sel = features.find(f => f.id === selId) ?? null;
  const update = useCallback((fn: (f: Feature[]) => Feature[], snap = false) => setFeatures(imageId, fn, snap), [setFeatures, imageId]);
  const updSel = (patch: Partial<Feature>, snap = true) => sel && update(fs => fs.map(f => (f.id === sel.id ? { ...f, ...patch } : f)), snap);
  const removeSel = () => { if (!sel) return; update(fs => fs.filter(f => f.id !== sel.id), true); setSelId(null); };

  // keyboard shortcuts
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test((document.activeElement as HTMLElement)?.tagName);
      const key = e.key.toLowerCase();
      if (!canEdit) return;
      if ((e.ctrlKey || e.metaKey) && !typing && key === 'z') { e.preventDefault(); if (e.shiftKey) redo(imageId); else undo(imageId); setSelId(null); return; }
      if ((e.ctrlKey || e.metaKey) && !typing && key === 'y') { e.preventDefault(); redo(imageId); setSelId(null); return; }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (key === 'v') { setMode('view'); setSelId(null); }
      else if (key === 'e') setMode('edit');
      else if (key === 'd') setMode('draw');
      else if (key === 'r') { setMode('rows'); setSelId(null); }
      else if (key === 'b') { setMode('breaks'); setSelId(null); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selId) { e.preventDefault(); update(fs => fs.filter(f => f.id !== selId), true); setSelId(null); }
      else if (e.key === 'Escape') setSelId(null);
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [imageId, selId, undo, redo, update]);

  if (!hole || !im) return <div className="page mu">Image not found.</div>;

  const xy = (e: { clientX: number; clientY: number }): Pt => {
    const r = lay.current!.getBoundingClientRect();
    return [clamp(((e.clientX - r.left) / r.width) * 1000), clamp(((e.clientY - r.top) / r.height) * 1000)];
  };
  const drag = (onMove: (p: Pt) => void) => {
    snapshot(imageId);
    let moved = false;
    const mv = (ev: PointerEvent) => { moved = true; onMove(xy(ev)); };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); if (!moved) dropSnapshot(imageId); };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
  };

  const boxes = imageBoxes(im);
  const geoMode = mode === 'rows' || mode === 'breaks';
  const saveBoxes = (b: number[][]) => patchImage(im.id, b.length ? { core_boxes: b } : { clear_boxes: true });

  const startDraw = (e: React.PointerEvent) => {
    if (mode === 'rows') {
      e.preventDefault();
      const a = xy(e);
      let b = [a[0], a[1], a[0], a[1]];
      setTmpBox(b);
      const mv = (ev: PointerEvent) => { const q = xy(ev); b = [Math.min(a[0], q[0]), Math.min(a[1], q[1]), Math.max(a[0], q[0]), Math.max(a[1], q[1])]; setTmpBox(b); };
      const up = () => {
        removeEventListener('pointermove', mv); removeEventListener('pointerup', up); setTmpBox(null);
        if (b[2] - b[0] > 15 && b[3] - b[1] > 8) saveBoxes([...boxes, b.map(v => Math.round(v))]);
      };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
      return;
    }
    if (mode === 'breaks') {
      e.preventDefault();
      const q = xy(e);
      const br: CoreBreak = { id: uid(), x: q[0], y: q[1], natural, source: 'user', depth_m: null };
      setBreaks(imageId, bs => [...bs, br]);
      return;
    }
    if (mode !== 'draw') { if (e.target === e.currentTarget) setSelId(null); return; }
    e.preventDefault();
    const pts: Pt[] = [xy(e)];
    setTmp([...pts]);
    const mv = (ev: PointerEvent) => { const q = xy(ev), l = pts[pts.length - 1]; if (Math.hypot(q[0] - l[0], q[1] - l[1]) > 7) { pts.push(q); setTmp([...pts]); } };
    const up = () => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up); setTmp(null);
      if (pts.length < 4) return;
      const k = Math.ceil(pts.length / 28), r = pts.filter((_, i) => i % k === 0);
      const f: Feature = { id: uid(), label: drawLabel.trim() || drawCat, category: drawCat, confidence: 100, closed: !isOpen(drawCat), pts: r, source: 'user', verified: true, from_m: null, to_m: null };
      update(fs => [...fs, f], true); setSelId(f.id); setMode('edit');
    };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
  };

  const onShapeDown = (f: Feature) => (e: React.PointerEvent) => {
    if (mode === 'draw') return;
    e.stopPropagation(); setSelId(f.id);
    if (mode !== 'edit') return;
    const s = xy(e), o = f.pts.map(p => [...p] as Pt);
    drag(q => update(fs => fs.map(x => (x.id === f.id ? { ...x, pts: o.map(p => [clamp(p[0] + q[0] - s[0]), clamp(p[1] + q[1] - s[1])] as Pt) } : x))));
  };
  const onShapeDbl = (f: Feature) => (e: React.MouseEvent) => {
    if (mode !== 'edit') return;
    const q = xy(e), n = f.pts.length;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < (f.closed ? n : n - 1); i++) {
      const A = f.pts[i], B = f.pts[(i + 1) % n], d = ((A[0] + B[0]) / 2 - q[0]) ** 2 + ((A[1] + B[1]) / 2 - q[1]) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    update(fs => fs.map(x => (x.id === f.id ? { ...x, pts: [...x.pts.slice(0, bi + 1), q, ...x.pts.slice(bi + 1)] } : x)), true);
  };
  const onHandleDown = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation(); e.preventDefault();
    if (!sel) return;
    const id = sel.id;
    drag(q => update(fs => fs.map(x => (x.id === id ? { ...x, pts: x.pts.map((p, j) => (j === i ? q : p)) } : x))));
  };
  const onHandleDbl = (i: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (sel && sel.pts.length > (sel.closed ? 3 : 2)) updSel({ pts: sel.pts.filter((_, j) => j !== i) });
  };
  const scale = (k: number) => {
    if (!sel) return;
    const c = centroid(sel.pts);
    updSel({ pts: sel.pts.map(p => [clamp(c[0] + (p[0] - c[0]) * k), clamp(c[1] + (p[1] - c[1]) * k)] as Pt) });
  };

  const idx = hole.images.findIndex(i => i.id === im.id);
  const prev = hole.images[idx - 1], next = hole.images[idx + 1];
  const h = history[imageId];
  const dash = (c: number) => (c >= 70 ? undefined : c >= 40 ? '7 4' : '2 4');

  return (
    <div className="editor">
      <div className="stage-wrap">
        <div className="stage-top">
          <div className="grow" style={{ minWidth: 180 }}>
            <div className="crumbs">
              <button onClick={() => navigate({ view: 'overview' })}>{project!.name}</button>/
              <button onClick={() => navigate({ view: 'hole', holeId })}>{hole.name}</button>/<span className="ellipsis">{im.name}</span>
            </div>
            <div className="row"><b className="num">{runText(im)}</b><StatusBadge im={im} /></div>
          </div>
          <fieldset className="plain" disabled={!canEdit}><RunMeta im={im} onSave={b => patchImage(im.id, b)} /></fieldset>
          <div className="row">
            <button className="btn sm icon" disabled={!prev} onClick={() => prev && navigate({ view: 'image', holeId, imageId: prev.id })} aria-label="Previous photo" title="Previous photo"><ChevronLeft size={15} /></button>
            <button className="btn sm icon" disabled={!next} onClick={() => next && navigate({ view: 'image', holeId, imageId: next.id })} aria-label="Next photo" title="Next photo"><ChevronRight size={15} /></button>
            {canEdit && <button className="btn sm primary" disabled={BUSY(im.status)} onClick={() => analyze(im.id)}><Sparkles size={13} />{im.analysis ? 'Re-analyze' : 'Analyze'}</button>}
            {canEdit && <button className="btn sm ghost danger icon" onClick={() => confirm('Delete this photo and its annotations?') && deleteImage(im.id)} aria-label="Delete photo" title="Delete photo"><Trash2 size={14} /></button>}
          </div>
        </div>

        <div className="stage">
          <div className={'canvas' + (mode === 'draw' ? ' draw' : '')}>
            <img src={api.imageUrl(im.id)} alt={im.name} draggable={false} style={{ maxHeight: 'calc(100vh - 220px)' }} />
            <div className="lay" ref={lay} onPointerDown={startDraw}>
              <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                {features.map(f => (
                  <path key={f.id} d={smoothPath(f.pts, f.closed)} fill={f.closed ? COLORS[f.category] : 'none'} fillOpacity={f === sel ? 0.42 : 0.2}
                    stroke={COLORS[f.category]} strokeWidth={f === sel ? 3.5 : 2} strokeDasharray={dash(f.confidence)} strokeLinejoin="round" vectorEffect="non-scaling-stroke"
                    opacity={geoMode ? 0.25 : 1}
                    style={{ cursor: mode === 'edit' ? 'move' : 'pointer', pointerEvents: mode === 'draw' || geoMode ? 'none' : f.closed ? 'all' : 'stroke' }}
                    onPointerDown={onShapeDown(f)} onDoubleClick={onShapeDbl(f)} />
                ))}
                {geoMode && boxes.map((b, i) => (
                  <rect key={'b' + i} x={b[0]} y={b[1]} width={b[2] - b[0]} height={b[3] - b[1]} fill={mode === 'rows' ? '#4c8dff' : 'none'} fillOpacity={0.12}
                    stroke="#4c8dff" strokeWidth={1.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke"
                    style={{ cursor: mode === 'rows' ? 'pointer' : undefined, pointerEvents: mode === 'rows' ? 'all' : 'none' }}
                    onPointerDown={mode === 'rows' ? ev => { ev.stopPropagation(); saveBoxes(boxes.filter((_, k) => k !== i)); } : undefined}>
                    <title>Core row {i + 1}{mode === 'rows' ? ' · click to remove' : ''}</title>
                  </rect>
                ))}
                {tmpBox && <rect x={tmpBox[0]} y={tmpBox[1]} width={tmpBox[2] - tmpBox[0]} height={tmpBox[3] - tmpBox[1]} fill="#4c8dff" fillOpacity={0.15} stroke="#4c8dff" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
                {geoMode && im.breaks.map(b => {
                  const horiz = im.direction === 'lr' || im.direction === 'rl';
                  const row = nearestRow(boxes, b, horiz);
                  const [x1, y1, x2, y2] = horiz ? [b.x, row ? row[1] : b.y - 40, b.x, row ? row[3] : b.y + 40] : [row ? row[0] : b.x - 40, b.y, row ? row[2] : b.x + 40, b.y];
                  return (
                    <g key={b.id} style={{ cursor: mode === 'breaks' ? 'pointer' : undefined, pointerEvents: mode === 'breaks' ? 'all' : 'none' }}
                      onPointerDown={ev => {
                        if (mode !== 'breaks') return;
                        ev.stopPropagation();
                        if (ev.shiftKey) setBreaks(imageId, bs => bs.map(x => (x.id === b.id ? { ...x, natural: !x.natural, source: 'user' } : x)));
                        else setBreaks(imageId, bs => bs.filter(x => x.id !== b.id));
                      }}>
                      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={14} vectorEffect="non-scaling-stroke" />
                      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={b.natural ? '#ff4d6a' : '#c9ced8'} strokeWidth={3} strokeDasharray={b.natural ? undefined : '4 3'} vectorEffect="non-scaling-stroke" />
                      <title>{`${b.natural ? 'Natural fracture' : 'Drilling / handling break'}${b.depth_m != null ? ` · ${b.depth_m.toFixed(2)} m` : ''} · ${b.source}${mode === 'breaks' ? ' · click: remove · shift-click: switch type' : ''}`}</title>
                    </g>
                  );
                })}
                {tmp && tmp.length > 1 && <path d={'M' + tmp.map(p => p.join(' ')).join('L')} fill="none" stroke="#ffd23f" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />}
              </svg>
              {!geoMode && features.map(f => {
                const c = centroid(f.pts);
                return <div key={f.id} className="tag" style={{ left: `${c[0] / 10}%`, top: `${c[1] / 10}%`, background: COLORS[f.category] }}>{f.label} {f.confidence}%{f.verified ? ' ✓' : ''}</div>;
              })}
              {mode === 'edit' && sel && sel.pts.map((p, i) => (
                <div key={i} className="handle" style={{ left: `${p[0] / 10}%`, top: `${p[1] / 10}%` }} onPointerDown={onHandleDown(i)} onDoubleClick={onHandleDbl(i)} />
              ))}
            </div>
            {BUSY(im.status) && <div className="busy-veil"><div className="spinner" />{im.status === 'queued' ? 'Queued for analysis…' : 'Claude is logging this core…'}</div>}
          </div>

          <div className="toolbar" hidden={!canEdit}>
            <div className="seg">
              <button className={mode === 'view' ? 'on' : ''} onClick={() => { setMode('view'); setSelId(null); }} title="View (V)"><Eye size={14} />View</button>
              <button className={mode === 'edit' ? 'on' : ''} onClick={() => setMode('edit')} title="Edit (E)"><MousePointer2 size={14} />Edit</button>
              <button className={mode === 'draw' ? 'on' : ''} onClick={() => setMode('draw')} title="Draw (D)"><PenLine size={14} />Draw</button>
              <button className={mode === 'rows' ? 'on' : ''} onClick={() => { setMode('rows'); setSelId(null); }} title="Core rows (R)"><RectangleHorizontal size={14} />Rows</button>
              <button className={mode === 'breaks' ? 'on' : ''} onClick={() => { setMode('breaks'); setSelId(null); }} title="Breaks (B)"><Scissors size={14} />Breaks</button>
            </div>
            {mode === 'rows' && <>
              <span className="sep" />
              <span className="tiny mu">Drag a box over each core row in tray order · click a row to remove</span>
              {im.core_boxes && <button className="btn ghost sm" onClick={() => patchImage(im.id, { clear_boxes: true })}>Use AI rows</button>}
            </>}
            {mode === 'breaks' && <>
              <span className="sep" />
              <button className={'chip' + (natural ? ' on' : '')} style={natural ? { color: '#ff4d6a' } : undefined} onClick={() => setNatural(true)}><span className="dot" style={{ background: '#ff4d6a' }} /><span style={{ color: 'var(--ink)' }}>natural</span></button>
              <button className={'chip' + (!natural ? ' on' : '')} onClick={() => setNatural(false)}><span className="dot" style={{ background: '#c9ced8' }} /><span style={{ color: 'var(--ink)' }}>drilling / handling</span></button>
              <span className="tiny mu">{boxes.length ? 'Click on the core to mark a break' : 'Draw core rows first'}</span>
            </>}
            {mode === 'draw' && <>
              <span className="sep" />
              {CATEGORIES.map(c => (
                <button key={c} className={'chip' + (drawCat === c ? ' on' : '')} style={drawCat === c ? { color: COLORS[c] } : undefined} onClick={() => setDrawCat(c)}>
                  <span className="dot" style={{ background: COLORS[c] }} /><span style={{ color: 'var(--ink)' }}>{c}</span>
                </button>
              ))}
              <input className="input sm" style={{ width: 130 }} placeholder="label (optional)" value={drawLabel} onChange={e => setDrawLabel(e.target.value)} />
            </>}
            <span className="sep" />
            <button className="btn ghost sm icon" disabled={!h?.u.length} onClick={() => { undo(imageId); setSelId(null); }} title="Undo (Ctrl+Z)" aria-label="Undo"><Undo2 size={15} /></button>
            <button className="btn ghost sm icon" disabled={!h?.r.length} onClick={() => { redo(imageId); setSelId(null); }} title="Redo (Ctrl+Y)" aria-label="Redo"><Redo2 size={15} /></button>
          </div>
        </div>
      </div>

      <aside className="inspector">
        {im.status === 'error' && <div className="banner" style={{ margin: 0 }}><span className="err">Analysis failed: {im.error}</span></div>}
        {sel ? (
          <fieldset className="card plain" disabled={!canEdit}>
            <div className="card-h"><span className="dot" style={{ background: COLORS[sel.category] }} /><h3 className="grow">Annotation</h3>
              <span className="badge">{sel.source}</span>
            </div>
            <div className="col">
              <Field label="Label"><input className="input" value={sel.label} onFocus={() => snapshot(imageId)} onChange={e => updSel({ label: e.target.value }, false)} /></Field>
              <Field label="Category">
                <select className="input" value={sel.category} onChange={e => { const c = e.target.value as Category; updSel({ category: c, closed: !isOpen(c) && sel.pts.length >= 3 }); }}>
                  {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </Field>
              <Field label={`Confidence · ${sel.confidence}%`}>
                <input type="range" min={0} max={100} value={sel.confidence} onPointerDown={() => snapshot(imageId)} onChange={e => updSel({ confidence: +e.target.value }, false)} />
              </Field>
              <label className="check"><input type="checkbox" checked={sel.verified} onChange={e => updSel({ verified: e.target.checked })} />Verified by geologist <span className="mu tiny">(kept on re-analyze)</span></label>
              <div className="mu tiny">Depth {depthText(sel) || '— set the core run from/to'}</div>
              <div className="row wrap">
                <button className="btn sm" onClick={() => scale(1.12)}><Maximize2 size={13} />Grow</button>
                <button className="btn sm" onClick={() => scale(0.89)}><Minus size={13} />Shrink</button>
                <button className="btn sm danger" onClick={removeSel}><Trash2 size={13} />Delete</button>
                <span className="grow" />
                <button className="btn sm" onClick={() => setSelId(null)}>Done</button>
              </div>
            </div>
          </fieldset>
        ) : <>{geoMode ? <GeotechCard im={im} holeSize={hole.core_size || 'NQ'} /> : <Summary im={im} />}</>}

        <div className="card">
          <div className="card-h"><h3 className="grow">Annotations · {features.length}</h3>
            {canEdit && <button className="btn ghost sm" onClick={() => setMode('draw')}><Plus size={13} />Draw</button>}
          </div>
          {!features.length && <div className="mu tiny">None yet. Run the AI, or draw one with <kbd>D</kbd>.</div>}
          {[...features].sort((a, b) => (a.from_m ?? 1e9) - (b.from_m ?? 1e9)).map(f => (
            <div key={f.id} className={'feat' + (f.id === selId ? ' on' : '')} onClick={() => { setSelId(f.id); setMode('edit'); }}>
              <span className="dot" style={{ background: COLORS[f.category] }} />
              <span className="grow ellipsis">{f.label}</span>
              {f.verified ? <span className="badge ok">✓</span> : <span className="mu tiny num">{f.confidence}%</span>}
              <span className="mu tiny num">{depthText(f)}</span>
            </div>
          ))}
          <div className="mu tiny" style={{ marginTop: 10, lineHeight: 1.7 }}>
            Drag a shape or its points. Double-click an edge to add a point, a point to remove it. <kbd>V</kbd> <kbd>E</kbd> <kbd>D</kbd> modes · <kbd>Del</kbd> delete · <kbd>Esc</kbd> deselect · <kbd>Ctrl</kbd>+<kbd>Z</kbd>/<kbd>Y</kbd> undo/redo
          </div>
        </div>
      </aside>
    </div>
  );
}

function StatusBadge({ im }: { im: CoreImage }) {
  if (BUSY(im.status)) return <span className="badge ac">analyzing…</span>;
  if (im.status === 'done') return <span className="badge ok">AI logged</span>;
  if (im.status === 'error') return <span className="badge bad">analysis failed</span>;
  return <span className="badge">manual</span>;
}

function RunMeta({ im, onSave }: { im: CoreImage; onSave: (b: Parameters<typeof api.patchImage>[1]) => void }) {
  const commit = (k: 'from_m' | 'to_m', v: string) => {
    const n = parseFloat(v);
    if (v.trim() === '') return onSave(k === 'from_m' ? { clear_from: true } : { clear_to: true });
    if (!Number.isFinite(n)) return;
    const other = k === 'from_m' ? im.to_m : im.from_m;
    if (other != null && (k === 'from_m' ? n >= other : n <= other)) return useStore.getState().toast('“To” must be greater than “From”.', 'error');
    onSave({ [k]: n });
  };
  return (
    <div className="row">
      <CommitInput className="input sm num" style={{ width: 72 }} placeholder="from" value={im.from_m} onCommit={v => commit('from_m', v)} aria-label="From depth" />
      <span className="mu">–</span>
      <CommitInput className="input sm num" style={{ width: 72 }} placeholder="to" value={im.to_m} onCommit={v => commit('to_m', v)} aria-label="To depth" />
      <select className="input sm" style={{ width: 'auto' }} value={im.direction} onChange={e => onSave({ direction: e.target.value as Direction })} aria-label="Depth direction">
        <option value="lr">depth →</option><option value="rl">depth ←</option><option value="tb">depth ↓</option><option value="bt">depth ↑</option>
      </select>
    </div>
  );
}

function Summary({ im }: { im: CoreImage }) {
  const a = im.analysis;
  return (
    <div className="card">
      <div className="card-h"><Sparkles size={14} color="var(--ac)" /><h3 className="grow">AI summary</h3></div>
      {!a ? <div className="mu">{BUSY(im.status) ? 'Analyzing…' : 'Not analyzed yet. Press Analyze to pre-log this photo.'}</div> : <>
        <div style={{ fontWeight: 600 }}>{a.headline}</div>
        <div className="kpis">
          <div className="kpi"><b>{a.kpi.sulphide_pct}%</b><span>Sulphides</span></div>
          <div className="kpi"><b>{a.kpi.vein_pct}%</b><span>Veins</span></div>
          <div className="kpi"><b>{a.kpi.alteration_score}/5</b><span>Alteration</span></div>
          <div className="kpi"><b>{a.kpi.prospectivity}</b><span>Prospectivity</span></div>
        </div>
        {a.minerals.length > 0 && (
          <table className="t" style={{ marginTop: 12 }}>
            <thead><tr><th>Mineral</th><th>%</th><th>Conf.</th></tr></thead>
            <tbody>{a.minerals.map((m, i) => (
              <tr key={i}><td>{m.name}{m.style && <div className="mu tiny">{m.style}</div>}</td><td className="num">{m.pct}</td>
                <td style={{ width: 90 }}><div className="bar"><i style={{ width: `${Math.min(100, m.conf)}%`, background: 'var(--ac)' }} /></div></td></tr>
            ))}</tbody>
          </table>
        )}
        {a.lithology.length > 0 && <div className="row wrap" style={{ marginTop: 10 }}>{a.lithology.map((l, i) => <span key={i} className="badge">{l.unit} · {l.pct}%</span>)}</div>}
        {im.model && <div className="mu tiny" style={{ marginTop: 10 }}>{im.model} · indicative visual estimate, verify against assay.</div>}
      </>}
    </div>
  );
}

function nearestRow(boxes: number[][], p: { x: number; y: number }, horiz: boolean): number[] | undefined {
  let best: number[] | undefined, bd = Infinity;
  for (const b of boxes) {
    const d = horiz ? Math.max(b[1] - p.y, 0, p.y - b[3]) : Math.max(b[0] - p.x, 0, p.x - b[2]);
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}

function GeotechCard({ im, holeSize }: { im: CoreImage; holeSize: string }) {
  const { geotech, patchImage } = useStore();
  const g = geotech[im.id];
  const boxes = imageBoxes(im);
  return (
    <div className="card">
      <div className="card-h"><Drill size={14} color="var(--ac)" /><h3 className="grow">Geotech · this run</h3><span className="badge">{holeSize}</span></div>
      {g && g.rqd != null ? (
        <div className="kpis" style={{ marginTop: 0 }}>
          <div className="kpi"><b style={{ color: rqdColor(g.rqd) }}>{fmt(g.rqd)}%</b><span>RQD</span></div>
          <div className="kpi"><b>{fmt(g.recovery ?? 0)}%</b><span>Recovery</span></div>
          <div className="kpi"><b>{fmt(g.ff ?? 0, 2)}</b><span>Fractures / m</span></div>
          <div className="kpi"><b>{g.natural}<span className="mu" style={{ fontSize: 13 }}> / {g.mechanical}</span></b><span>Natural / mech. breaks</span></div>
        </div>
      ) : <div className="mu tiny">RQD needs core rows and the run depths.</div>}
      {g?.warnings.map((w, i) => <div key={i} className="row tiny" style={{ color: 'var(--warn)', marginTop: 6 }}><AlertTriangle size={12} />{w}</div>)}
      <div className="col" style={{ marginTop: 12, gap: 8 }}>
        <div className="mu tiny">{boxes.length} core row{boxes.length === 1 ? '' : 's'} · {im.core_boxes ? 'drawn by you' : boxes.length ? 'from AI' : 'none yet'}</div>
        <Field label={`Scale (px/mm) · ${im.scale_px_per_mm ? 'manual' : g?.scale_source ? 'auto from ' + g.scale_source : 'auto'}`}>
          <CommitInput className="input sm num" placeholder={g?.px_per_mm ? String(g.px_per_mm) : 'auto'} value={im.scale_px_per_mm}
            onCommit={v => { const n = parseFloat(v); patchImage(im.id, v.trim() === '' || !(n > 0) ? { clear_scale: true } : { scale_px_per_mm: n }); }} />
        </Field>
        <div className="mu tiny">RQD = core pieces ≥ 10 cm between natural fractures, as % of the run. Drilling breaks are ignored.</div>
      </div>
    </div>
  );
}
