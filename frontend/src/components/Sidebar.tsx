import { useState } from 'react';
import { AlertTriangle, FileUp, Loader2, Plus } from 'lucide-react';
import { useCanEdit, useStore } from '../store';
import type { HoleInput } from '../api';
import { fmt, loggedMetres, runText } from '../lib/geo';
import { Field, FilePick, Modal } from './ui';

export default function Sidebar({ open }: { open: boolean }) {
  const { project, route, navigate, importCsv } = useStore();
  const canEdit = useCanEdit();
  const [adding, setAdding] = useState(false);
  if (!project) return <aside className={'side' + (open ? ' open' : '')}><div className="side-head mu tiny">Create a project to begin.</div></aside>;
  const holeId = 'holeId' in route ? route.holeId : null;
  const imageId = route.view === 'image' ? route.imageId : null;

  return (
    <aside className={'side' + (open ? ' open' : '')}>
      <div className="side-head">
        <div className="ellipsis" style={{ fontWeight: 650 }}>{project.name}</div>
        <div className="mu tiny">{project.deposit_style || 'Deposit style not set'}{project.crs_epsg ? ` · EPSG:${project.crs_epsg}` : ''}</div>
      </div>
      <div className="side-scroll">
        <div className="sect"><span>Drillholes · {project.holes.length}</span>
          {canEdit && <button className="btn ghost sm icon" onClick={() => setAdding(true)} aria-label="New hole" title="New hole"><Plus size={15} /></button>}
        </div>
        {!project.holes.length && <div className="mu tiny" style={{ padding: '4px 8px' }}>No holes yet. Add one or import a collar CSV.</div>}
        {project.holes.map(h => {
          const logged = loggedMetres(h);
          return (
            <div key={h.id}>
              <div className={'hole-item' + (h.id === holeId ? ' on' : '')} onClick={() => navigate({ view: 'hole', holeId: h.id })}>
                <div className="row"><b className="grow ellipsis">{h.name}</b><span className="mu tiny num">{fmt(h.length)} m</span></div>
                <div className="meta">az {fmt(h.azimuth)}° · dip {fmt(h.dip)}°{h.surveys.length ? ' · surveyed' : ''}</div>
                <div className="progress" title={`${fmt(logged)} m photographed`}><i style={{ width: `${Math.min(100, (logged / h.length) * 100)}%` }} /></div>
              </div>
              {h.id === holeId && h.images.map(im => (
                <div key={im.id} className={'run-item' + (im.id === imageId ? ' on' : '')} onClick={() => navigate({ view: 'image', holeId: h.id, imageId: im.id })}>
                  <span className="num">{runText(im)}</span>
                  <span className="grow" />
                  {im.status === 'analyzing' || im.status === 'queued' ? <Loader2 size={13} className="spin" style={{ animation: 'spin 1s linear infinite' }} />
                    : im.status === 'error' ? <span title={im.error ?? ''}><AlertTriangle size={13} color="var(--bad)" /></span>
                      : <span className="mu tiny">{im.features.length}</span>}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <div className="side-foot" style={{ gridTemplateColumns: '1fr 1fr 1fr' }} hidden={!canEdit}>
        <FilePick className="btn sm" accept=".csv,text/csv" onFile={f => importCsv('collars', f)}><FileUp size={13} />Collars</FilePick>
        <FilePick className="btn sm" accept=".csv,text/csv" onFile={f => importCsv('surveys', f)}><FileUp size={13} />Surveys</FilePick>
        <FilePick className="btn sm" accept=".csv,text/csv" onFile={f => importCsv('assays', f)}><FileUp size={13} />Assays</FilePick>
      </div>
      {adding && <NewHole onClose={() => setAdding(false)} />}
    </aside>
  );
}

export function NewHole({ onClose }: { onClose: () => void }) {
  const { createHole, project } = useStore();
  const n = project?.holes.length ?? 0;
  const [f, setF] = useState({ name: `DDH-${String(n + 1).padStart(3, '0')}`, x: '0', y: '0', z: '0', azimuth: '90', dip: '60', length: '150', core_size: 'NQ' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const sizes = Object.entries(useStore.getState().health?.core_sizes ?? { NQ: 47.6 });
  const num = (v: string, d: number) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);
  const submit = async () => {
    if (!f.name.trim()) return;
    const body: HoleInput = { name: f.name.trim(), x: num(f.x, 0), y: num(f.y, 0), z: num(f.z, 0), azimuth: num(f.azimuth, 0), dip: num(f.dip, 60), length: Math.max(1, num(f.length, 100)), core_size: f.core_size };
    if (await createHole(body)) onClose();
  };
  return (
    <Modal title="New drillhole" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" onClick={submit} disabled={!f.name.trim()}>Add hole</button></>}>
      <Field label="Hole name"><input className="input" autoFocus value={f.name} onChange={set('name')} /></Field>
      <div className="grid3">
        <Field label="Easting"><input className="input" inputMode="decimal" value={f.x} onChange={set('x')} /></Field>
        <Field label="Northing"><input className="input" inputMode="decimal" value={f.y} onChange={set('y')} /></Field>
        <Field label="RL (m)"><input className="input" inputMode="decimal" value={f.z} onChange={set('z')} /></Field>
        <Field label="Azimuth °"><input className="input" inputMode="decimal" value={f.azimuth} onChange={set('azimuth')} /></Field>
        <Field label="Dip ° (down)"><input className="input" inputMode="decimal" value={f.dip} onChange={set('dip')} /></Field>
        <Field label="Length (m)"><input className="input" inputMode="decimal" value={f.length} onChange={set('length')} /></Field>
        <Field label="Core size"><select className="input" value={f.core_size} onChange={set('core_size')}>{sizes.map(([k, d]) => <option key={k} value={k}>{k} · {d} mm</option>)}</select></Field>
      </div>
    </Modal>
  );
}
