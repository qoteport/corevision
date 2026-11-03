import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useStore } from '../store';
import { api, type Hole, type HoleGeotech } from '../api';
import { fmt } from '../lib/geo';

export function useHoleGeotech(holeId: string) {
  const dataVersion = useStore(s => s.dataVersion);
  const [g, setG] = useState<HoleGeotech | null>(null);
  useEffect(() => { api.holeGeotech(holeId).then(setG).catch(() => setG(null)); }, [holeId, dataVersion]);
  return g;
}

export const rqdColor = (r: number) => (r < 25 ? '#ff4d6a' : r < 50 ? '#ff8a3d' : r < 75 ? '#ffd23f' : r < 90 ? '#7ccf6b' : '#2fbf9b');

/** RQD / recovery / fracture frequency per photographed run, plus hole summary. */
export default function GeotechPanel({ hole, geotech }: { hole: Hole; geotech: HoleGeotech | null }) {
  const { health, patchHole, navigate } = useStore();
  const sizes = Object.entries(health?.core_sizes ?? { NQ: 47.6 });
  const s = geotech?.summary;
  return (
    <div className="card">
      <div className="card-h">
        <h3 className="grow">Geotechnical log</h3>
        <label className="row tiny mu">Core size
          <select className="input sm" style={{ width: 'auto' }} value={hole.core_size || 'NQ'} onChange={e => patchHole(hole.id, { core_size: e.target.value })}>
            {sizes.map(([k, d]) => <option key={k} value={k}>{k} · {d} mm</option>)}
          </select>
        </label>
      </div>
      {s ? (
        <div className="kpis" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 0, marginBottom: 12 }}>
          <div className="kpi"><b style={{ color: rqdColor(s.rqd) }}>{fmt(s.rqd)}%</b><span>RQD · {s.rock_quality}</span></div>
          <div className="kpi"><b>{fmt(s.recovery)}%</b><span>Core recovery</span></div>
          <div className="kpi"><b>{fmt(s.ff, 2)}</b><span>Fractures / m</span></div>
          <div className="kpi"><b>{fmt(s.logged_m)} m</b><span>Measured</span></div>
        </div>
      ) : <div className="mu" style={{ marginBottom: 10 }}>No measured runs yet. Open a photo and use <b>Rows</b> and <b>Breaks</b> in the editor (or run the AI, which detects both).</div>}
      {geotech && geotech.runs.length > 0 && (
        <table className="t">
          <thead><tr><th>Run</th><th>RQD</th><th>Recovery</th><th>FF /m</th><th>Breaks (nat / mech)</th><th>Scale</th></tr></thead>
          <tbody>
            {geotech.runs.map(r => (
              <tr key={r.image_id} className="click" onClick={() => navigate({ view: 'image', holeId: hole.id, imageId: r.image_id })}>
                <td className="num"><b>{r.from_m}–{r.to_m} m</b></td>
                <td>{r.rqd == null ? <span className="mu">–</span> : <div className="row"><div className="bar" style={{ width: 60 }}><i style={{ width: `${r.rqd}%`, background: rqdColor(r.rqd) }} /></div><span className="num">{fmt(r.rqd)}%</span></div>}</td>
                <td className="num">{r.recovery == null ? '–' : `${fmt(r.recovery)}%`}</td>
                <td className="num">{r.ff == null ? '–' : fmt(r.ff, 2)}</td>
                <td className="num">{r.natural} / {r.mechanical}</td>
                <td className="mu tiny">
                  {r.px_per_mm ? `${fmt(r.px_per_mm, 2)} px/mm` : '–'}
                  {r.warnings.length > 0 && <div className="row" style={{ color: 'var(--warn)', gap: 4 }} title={r.warnings.join('\n')}><AlertTriangle size={12} />{r.warnings[0]}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mu tiny" style={{ marginTop: 8 }}>
        RQD counts core pieces ≥ 10 cm between natural fractures only (Deere). The scale comes from the {hole.core_size || 'NQ'} core diameter in the photo unless you set one manually. Visual geotech is a screening tool: confirm against measured logs.
      </div>
    </div>
  );
}
