import { lazy, Suspense, useEffect, useState } from 'react';
import { useStore } from './store';
import TopBar from './components/TopBar';
import Sidebar from './components/Sidebar';
import Toasts from './components/Toasts';
import Overview from './views/Overview';
import HoleView from './views/HoleView';
import ImageEditor from './views/ImageEditor';

// three.js is large; load the 3D view only when it is opened.
const Scene3D = lazy(() => import('./views/Scene3D'));

export default function App() {
  const { init, route, project, loading } = useStore();
  const [sideOpen, setSideOpen] = useState(false);
  useEffect(() => { init(); }, [init]);
  useEffect(() => setSideOpen(false), [route]);

  let content;
  if (loading) content = <div className="page mu">Loading…</div>;
  else if (!project || route.view === 'overview') content = <Overview />;
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
