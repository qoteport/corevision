import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Plus, Sparkles, X } from 'lucide-react';
import { useStore } from '../store';
import { api, type Hole, type Interval, type LoggingCode, type QaIssue } from '../api';

const blank = (from: number, to: number): Interval => ({
  from_m: from, to_m: to, lithology: '', alteration: '', alteration_intensity: 0, mineralization: '',
  sulphide_pct: 0, vein_pct: 0, comments: '', source: 'user',
});
const INTENSITY = ['–', 'weak', 'moderate', 'strong'];

/** Editable from–to downhole log: the table geologists export to Leapfrog / Micromine / acQuire. */
export default function IntervalLog({ hole, onSaved }: { hole: Hole; onSaved: () => void }) {
  const { project, toast, dataVersion } = useStore();
  const [rows, setRows] = useState<Interval[]>([]);
  const [saved, setSaved] = useState<string>('[]');
  const [qa, setQa] = useState<QaIssue[]>([]);
  const [codes, setCodes] = useState<LoggingCode[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.intervals(hole.id).then(r => { if (live) { setRows(r.rows); setSaved(JSON.stringify(r.rows)); setQa(r.qa); } }).catch(e => toast(e.message, 'error'));
    if (project) api.codes(project.id).then(c => live && setCodes(c)).catch(() => {});
    return () => { live = false; };
  }, [hole.id, project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // QA against the current photos, refreshed as other edits land
  useEffect(() => {
    if (JSON.stringify(rows) !== saved) return;
    api.intervals(hole.id).then(r => setQa(r.qa)).catch(() => {});
  }, [dataVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = JSON.stringify(rows) !== saved;
  const byField = useMemo(() => ({
    lithology: codes.filter(c => c.field === 'lithology'),
    alteration: codes.filter(c => c.field === 'alteration'),
    mineralization: codes.filter(c => c.field === 'mineralization'),
  }), [codes]);
  const problems = useMemo(() => {
    const p: Record<number, string> = {};
    const sorted = rows.map((r, i) => ({ r, i })).sort((a, b) => a.r.from_m - b.r.from_m);
    sorted.forEach(({ r, i }, k) => {
      if (!(r.to_m > r.from_m)) p[i] = '“To” must be greater than “From”';
      const prev = sorted[k - 1];
      if (prev && r.from_m < prev.r.to_m - 1e-6) p[i] = `Overlaps ${prev.r.from_m}–${prev.r.to_m} m`;
    });
    return p;
  }, [rows]);

  const upd = (i: number, patch: Partial<Interval>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...patch, source: 'user' } : r)));
  const num = (v: string) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0);
  const add = () => {
    const last = [...rows].sort((a, b) => b.to_m - a.to_m)[0];
    const from = last ? last.to_m : 0;
    setRows([...rows, blank(from, Math.min(hole.length, from + 1) > from ? Math.min(hole.length, from + 1) : from + 1)]);
  };
  const draft = async () => {
    if (rows.length && !confirm('Replace the table with a draft built from the photo annotations? Unsaved and saved rows in the table will be replaced (nothing is saved until you press Save).')) return;
    setBusy(true);
    try {
      const d = await api.draftIntervals(hole.id);
      setRows(d.rows); setQa(d.qa);
      toast(d.rows.length ? `Drafted ${d.rows.length} intervals from the photos. Review, then save.` : 'Nothing to draft: add photos with depths and annotations first.');
    } catch (e) { toast((e as Error).message, 'error'); }
    setBusy(false);
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.putIntervals(hole.id, [...rows].sort((a, b) => a.from_m - b.from_m));
      setRows(r.rows); setSaved(JSON.stringify(r.rows)); setQa(r.qa);
      toast(`Interval log saved (${r.rows.length} intervals)`); onSaved();
    } catch (e) { toast((e as Error).message, 'error'); }
    setBusy(false);
  };

  const cell = { padding: '4px 4px' } as const;
  const inp = 'input sm';
  return (
    <div className="card">
      <div className="card-h">
        <h3 className="grow">Interval log</h3>
        <button className="btn sm" disabled={busy} onClick={draft}><Sparkles size={13} />Draft from photos</button>
        <button className="btn sm" onClick={add}><Plus size={13} />Row</button>
        {dirty && <button className="btn sm ghost" onClick={() => setRows(JSON.parse(saved))}>Discard</button>}
        <button className="btn sm primary" disabled={!dirty || busy || Object.keys(problems).length > 0} onClick={save}>Save log</button>
      </div>

      {qa.length > 0 ? (
        <div className="col" style={{ gap: 4, marginBottom: 10 }}>
          {qa.slice(0, 6).map((q, i) => <div key={i} className="row tiny" style={{ color: 'var(--warn)' }}><AlertTriangle size={13} />{q.message}</div>)}
          {qa.length > 6 && <div className="mu tiny">…and {qa.length - 6} more</div>}
        </div>
      ) : rows.length > 0 && !dirty ? <div className="row tiny" style={{ color: 'var(--ok)', marginBottom: 10 }}><CheckCircle2 size={13} />No gaps, overlaps or unlogged photographed core.</div> : null}

      {!rows.length ? (
        <div className="mu">No intervals yet. <b>Draft from photos</b> builds a first pass from the annotated core photos, or add rows by hand.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="t" style={{ minWidth: 980 }}>
            <thead><tr><th>From</th><th>To</th><th>Lithology</th><th>Alteration</th><th>Int.</th><th>Mineralization</th><th>Sulph %</th><th>Vein %</th><th>Comments</th><th /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} style={problems[i] ? { background: '#ff5f6d12' } : undefined} title={problems[i]}>
                  <td style={cell}><input className={inp + ' num'} style={{ width: 70 }} inputMode="decimal" value={r.from_m} onChange={e => upd(i, { from_m: num(e.target.value) })} /></td>
                  <td style={cell}><input className={inp + ' num'} style={{ width: 70 }} inputMode="decimal" value={r.to_m} onChange={e => upd(i, { to_m: num(e.target.value) })} /></td>
                  <td style={cell}><CodeInput list="cv-lith" value={r.lithology} onChange={v => upd(i, { lithology: v })} /></td>
                  <td style={cell}><CodeInput list="cv-alt" value={r.alteration} onChange={v => upd(i, { alteration: v })} /></td>
                  <td style={cell}>
                    <select className={inp} style={{ width: 'auto' }} value={r.alteration_intensity} onChange={e => upd(i, { alteration_intensity: +e.target.value })}>
                      {INTENSITY.map((t, k) => <option key={k} value={k}>{t}</option>)}
                    </select>
                  </td>
                  <td style={cell}><CodeInput list="cv-min" value={r.mineralization} onChange={v => upd(i, { mineralization: v })} /></td>
                  <td style={cell}><input className={inp + ' num'} style={{ width: 60 }} inputMode="decimal" value={r.sulphide_pct} onChange={e => upd(i, { sulphide_pct: num(e.target.value) })} /></td>
                  <td style={cell}><input className={inp + ' num'} style={{ width: 60 }} inputMode="decimal" value={r.vein_pct} onChange={e => upd(i, { vein_pct: num(e.target.value) })} /></td>
                  <td style={cell}><input className={inp} value={r.comments} onChange={e => upd(i, { comments: e.target.value })} /></td>
                  <td style={cell}>
                    <div className="row" style={{ gap: 2 }}>
                      {r.source === 'auto' && <span className="badge ac" title="Drafted from photos, not yet edited">draft</span>}
                      <button className="btn ghost sm icon" onClick={() => setRows(rows.filter((_, k) => k !== i))} aria-label="Remove interval"><X size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <datalist id="cv-lith">{byField.lithology.map(c => <option key={c.code} value={c.code}>{c.description}</option>)}</datalist>
      <datalist id="cv-alt">{byField.alteration.map(c => <option key={c.code} value={c.code}>{c.description}</option>)}</datalist>
      <datalist id="cv-min">{byField.mineralization.map(c => <option key={c.code} value={c.code}>{c.description}</option>)}</datalist>
      {!codes.length && <div className="mu tiny" style={{ marginTop: 8 }}>Tip: set up logging codes on the project overview so the AI and this table use your company's dictionary.</div>}
    </div>
  );
}

function CodeInput({ list, value, onChange }: { list: string; value: string; onChange: (v: string) => void }) {
  return <input className="input sm" style={{ minWidth: 110 }} list={list} value={value} onChange={e => onChange(e.target.value)} />;
}
