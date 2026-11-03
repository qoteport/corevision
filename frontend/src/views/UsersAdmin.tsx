import { useEffect, useState } from 'react';
import { Copy, KeyRound, Plus, Trash2, UserPlus } from 'lucide-react';
import { useStore } from '../store';
import { api, type Role, type User } from '../api';
import { CommitInput, Field, Modal } from '../components/ui';

export const ROLE_INFO: Record<Role, string> = {
  admin: 'Everything, including users and deleting projects',
  geologist: 'Log, annotate, import and edit data',
  viewer: 'Read and export only',
};

/** A readable temporary password the admin passes on; the user changes it after signing in. */
function tempPassword() {
  const words = ['core', 'tray', 'vein', 'pyrite', 'quartz', 'basalt', 'schist', 'collar', 'assay', 'drill', 'gneiss', 'skarn'];
  const r = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  return `${words[r(words.length)]}-${words[r(words.length)]}-${words[r(words.length)]}-${100 + r(900)}`;
}

const when = (t: number | null) => (t ? new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export default function UsersAdmin() {
  const { user: me, orgName, setOrgName, toast, navigate } = useStore();
  const [users, setUsers] = useState<User[]>([]);
  const [adding, setAdding] = useState(false);
  const [reset, setReset] = useState<{ user: User; password: string } | null>(null);
  const load = () => api.users().then(setUsers).catch(e => toast(e.message, 'error'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const upd = async (u: User, b: Parameters<typeof api.updateUser>[1]) => {
    try { await api.updateUser(u.id, b); await load(); } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow"><div className="crumbs"><button onClick={() => navigate({ view: 'overview' })}>Overview</button>/<span>Organization</span></div><h1>Users</h1></div>
        <button className="btn primary" onClick={() => setAdding(true)}><UserPlus size={15} />Add user</button>
      </div>
      <div className="cols">
        <div className="card">
          <div className="card-h"><h3 className="grow">People · {users.filter(u => u.active).length} active</h3></div>
          <table className="t">
            <thead><tr><th>Name</th><th>Role</th><th>Last sign-in</th><th>Status</th><th /></tr></thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} style={u.active ? undefined : { opacity: 0.55 }}>
                  <td><b>{u.name}</b>{u.id === me?.id && <span className="badge" style={{ marginLeft: 6 }}>you</span>}<div className="mu tiny">{u.email}</div></td>
                  <td>
                    <select className="input sm" style={{ width: 'auto' }} value={u.role} disabled={u.id === me?.id} title={u.id === me?.id ? "You can't change your own role" : ROLE_INFO[u.role]}
                      onChange={e => upd(u, { role: e.target.value as Role })}>
                      {(Object.keys(ROLE_INFO) as Role[]).map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td className="mu tiny">{when(u.last_login_at)}</td>
                  <td>
                    <label className="check" title={u.id === me?.id ? "You can't disable yourself" : ''}>
                      <input type="checkbox" checked={u.active} disabled={u.id === me?.id} onChange={e => upd(u, { active: e.target.checked })} />{u.active ? 'active' : 'disabled'}
                    </label>
                  </td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 2 }}>
                      {u.id !== me?.id && <button className="btn ghost sm" title="Reset password" onClick={async () => {
                        const pw = tempPassword();
                        try { await api.updateUser(u.id, { password: pw }); setReset({ user: u, password: pw }); } catch (e) { toast((e as Error).message, 'error'); }
                      }}><KeyRound size={13} />Reset</button>}
                      {u.id !== me?.id && <button className="btn ghost sm icon danger" aria-label={`Delete ${u.name}`} title="Delete user"
                        onClick={async () => { if (confirm(`Delete ${u.name}? Their past edits keep their name in the history.`)) { try { await api.deleteUser(u.id); await load(); } catch (e) { toast((e as Error).message, 'error'); } } }}><Trash2 size={14} /></button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mu tiny" style={{ marginTop: 10 }}>Changing someone's role, disabling them or resetting their password signs them out everywhere straight away.</div>
        </div>
        <div className="col">
          <div className="card">
            <div className="card-h"><h3>Organization</h3></div>
            <Field label="Name shown on the sign-in screen">
              <CommitInput value={orgName} onCommit={async v => { if (!v.trim()) return; try { const r = await api.patchOrg(v.trim()); setOrgName(r.name); toast('Organization renamed'); } catch (e) { toast((e as Error).message, 'error'); } }} />
            </Field>
          </div>
          <div className="card">
            <div className="card-h"><h3>Roles</h3></div>
            {(Object.entries(ROLE_INFO) as [Role, string][]).map(([r, d]) => <div key={r} className="row tiny" style={{ marginBottom: 6, alignItems: 'baseline' }}><span className="badge" style={{ width: 74, justifyContent: 'center' }}>{r}</span><span className="ink2">{d}</span></div>)}
          </div>
        </div>
      </div>
      {adding && <AddUser onClose={() => setAdding(false)} onAdded={(u, pw) => { setAdding(false); load(); setReset({ user: u, password: pw }); }} />}
      {reset && <PasswordNote user={reset.user} password={reset.password} onClose={() => setReset(null)} />}
    </div>
  );
}

function AddUser({ onClose, onAdded }: { onClose: () => void; onAdded: (u: User, pw: string) => void }) {
  const toast = useStore(s => s.toast);
  const [f, setF] = useState({ name: '', email: '', role: 'geologist' as Role });
  const [pw] = useState(tempPassword);
  const submit = async () => {
    try { const u = await api.createUser({ ...f, password: pw }); onAdded(u, pw); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <Modal title="Add user" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!f.name.trim() || !f.email.trim()} onClick={submit}><Plus size={14} />Add user</button></>}>
      <div className="grid2">
        <Field label="Name"><input className="input" autoFocus value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email"><input className="input" type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
      </div>
      <Field label="Role">
        <select className="input" value={f.role} onChange={e => setF({ ...f, role: e.target.value as Role })}>
          {(Object.entries(ROLE_INFO) as [Role, string][]).map(([r, d]) => <option key={r} value={r}>{r} — {d}</option>)}
        </select>
      </Field>
      <div className="mu tiny">A temporary password is created for them. You'll see it once on the next screen to pass on; they can change it after signing in.</div>
    </Modal>
  );
}

function PasswordNote({ user, password, onClose }: { user: User; password: string; onClose: () => void }) {
  const toast = useStore(s => s.toast);
  return (
    <Modal title={`Temporary password for ${user.name}`} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <div className="mu tiny">Give this to {user.email} securely (not by public chat). It's shown only now. They should change it under their name → Change password.</div>
      <div className="row"><code className="mono grow" style={{ padding: '10px 12px', background: 'var(--bg2)', border: '1px solid var(--line2)', borderRadius: 8, fontSize: 15 }}>{password}</code>
        <button className="btn" onClick={() => { navigator.clipboard?.writeText(password).then(() => toast('Copied')); }}><Copy size={14} />Copy</button></div>
    </Modal>
  );
}
