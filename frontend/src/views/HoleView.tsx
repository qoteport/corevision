import { useEffect, useMemo, useState } from 'react';
import { Camera, Drill, FlaskConical, ImagePlus, ListTree, Plus, Trash2, X } from 'lucide-react';
import { useStore } from '../store';
import { api, type Assay, type Direction, type Hole, type InterceptQuery, type Interval } from '../api';
import { BUSY, fmt, loggedMetres, runText } from '../lib/geo';
import { Field } from '../components/ui';
import StripLog from './StripLog';
import { AiBanner } from './Overview';
import IntervalLog from './IntervalLog';
import { AssayTable, Intercepts } from './Assays';
import GeotechPanel, { useHoleGeotech } from './Geotech';

type Tab = 'core' | 'log' | 'assays' | 'geotech';
const TABS: [Tab, string, typeof Camera][] = [['core', 'Photos & collar', Camera], ['log', 'Interval log', ListTree], ['assays', 'Assays', FlaskConical], ['geotech', 'Geotech', Drill]];

export default function HoleView({ holeId }: { holeId: string }) {
  const { project, navigate, dataVersion } = useStore();
  const hole = project?.holes.find(h => h.id === holeId);
  const [tab, setTab] = useState<Tab>(() => { try { return (sessionStorage.getItem('cv.holeTab') as Tab) || 'core'; } catch { return 'core'; } });
  const [intervals, setIntervals] = useState<Interval[]>([]);
  const [logVersion, setLogVersion] = useState(0);
  const [query, setQuery] = useState<InterceptQuery | null>(null);
  const [assays, setAssays] = useState<Assay[]>([]);
  const geotech = useHoleGeotech(holeId);
  useEffect(() => { try { sessionStorage.setItem('cv.holeTab', tab); } catch { /* storage blocked */ } }, [tab]);
  useEffect(() => { api.intervals(holeId).then(r => setIntervals(r.rows)).catch(() => setIntervals([])); }, [holeId, logVersion, dataVersion]);
  // grade column: the element chosen on the Assays tab, else the first one with data
  useEffect(() => {
    let live = true;
    (async () => {
      const el = query?.element ?? (project ? (await api.elements(project.id).catch(() => []))[0]?.element : undefined);
      const rows = el ? await api.holeAssays(holeId, el).catch(() => []) : [];
      if (live) setAssays(rows);
    })();
    return () => { live = false; };
  }, [holeId, query?.element, dataVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!hole) return <div className="page mu">Hole not found.</div>;
  const feats = hole.images.reduce((s, i) => s + i.features.length, 0);
  const pick = (imageId: string) => navigate({ view: 'image', holeId: hole.id, imageId });

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <div className="crumbs"><button onClick={() => navigate({ view: 'overview' })}>{project!.name}</button>/<span>Drillhole</span></div>
          <h1>{hole.name}</h1>
        </div>
        <span className="badge">{fmt(hole.length)} m · {hole.core_size || 'NQ'}</span>
        <span className="badge">{fmt(loggedMetres(hole))} m photographed</span>
        <span className="badge">{feats} features</span>
        {geotech?.summary && <span className="badge">RQD {fmt(geotech.summary.rqd)}%</span>}
      </div>
      <AiBanner />
      <div className="seg" style={{ marginBottom: 16 }}>
        {TABS.map(([k, l, Icon]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}><Icon size={14} />{l}</button>)}
      </div>
      <div className="cols">
        <div className="col">
          {tab === 'core' && <>
            <div className="card">
              <div className="card-h"><h3 className="grow">Core photos</h3></div>
              <Uploader hole={hole} />
              {hole.images.length > 0 && <div className="runs" style={{ marginTop: 14 }}>
                {hole.images.map(im => (
                  <div key={im.id} className="run" onClick={() => pick(im.id)}>
                    <div className="thumb" style={{ backgroundImage: `url(${api.imageUrl(im.id)})` }}>
                      <span className={'badge ' + (im.status === 'done' ? 'ok' : im.status === 'error' ? 'bad' : BUSY(im.status) ? 'ac' : '')}>
                        {BUSY(im.status) ? 'analyzing…' : im.status === 'done' ? 'AI logged' : im.status === 'error' ? 'failed' : 'manual'}
                      </span>
                    </div>
                    <div className="info">
                      <div className="row"><b className="num grow">{runText(im)}</b><span className="mu tiny">{im.features.length} features</span></div>
                      <div className="mu tiny ellipsis">{im.analysis?.headline || im.name}</div>
                    </div>
                  </div>
                ))}
              </div>}
            </div>
            <CollarCard hole={hole} />
            <SurveyCard hole={hole} />
          </>}
          {tab === 'log' && <IntervalLog hole={hole} onSaved={() => setLogVersion(v => v + 1)} />}
          {tab === 'assays' && <>
            <div className="card"><div className="card-h"><h3>Significant intercepts</h3></div><Intercepts holeId={hole.id} onQuery={setQuery} /></div>
            {query && <div className="card"><div className="card-h"><h3>{query.element} assays</h3></div><AssayTable holeId={hole.id} element={query.element} /></div>}
          </>}
          {tab === 'geotech' && <GeotechPanel hole={hole} geotech={geotech} />}
        </div>
        <div className="card">
          <div className="card-h"><h3 className="grow">Downhole log</h3>{assays[0] && <span className="mu tiny">grade: {assays[0].element} {assays[0].unit}</span>}</div>
          <StripLog hole={hole} onPick={pick} intervals={intervals} assays={assays} runs={geotech?.runs ?? []} />
        </div>
      </div>
    </div>
  );
}

function Uploader({ hole }: { hole: Hole }) {
  const { upload, health, navigate } = useStore();
  const lastTo = hole.images.length ? hole.images[hole.images.length - 1].to_m : null;
  const [file, setFile] = useState<File | null>(null);
  const [from, setFrom] = useState(lastTo != null ? String(lastTo) : '');
  const [to, setTo] = useState('');
  const [dir, setDir] = useState<Direction>('lr');
  const [ai, setAi] = useState(true);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => { setFrom(lastTo != null ? String(lastTo) : ''); }, [hole.id, lastTo]);

  const bad = from && to && parseFloat(to) <= parseFloat(from);
  const go = async () => {
    if (!file || bad) return;
    setBusy(true);
    const im = await upload(hole.id, file, from, to, dir, ai && !!health?.ai_configured);
    setBusy(false);
    if (im) { setFile(null); setTo(''); navigate({ view: 'image', holeId: hole.id, imageId: im.id }); }
  };
  const pick = () => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.onchange = () => i.files?.[0] && setFile(i.files[0]); i.click(); };

  return (
    <div>
      <div className={'drop' + (over ? ' over' : '')} onClick={pick}
        onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f?.type.startsWith('image/')) setFile(f); }}>
        {preview ? <img src={preview} alt="" /> : <ImagePlus size={26} style={{ marginBottom: 6 }} />}
        <div>{file ? file.name : <>Drop a core tray photo here, or <u>browse</u></>}</div>
      </div>
      <div className="grid3" style={{ marginTop: 10, alignItems: 'end' }}>
        <Field label="From (m)"><input className="input" inputMode="decimal" value={from} onChange={e => setFrom(e.target.value)} /></Field>
        <Field label="To (m)"><input className="input" inputMode="decimal" value={to} onChange={e => setTo(e.target.value)} style={bad ? { borderColor: 'var(--bad)' } : undefined} /></Field>
        <Field label="Depth increases">
          <select className="input" value={dir} onChange={e => setDir(e.target.value as Direction)}>
            <option value="lr">left → right</option><option value="rl">right → left</option><option value="tb">top → bottom</option><option value="bt">bottom → top</option>
          </select>
        </Field>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <label className="check" title={health?.ai_configured ? '' : 'AI is off on the server'}>
          <input type="checkbox" checked={ai && !!health?.ai_configured} disabled={!health?.ai_configured} onChange={e => setAi(e.target.checked)} />Log with AI
        </label>
        {bad && <span className="err tiny">“To” must be greater than “From”.</span>}
        <span className="grow" />
        {file && <button className="btn ghost sm" onClick={() => setFile(null)}><X size={13} />Clear</button>}
        <button className="btn primary" disabled={!file || !!bad || busy} onClick={go}>{busy ? 'Uploading…' : 'Add photo'}</button>
      </div>
    </div>
  );
}

function CollarCard({ hole }: { hole: Hole }) {
  const { patchHole, deleteHole } = useStore();
  const init = () => ({ name: hole.name, x: String(hole.x), y: String(hole.y), z: String(hole.z), azimuth: String(hole.azimuth), dip: String(hole.dip), length: String(hole.length), core_size: hole.core_size || 'NQ' });
  const sizes = Object.entries(useStore.getState().health?.core_sizes ?? { NQ: 47.6 });
  const [f, setF] = useState(init);
  useEffect(() => setF(init()), [hole.id, hole.name, hole.x, hole.y, hole.z, hole.azimuth, hole.dip, hole.length, hole.core_size]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(f) !== JSON.stringify(init());
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const n = (v: string, d: number) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);
  const save = () => patchHole(hole.id, { name: f.name.trim() || hole.name, x: n(f.x, hole.x), y: n(f.y, hole.y), z: n(f.z, hole.z), azimuth: n(f.azimuth, hole.azimuth), dip: n(f.dip, hole.dip), length: Math.max(1, n(f.length, hole.length)), core_size: f.core_size });
  return (
    <div className="card">
      <div className="card-h"><h3 className="grow">Collar</h3>
        <button className="btn ghost sm danger" onClick={() => confirm(`Delete ${hole.name} and its ${hole.images.length} photo(s)?`) && deleteHole(hole.id)}><Trash2 size={13} />Delete hole</button>
      </div>
      <div className="grid2">
        <Field label="Name"><input className="input" value={f.name} onChange={set('name')} /></Field>
        <Field label="Core size"><select className="input" value={f.core_size} onChange={set('core_size')}>{sizes.map(([k, d]) => <option key={k} value={k}>{k} · {d} mm</option>)}</select></Field>
      </div>
      <div className="grid3" style={{ marginTop: 10 }}>
        <Field label="Easting"><input className="input" inputMode="decimal" value={f.x} onChange={set('x')} /></Field>
        <Field label="Northing"><input className="input" inputMode="decimal" value={f.y} onChange={set('y')} /></Field>
        <Field label="RL (m)"><input className="input" inputMode="decimal" value={f.z} onChange={set('z')} /></Field>
        <Field label="Azimuth °"><input className="input" inputMode="decimal" value={f.azimuth} onChange={set('azimuth')} /></Field>
        <Field label="Dip ° (down)"><input className="input" inputMode="decimal" value={f.dip} onChange={set('dip')} /></Field>
        <Field label="Length (m)"><input className="input" inputMode="decimal" value={f.length} onChange={set('length')} /></Field>
      </div>
      <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        {dirty && <button className="btn ghost sm" onClick={() => setF(init())}>Discard</button>}
        <button className="btn sm primary" disabled={!dirty} onClick={save}>Save collar</button>
      </div>
    </div>
  );
}

function SurveyCard({ hole }: { hole: Hole }) {
  const { saveSurveys } = useStore();
  const toRows = () => hole.surveys.map(s => [String(s.depth), String(s.azimuth), String(s.dip)]);
  const [rows, setRows] = useState<string[][]>(toRows);
  useEffect(() => setRows(toRows()), [hole.id, hole.surveys]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(rows) !== JSON.stringify(toRows());
  const valid = rows.every(r => r.every(v => Number.isFinite(parseFloat(v))));
  const upd = (i: number, j: number, v: string) => setRows(rows.map((r, k) => (k === i ? r.map((x, l) => (l === j ? v : x)) : r)));
  const add = () => {
    const last = rows[rows.length - 1];
    setRows([...rows, last ? [String(Math.min(hole.length, parseFloat(last[0]) + 30 || 0)), last[1], last[2]] : ['0', String(hole.azimuth), String(hole.dip)]]);
  };
  return (
    <div className="card">
      <div className="card-h"><h3 className="grow">Downhole survey</h3><span className="mu tiny">minimum curvature</span></div>
      {rows.length > 0 && <div className="survey-row mu tiny"><span>Depth (m)</span><span>Azimuth °</span><span>Dip °</span><span /></div>}
      {rows.map((r, i) => (
        <div className="survey-row" key={i}>
          {r.map((v, j) => <input key={j} className="input sm" inputMode="decimal" value={v} onChange={e => upd(i, j, e.target.value)} style={Number.isFinite(parseFloat(v)) ? undefined : { borderColor: 'var(--bad)' }} />)}
          <button className="btn ghost sm icon" onClick={() => setRows(rows.filter((_, k) => k !== i))} aria-label="Remove station"><X size={13} /></button>
        </div>
      ))}
      {!rows.length && <div className="mu tiny" style={{ marginBottom: 8 }}>No stations: the hole runs straight from the collar azimuth and dip.</div>}
      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn sm" onClick={add}><Plus size={13} />Station</button>
        <span className="grow" />
        {dirty && <button className="btn ghost sm" onClick={() => setRows(toRows())}>Discard</button>}
        <button className="btn sm primary" disabled={!dirty || !valid}
          onClick={() => saveSurveys(hole.id, rows.map(r => ({ depth: parseFloat(r[0]), azimuth: parseFloat(r[1]), dip: parseFloat(r[2]) })))}>Save survey</button>
      </div>
    </div>
  );
}
