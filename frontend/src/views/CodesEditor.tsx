import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useStore } from '../store';
import { api, type CodeField, type LoggingCode } from '../api';

const FIELDS: CodeField[] = ['lithology', 'alteration', 'mineralization'];

/** Project logging dictionary. The AI labels with these codes and the interval log offers them. */
export default function CodesEditor() {
  const { project, toast } = useStore();
  const [codes, setCodes] = useState<LoggingCode[]>([]);
  const [saved, setSaved] = useState('[]');
  const [field, setField] = useState<CodeField>('lithology');
  useEffect(() => { if (project) api.codes(project.id).then(c => { setCodes(c); setSaved(JSON.stringify(c)); }).catch(() => {}); }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!project) return null;
  const dirty = JSON.stringify(codes) !== saved;
  const list = codes.map((c, i) => ({ c, i })).filter(x => x.c.field === field);
  const upd = (i: number, p: Partial<LoggingCode>) => setCodes(codes.map((c, k) => (k === i ? { ...c, ...p } : c)));
  const save = async () => {
    try {
      const out = await api.putCodes(project.id, codes.filter(c => c.code.trim()));
      setCodes(out); setSaved(JSON.stringify(out)); toast(`Saved ${out.length} logging codes`);
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const loadDefaults = async () => {
    const d = await api.defaultCodes();
    const have = new Set(codes.map(c => c.field + ':' + c.code.toUpperCase()));
    setCodes([...codes, ...d.filter(c => !have.has(c.field + ':' + c.code))]);
  };
  return (
    <div className="card">
      <div className="card-h"><h3 className="grow">Logging codes</h3>
        {dirty && <button className="btn ghost sm" onClick={() => setCodes(JSON.parse(saved))}>Discard</button>}
        <button className="btn sm primary" disabled={!dirty} onClick={save}>Save</button>
      </div>
      <div className="seg" style={{ marginBottom: 10 }}>
        {FIELDS.map(f => <button key={f} className={field === f ? 'on' : ''} onClick={() => setField(f)}>{f} <span className="mu">{codes.filter(c => c.field === f).length}</span></button>)}
      </div>
      <div style={{ maxHeight: 240, overflow: 'auto' }}>
        {list.map(({ c, i }) => (
          <div key={i} className="survey-row" style={{ gridTemplateColumns: '90px 1fr 30px' }}>
            <input className="input sm mono" value={c.code} onChange={e => upd(i, { code: e.target.value.toUpperCase() })} />
            <input className="input sm" value={c.description} onChange={e => upd(i, { description: e.target.value })} placeholder="description" />
            <button className="btn ghost sm icon" onClick={() => setCodes(codes.filter((_, k) => k !== i))} aria-label="Remove code"><X size={13} /></button>
          </div>
        ))}
        {!list.length && <div className="mu tiny" style={{ marginBottom: 8 }}>No {field} codes.</div>}
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn sm" onClick={() => setCodes([...codes, { field, code: '', description: '' }])}><Plus size={13} />Code</button>
        <button className="btn ghost sm" onClick={loadDefaults}>Add standard codes</button>
      </div>
      <div className="mu tiny" style={{ marginTop: 8 }}>The AI is asked to label features with these codes, and the interval log suggests them.</div>
    </div>
  );
}
