import { useState } from 'react';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { useStore } from '../store';
import { CATEGORIES, COLORS, fmt, loggedMetres } from '../lib/geo';
import { NewProject } from '../components/TopBar';
import { NewHole } from '../components/Sidebar';
import { CommitInput, Field } from '../components/ui';
import CodesEditor from './CodesEditor';
import { CalibrationChart, Intercepts } from './Assays';

export function AiBanner() {
  const health = useStore(s => s.health);
  if (health?.ai_configured) return null;
  return (
    <div className="banner"><AlertTriangle size={15} color="var(--warn)" />
      <span>AI logging is off. Add <code>ANTHROPIC_API_KEY</code> to <code>.env</code> and restart the server. Manual logging still works.</span>
    </div>
  );
}

export default function Overview() {
  const { project, health, navigate, patchProject, deleteProject } = useStore();
  const [newProject, setNewProject] = useState(false);
  const [newHole, setNewHole] = useState(false);

  if (!project) {
    return (
      <div className="page">
        <div className="empty">
          <h2>Log drill core with AI, model it in 3D</h2>
          <p className="mu">Create a project to add holes, upload core photos and build the downhole log.</p>
          <button className="btn primary" onClick={() => setNewProject(true)}><Plus size={15} />New project</button>
          <Steps />
        </div>
        {newProject && <NewProject onClose={() => setNewProject(false)} />}
      </div>
    );
  }

  const holes = project.holes;
  const images = holes.flatMap(h => h.images);
  const feats = images.flatMap(i => i.features);
  const drilled = holes.reduce((s, h) => s + h.length, 0);
  const logged = holes.reduce((s, h) => s + loggedMetres(h), 0);
  const verified = feats.filter(f => f.verified).length;
  const byCat = CATEGORIES.map(c => ({ c, n: feats.filter(f => f.category === c).length }));
  const maxCat = Math.max(1, ...byCat.map(b => b.n));
  const minerals = new Map<string, number>();
  feats.filter(f => f.category === 'mineralization').forEach(f => {
    const k = f.label.toLowerCase().trim();
    minerals.set(k, (minerals.get(k) ?? 0) + Math.max(0.01, (f.to_m ?? 0) - (f.from_m ?? 0)));
  });
  const topMin = [...minerals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow"><div className="crumbs">Project overview</div><h1>{project.name}</h1></div>
        <button className="btn" onClick={() => navigate({ view: 'model' })}>Open 3D model</button>
        <button className="btn primary" onClick={() => setNewHole(true)}><Plus size={15} />New hole</button>
      </div>
      <AiBanner />
      <div className="stats">
        <div className="stat"><b>{holes.length}</b><span>Drillholes</span></div>
        <div className="stat"><b>{fmt(drilled)} m</b><span>Drilled</span></div>
        <div className="stat"><b>{fmt(logged)} m</b><span>Photographed · {drilled ? fmt((logged / drilled) * 100, 0) : 0}%</span></div>
        <div className="stat"><b>{feats.length}</b><span>Logged features</span></div>
        <div className="stat"><b>{feats.length ? fmt((verified / feats.length) * 100, 0) : 0}%</b><span>Verified by geologist</span></div>
      </div>

      <div className="cols">
        <div className="col">
        <div className="card">
          <div className="card-h"><h3 className="grow">Drillholes</h3></div>
          {holes.length ? (
            <table className="t">
              <thead><tr><th>Hole</th><th>Collar E / N / RL</th><th>Az / Dip</th><th>Length</th><th>Photos</th><th>Features</th></tr></thead>
              <tbody>
                {holes.map(h => (
                  <tr key={h.id} className="click" onClick={() => navigate({ view: 'hole', holeId: h.id })}>
                    <td><b>{h.name}</b>{h.surveys.length > 0 && <span className="badge" style={{ marginLeft: 6 }}>surveyed</span>}</td>
                    <td className="num mu">{fmt(h.x)} / {fmt(h.y)} / {fmt(h.z)}</td>
                    <td className="num">{fmt(h.azimuth)}° / {fmt(h.dip)}°</td>
                    <td className="num">{fmt(h.length)} m</td>
                    <td className="num">{h.images.length}</td>
                    <td className="num">{h.images.reduce((s, i) => s + i.features.length, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="mu">No holes yet. Add one, or import a collar CSV from the sidebar.</div>}
        </div>
        <div className="card">
          <div className="card-h"><h3 className="grow">Significant intercepts</h3></div>
          <Intercepts />
        </div>
        </div>

        <div className="col">
          <div className="card">
            <div className="card-h"><h3>Features by category</h3></div>
            {byCat.map(({ c, n }) => (
              <div key={c} className="row" style={{ marginBottom: 8 }}>
                <span className="dot" style={{ background: COLORS[c] }} /><span style={{ width: 110 }}>{c}</span>
                <div className="bar grow"><i style={{ width: `${(n / maxCat) * 100}%`, background: COLORS[c] }} /></div>
                <span className="num mu" style={{ width: 28, textAlign: 'right' }}>{n}</span>
              </div>
            ))}
            {topMin.length > 0 && <>
              <div className="card-h" style={{ marginTop: 14 }}><h3>Mineralization (metres logged)</h3></div>
              {topMin.map(([k, m]) => <div key={k} className="row tiny" style={{ marginBottom: 4 }}><span className="grow">{k}</span><span className="num mu">{fmt(m, 2)} m</span></div>)}
            </>}
          </div>
          <div className="card">
            <div className="card-h"><h3>Visual vs assay</h3></div>
            <CalibrationChart />
          </div>
          <CodesEditor />
          <div className="card">
            <div className="card-h"><h3>Project settings</h3></div>
            <div className="col">
              <Field label="Name"><CommitInput value={project.name} onCommit={v => v.trim() && patchProject({ name: v.trim() })} /></Field>
              <Field label="Deposit style">
                <select className="input" value={project.deposit_style} onChange={e => patchProject({ deposit_style: e.target.value })}>
                  <option value="">Open / unknown</option>
                  {health?.deposit_styles.map(d => <option key={d}>{d}</option>)}
                </select>
              </Field>
              <Field label="CRS (EPSG code)"><CommitInput inputMode="numeric" placeholder="e.g. 32630" value={project.crs_epsg} onCommit={v => { const n = parseInt(v); patchProject({ crs_epsg: Number.isFinite(n) ? n : null }); }} /></Field>
              <div><button className="btn danger sm" onClick={() => confirm(`Delete "${project.name}" with all holes, photos and logs? This cannot be undone.`) && deleteProject()}><Trash2 size={13} />Delete project</button></div>
            </div>
          </div>
        </div>
      </div>
      {newHole && <NewHole onClose={() => setNewHole(false)} />}
    </div>
  );
}

function Steps() {
  const s = [
    ['Set up', 'Create a project and pick the deposit style.'],
    ['Holes', 'Add collars by hand or import a collar and survey CSV.'],
    ['Photos', 'Upload core tray photos with their depth range.'],
    ['Review', 'Correct the AI polygons and mark them verified.'],
    ['Model', 'See every hole in 3D and export the interval log.'],
  ];
  return <div className="steps">{s.map(([t, d], i) => <div key={t}><b>{i + 1} · {t}</b>{d}</div>)}</div>;
}
