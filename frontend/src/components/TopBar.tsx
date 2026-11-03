import { useState } from 'react';
import { Box, ChevronDown, Download, FolderOpen, LayoutDashboard, Menu as MenuIcon, Plus, Sparkles } from 'lucide-react';
import { useStore } from '../store';
import { api } from '../api';
import { Field, Menu, Modal } from './ui';

export default function TopBar({ onMenu }: { onMenu: () => void }) {
  const { project, projects, route, navigate, openProject, health } = useStore();
  const [creating, setCreating] = useState(false);
  const view = route.view === 'model' ? 'model' : 'log';

  return (
    <header className="topbar">
      <button className="btn ghost icon only-narrow" onClick={onMenu} aria-label="Toggle sidebar"><MenuIcon size={18} /></button>
      <div className="brand">
        <span className="brand-mark"><img src="/favicon.svg" width={18} height={18} alt="" /></span>
        <span className="hide-narrow">Core Vision <small>Studio</small></span>
      </div>

      <Menu trigger={(_, toggle) => (
        <button className="btn ghost" onClick={toggle} style={{ maxWidth: 260 }}>
          <FolderOpen size={15} /><span className="ellipsis">{project?.name ?? 'No project'}</span><ChevronDown size={14} />
        </button>
      )}>
        {close => (
          <>
            {projects.map(p => (
              <button key={p.id} onClick={() => { close(); openProject(p.id); }}>
                <span className="grow ellipsis">{p.name}</span><span className="mu tiny">{p.holes} holes</span>
              </button>
            ))}
            {projects.length > 0 && <hr />}
            <button onClick={() => { close(); setCreating(true); }}><Plus size={15} />New project</button>
          </>
        )}
      </Menu>

      {project && (
        <nav className="nav">
          <button className={view === 'log' ? 'on' : ''} onClick={() => navigate({ view: 'overview' })}><LayoutDashboard size={14} /><span className="hide-narrow">Logging</span></button>
          <button className={view === 'model' ? 'on' : ''} onClick={() => navigate({ view: 'model' })}><Box size={14} /><span className="hide-narrow">3D model</span></button>
        </nav>
      )}
      <span className="grow" />

      <span className={'badge hide-narrow ' + (health?.ai_configured ? 'ok' : 'warn')} title={health?.ai_configured ? `${health.model} · effort ${health.effort}` : 'Set ANTHROPIC_API_KEY in .env and restart the server'}>
        <Sparkles size={12} />{health?.ai_configured ? health.model : 'AI off'}
      </span>

      {project && (
        <Menu align="right" trigger={(_, toggle) => <button className="btn" onClick={toggle}><Download size={15} /><span className="hide-narrow">Export</span></button>}>
          {close => (
            <>
              {[['lithlog.csv', 'Interval log (CSV)'], ['collars.csv', 'Collars (CSV)'], ['surveys.csv', 'Surveys (CSV)'], ['assays.csv', 'Assays (CSV)'],
                ['geotech.csv', 'Geotech: RQD, recovery, FF (CSV)'], ['intervals.csv', 'Photo features (CSV)'], ['project.json', 'Full project (JSON)']].map(([k, l]) => (
                <button key={k} onClick={() => { close(); location.href = api.exportUrl(project.id, k); }}>{l}</button>
              ))}
            </>
          )}
        </Menu>
      )}
      {creating && <NewProject onClose={() => setCreating(false)} />}
    </header>
  );
}

export function NewProject({ onClose }: { onClose: () => void }) {
  const { createProject, health } = useStore();
  const [name, setName] = useState('');
  const [dep, setDep] = useState('');
  const submit = async () => { if (!name.trim()) return; await createProject(name.trim(), dep); onClose(); };
  return (
    <Modal title="New project" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!name.trim()} onClick={submit}>Create project</button></>}>
      <Field label="Name"><input className="input" autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} placeholder="e.g. Kumasi North" /></Field>
      <Field label="Deposit style (guides the AI logging)">
        <select className="input" value={dep} onChange={e => setDep(e.target.value)}>
          <option value="">Open / unknown</option>
          {health?.deposit_styles.map(d => <option key={d}>{d}</option>)}
        </select>
      </Field>
    </Modal>
  );
}
