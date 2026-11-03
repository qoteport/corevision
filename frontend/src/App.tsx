import { lazy, Suspense, useEffect, useState } from 'react';
import { useStore } from './store';
import TopBar from './components/TopBar';
import Sidebar from './components/Sidebar';
import Toasts from './components/Toasts';
import Overview from './views/Overview';
import HoleView from './views/HoleView';
import ImageEditor from './views/ImageEditor';
import UsersAdmin from './views/UsersAdmin';
import { LoginScreen, SetupScreen } from './views/AuthScreens';

// three.js is large; load the 3D view only when it is opened.
const Scene3D = lazy(() => import('./views/Scene3D'));

export default function App() {
  const { init, route, project, loading, auth, user } = useStore();
  const [sideOpen, setSideOpen] = useState(false);
  useEffect(() => { init(); }, [init]);
  useEffect(() => setSideOpen(false), [route]);

  if (auth === 'checking') return <><div className="auth-wrap mu">Loading…</div><Toasts /></>;
  if (auth === 'setup') return <><SetupScreen /><Toasts /></>;
  if (auth === 'login') return <><LoginScreen /><Toasts /></>;

  let content;
  if (loading) content = <div className="page mu">Loading…</div>;
  else if (route.view === 'users' && user?.role === 'admin') content = <UsersAdmin />;
  else if (!project || route.view === 'overview' || route.view === 'users') content = <Overview />;
  else if (route.view === 'hole') content = <HoleView holeId={route.holeId} />;
  else if (route.view === 'image') content = <ImageEditor holeId={route.holeId} imageId={route.imageId} />;
  else content = <Suspense fallback={<div className="page mu">Loading 3D…</div>}><Scene3D /></Suspense>;

  return (
    <div className="shell">
      <TopBar onMenu={() => setSideOpen(o => !o)} />
      <div className="body">
        <Sidebar open={sideOpen} />
        <main className="main">{content}</main>
      </div>
      <Toasts />
    </div>
  );
}
