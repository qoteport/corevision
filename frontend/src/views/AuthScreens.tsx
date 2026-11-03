import { useState } from 'react';
import { KeyRound, LogIn, ShieldCheck } from 'lucide-react';
import { useStore } from '../store';
import { api } from '../api';
import { Field } from '../components/ui';

const MIN = 10;

function Shell({ children, sub }: { children: React.ReactNode; sub?: string }) {
  const orgName = useStore(s => s.orgName);
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="row" style={{ gap: 10, marginBottom: 4 }}>
          <span className="brand-mark"><img src="/favicon.svg" width={18} height={18} alt="" /></span>
          <div><div style={{ fontWeight: 700 }}>Core Vision <span className="mu" style={{ fontWeight: 500 }}>Studio</span></div>
            <div className="mu tiny">{sub ?? orgName ?? ''}</div></div>
        </div>
        {children}
      </div>
    </div>
  );
}

export function LoginScreen() {
  const { signedIn } = useStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try { const r = await api.login(email, password); await signedIn(r.user, r.org_name); }
    catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  return (
    <Shell>
      <form className="col" onSubmit={submit}>
        <h2 style={{ fontSize: 18 }}>Sign in</h2>
        <Field label="Email"><input className="input" type="email" autoComplete="username" autoFocus required value={email} onChange={e => setEmail(e.target.value)} /></Field>
        <Field label="Password"><input className="input" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></Field>
        {err && <div className="err tiny">{err}</div>}
        <button className="btn primary" disabled={busy || !email || !password}><LogIn size={15} />{busy ? 'Signing in…' : 'Sign in'}</button>
        <div className="mu tiny">Forgot your password? Ask an admin in your organization to reset it.</div>
      </form>
    </Shell>
  );
}

export function SetupScreen() {
  const { signedIn, setupTokenRequired } = useStore();
  const [f, setF] = useState({ org_name: '', name: '', email: '', password: '', confirm: '', setup_token: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const problem = f.password && f.password.length < MIN ? `At least ${MIN} characters.` : f.confirm && f.confirm !== f.password ? 'Passwords do not match.' : null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    if (problem) return;
    setBusy(true);
    try {
      const r = await api.setup({ org_name: f.org_name, name: f.name, email: f.email, password: f.password, setup_token: f.setup_token || undefined });
      await signedIn(r.user, r.org_name);
    } catch (x) { setErr((x as Error).message); setBusy(false); }
  };
  return (
    <Shell sub="First-time setup">
      <form className="col" onSubmit={submit}>
        <div>
          <h2 style={{ fontSize: 18 }}>Set up your organization</h2>
          <p className="mu tiny" style={{ margin: '4px 0 0' }}>This deployment belongs to one organization. You'll be its first admin and can invite colleagues afterwards.</p>
        </div>
        <Field label="Organization name"><input className="input" required autoFocus value={f.org_name} onChange={set('org_name')} placeholder="e.g. Kumasi Exploration Ltd" /></Field>
        <div className="grid2">
          <Field label="Your name"><input className="input" required autoComplete="name" value={f.name} onChange={set('name')} /></Field>
          <Field label="Email"><input className="input" type="email" required autoComplete="username" value={f.email} onChange={set('email')} /></Field>
        </div>
        <div className="grid2">
          <Field label={`Password (min ${MIN})`}><input className="input" type="password" required autoComplete="new-password" value={f.password} onChange={set('password')} /></Field>
          <Field label="Confirm password"><input className="input" type="password" required autoComplete="new-password" value={f.confirm} onChange={set('confirm')} /></Field>
        </div>
        {setupTokenRequired && (
          <Field label="Setup token (from the person who deployed this app)">
            <input className="input mono" required value={f.setup_token} onChange={set('setup_token')} />
          </Field>
        )}
        {(problem || err) && <div className="err tiny">{problem || err}</div>}
        <button className="btn primary" disabled={busy || !!problem}><ShieldCheck size={15} />{busy ? 'Setting up…' : 'Create organization'}</button>
      </form>
    </Shell>
  );
}

export function ChangePassword({ onClose }: { onClose: () => void }) {
  const toast = useStore(s => s.toast);
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const problem = pw && pw.length < MIN ? `At least ${MIN} characters.` : pw2 && pw2 !== pw ? 'Passwords do not match.' : null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api.changePassword(cur, pw); toast('Password changed. Other devices were signed out.'); onClose(); }
    catch (x) { setErr((x as Error).message); }
  };
  return (
    <form className="col" onSubmit={submit}>
      <Field label="Current password"><input className="input" type="password" autoComplete="current-password" autoFocus value={cur} onChange={e => setCur(e.target.value)} /></Field>
      <Field label={`New password (min ${MIN})`}><input className="input" type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} /></Field>
      <Field label="Confirm new password"><input className="input" type="password" autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} /></Field>
      {(problem || err) && <div className="err tiny">{problem || err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!cur || !pw || !!problem}><KeyRound size={14} />Change password</button>
      </div>
    </form>
  );
}
