import { useEffect, useMemo, useState } from 'react';
import { FileUp } from 'lucide-react';
import { useStore } from '../store';
import { api, type Assay, type Calibration, type ElementInfo, type Intercept, type InterceptQuery } from '../api';
import { fmt } from '../lib/geo';
import { Field, FilePick } from '../components/ui';

/** Typical reporting cut-offs, used only as a starting value. */
const DEFAULT_CUTOFF: Record<string, Record<string, number>> = {
  Au: { 'g/t': 0.5, ppm: 0.5, ppb: 500 }, Ag: { 'g/t': 10, ppm: 10 }, Cu: { '%': 0.2, ppm: 2000 },
  Zn: { '%': 1, ppm: 10000 }, Pb: { '%': 1, ppm: 10000 }, Ni: { '%': 0.3, ppm: 3000 }, Mo: { ppm: 100, '%': 0.01 },
  Li: { ppm: 2000, '%': 0.2 }, Fe: { '%': 50 }, Co: { ppm: 500 },
};
export const defaultCutoff = (e: ElementInfo) => DEFAULT_CUTOFF[e.element]?.[e.unit] ?? +(e.max * 0.1).toPrecision(2);

export function useElements() {
  const { project, dataVersion } = useStore();
  const [els, setEls] = useState<ElementInfo[]>([]);
  useEffect(() => { if (project) api.elements(project.id).then(setEls).catch(() => setEls([])); }, [project?.id, dataVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  return els;
}

/** Intercept parameters + results table. `holeId` limits the table to one hole. */
export function Intercepts({ holeId, onQuery }: { holeId?: string; onQuery?: (q: InterceptQuery | null) => void }) {
  const { project, dataVersion, navigate, importCsv } = useStore();
  const els = useElements();
  const [q, setQ] = useState<InterceptQuery | null>(null);
  const [list, setList] = useState<Intercept[]>([]);
  const [incl, setIncl] = useState('');

  useEffect(() => {
    if (!els.length) { setQ(null); return; }
    if (!q || !els.some(e => e.element === q.element)) {
      const e = els[0];
      setQ({ element: e.element, cutoff: defaultCutoff(e), max_dilution: 2, min_length: 1 });
    }
  }, [els]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onQuery?.(q); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!project || !q || !(q.cutoff > 0)) return;
    const query = { ...q, incl_cutoff: parseFloat(incl) > q.cutoff ? parseFloat(incl) : undefined };
    api.intercepts(project.id, query).then(r => setList(holeId ? r.intercepts.filter(i => i.hole_id === holeId) : r.intercepts)).catch(() => setList([]));
  }, [project?.id, q, incl, holeId, dataVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!els.length) {
    return (
      <div className="mu">
        No assays yet. Import a lab CSV with <code>hole, from, to</code> and one column per element (e.g. <code>Au_ppm, Cu_pct</code>).
        <div style={{ marginTop: 10 }}><FilePick className="btn sm" accept=".csv,text/csv" onFile={f => importCsv('assays', f)}><FileUp size={13} />Import assays</FilePick></div>
      </div>
    );
  }
  if (!q) return null;
  const unit = els.find(e => e.element === q.element)?.unit ?? '';
  const n = (v: string, d: number) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);
  const best = list.reduce((m, i) => Math.max(m, i.metal), 0);

  return (
    <div className="col">
      <div className="grid3" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', alignItems: 'end' }}>
        <Field label="Element">
          <select className="input sm" value={q.element} onChange={e => { const el = els.find(x => x.element === e.target.value)!; setQ({ ...q, element: el.element, cutoff: defaultCutoff(el) }); setIncl(''); }}>
            {els.map(e => <option key={e.element} value={e.element}>{e.element}{e.unit ? ` (${e.unit})` : ''}</option>)}
          </select>
        </Field>
        <Field label={`Cut-off ${unit}`}><input className="input sm" inputMode="decimal" defaultValue={q.cutoff} key={q.element} onBlur={e => setQ({ ...q, cutoff: n(e.target.value, q.cutoff) })} onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} /></Field>
        <Field label="Max dilution (m)"><input className="input sm" inputMode="decimal" defaultValue={q.max_dilution} onBlur={e => setQ({ ...q, max_dilution: n(e.target.value, q.max_dilution) })} /></Field>
        <Field label="Min length (m)"><input className="input sm" inputMode="decimal" defaultValue={q.min_length} onBlur={e => setQ({ ...q, min_length: n(e.target.value, q.min_length) })} /></Field>
        <Field label={`“incl.” cut-off ${unit}`}><input className="input sm" inputMode="decimal" placeholder="optional" value={incl} onChange={e => setIncl(e.target.value)} /></Field>
      </div>
      {list.length === 0 ? <div className="mu">No intercepts above {q.cutoff} {unit} {q.element}.</div> : (
        <table className="t">
          <thead><tr>{!holeId && <th>Hole</th>}<th>Intercept (downhole)</th><th style={{ width: 120 }}>{list[0]?.metal_unit}</th></tr></thead>
          <tbody>
            {[...list].sort((a, b) => b.metal - a.metal).map((i, k) => (
              <tr key={k} className={holeId ? '' : 'click'} onClick={() => !holeId && navigate({ view: 'hole', holeId: i.hole_id })}>
                {!holeId && <td><b>{i.hole}</b></td>}
                <td>{i.text}</td>
                <td><div className="row"><div className="bar grow"><i style={{ width: `${(i.metal / best) * 100}%`, background: 'var(--ac)' }} /></div><span className="num mu tiny">{fmt(i.metal, 1)}</span></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mu tiny">Length-weighted composites. Unsampled gaps count as zero grade. Lengths are downhole, not true widths.</div>
    </div>
  );
}

/** Raw assay table for a hole and element. */
export function AssayTable({ holeId, element }: { holeId: string; element: string | null }) {
  const dataVersion = useStore(s => s.dataVersion);
  const [rows, setRows] = useState<Assay[]>([]);
  useEffect(() => { if (element) api.holeAssays(holeId, element).then(setRows).catch(() => setRows([])); }, [holeId, element, dataVersion]);
  if (!element || !rows.length) return null;
  return (
    <div style={{ maxHeight: 320, overflow: 'auto' }}>
      <table className="t">
        <thead><tr><th>From</th><th>To</th><th>Sample</th><th>{element} ({rows[0].unit})</th></tr></thead>
        <tbody>{rows.map(r => (
          <tr key={r.id}><td className="num">{r.from_m}</td><td className="num">{r.to_m}</td><td className="mu">{r.sample_id}</td>
            <td className="num">{r.below_detection ? <span className="mu" title="Below detection; stored at half the detection limit">&lt;DL ({r.value})</span> : r.value}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

/** Visual sulphide % (log or AI) against assay, to check and calibrate the visual estimates. */
export function CalibrationChart() {
  const { project, dataVersion } = useStore();
  const els = useElements();
  const [el, setEl] = useState<string | null>(null);
  const [data, setData] = useState<Calibration | null>(null);
  useEffect(() => { if (els.length && (!el || !els.some(e => e.element === el))) setEl((els.find(e => ['Cu', 'Zn', 'S', 'Ni', 'Pb'].includes(e.element)) ?? els[0]).element); }, [els]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (project && el) api.calibration(project.id, el).then(setData).catch(() => setData(null)); }, [project?.id, el, dataVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const W = 360, H = 220, pad = 34;
  const scale = useMemo(() => {
    const pts = data?.points ?? [];
    return { mx: Math.max(1, ...pts.map(p => p.visual)), my: Math.max(1e-6, ...pts.map(p => p.assay)) };
  }, [data]);
  if (!els.length) return <div className="mu tiny">Import assays to compare visual sulphide estimates with lab results.</div>;
  const unit = els.find(e => e.element === el)?.unit ?? '';
  const pts = data?.points ?? [];
  const x = (v: number) => pad + (v / scale.mx) * (W - pad - 8), y = (v: number) => H - pad + 4 - (v / scale.my) * (H - pad - 10);
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <select className="input sm" style={{ width: 'auto' }} value={el ?? ''} onChange={e => setEl(e.target.value)}>{els.map(e => <option key={e.element}>{e.element}</option>)}</select>
        <span className="grow" />
        {data && <span className="badge">{data.n} samples{data.r != null ? ` · r = ${data.r.toFixed(2)}` : ''}</span>}
      </div>
      {pts.length === 0 ? <div className="mu tiny">No assay intervals overlap logged or photographed core yet.</div> : (
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', color: 'var(--ink)' }} role="img" aria-label="Visual sulphide versus assay">
          <line x1={pad} y1={H - pad + 4} x2={W - 8} y2={H - pad + 4} stroke="currentColor" strokeOpacity={0.3} />
          <line x1={pad} y1={6} x2={pad} y2={H - pad + 4} stroke="currentColor" strokeOpacity={0.3} />
          {pts.map((p, i) => <circle key={i} cx={x(p.visual)} cy={y(p.assay)} r={3.5} fill={p.source === 'log' ? 'var(--ac)' : 'var(--info)'} fillOpacity={0.8}><title>{`${p.hole} ${p.from_m}–${p.to_m} m · visual ${p.visual}% · ${el} ${p.assay} ${unit}`}</title></circle>)}
          <text x={W / 2} y={H - 4} textAnchor="middle" fontSize={10} fill="currentColor" opacity={0.6}>visual sulphide % (max {fmt(scale.mx)})</text>
          <text x={10} y={H / 2} fontSize={10} fill="currentColor" opacity={0.6} transform={`rotate(-90 10 ${H / 2})`} textAnchor="middle">{el} {unit} (max {fmt(scale.my, 2)})</text>
        </svg>
      )}
      <div className="row tiny mu" style={{ gap: 12 }}><span><span className="dot" style={{ background: 'var(--ac)' }} /> from interval log</span><span><span className="dot" style={{ background: 'var(--info)' }} /> from AI photo estimate</span></div>
    </div>
  );
}
