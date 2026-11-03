import { create } from 'zustand';
import { api, setUnauthorizedHandler } from './api';
import type { CoreBreak, CoreImage, Direction, Feature, Geotech, Health, Hole, HoleInput, ImagePatch, Project, ProjectSummary, Survey, User } from './api';
import { BUSY } from './lib/geo';

export type Route =
  | { view: 'overview' }
  | { view: 'hole'; holeId: string }
  | { view: 'image'; holeId: string; imageId: string }
  | { view: 'model' }
  | { view: 'users' };

export type AuthState = 'checking' | 'setup' | 'login' | 'ready';

export interface Toast { id: number; text: string; kind: 'info' | 'error' }

interface State {
  health: Health | null;
  projects: ProjectSummary[];
  project: Project | null;
  route: Route;
  toasts: Toast[];
  loading: boolean;
  auth: AuthState;
  user: User | null;
  orgName: string;
  setupTokenRequired: boolean;
  signedIn(user: User, orgName: string): Promise<void>;
  signOut(): Promise<void>;
  setOrgName(name: string): void;
  history: Record<string, { u: string[]; r: string[] }>;
  geotech: Record<string, Geotech>;
  /** Bumped whenever logged data changes, so derived panels (interval log, geotech, assays) refetch. */
  dataVersion: number;

  init(): Promise<void>;
  loadApp(): Promise<void>;
  navigate(r: Route): void;
  toast(text: string, kind?: Toast['kind']): void;
  dismiss(id: number): void;

  openProject(id: string | null, keepRoute?: boolean): Promise<void>;
  reload(): Promise<void>;
  createProject(name: string, deposit: string): Promise<void>;
  patchProject(body: Partial<Pick<Project, 'name' | 'deposit_style' | 'crs_epsg'>>): Promise<void>;
  deleteProject(): Promise<void>;
  importCsv(kind: 'collars' | 'surveys' | 'assays', file: File): Promise<void>;

  createHole(body: HoleInput): Promise<Hole | undefined>;
  patchHole(id: string, body: Partial<HoleInput>): Promise<void>;
  deleteHole(id: string): Promise<void>;
  saveSurveys(id: string, s: Survey[]): Promise<void>;

  upload(holeId: string, file: File, from: string, to: string, dir: Direction, analyze: boolean): Promise<CoreImage | undefined>;
  patchImage(id: string, body: ImagePatch): Promise<void>;
  setBreaks(imageId: string, fn: (b: CoreBreak[]) => CoreBreak[]): void;
  loadGeotech(imageId: string): Promise<void>;
  bump(): void;
  deleteImage(id: string): Promise<void>;
  analyze(id: string): Promise<void>;

  setFeatures(imageId: string, fn: (f: Feature[]) => Feature[], snapshot?: boolean): void;
  snapshot(imageId: string): void;
  dropSnapshot(imageId: string): void;
  undo(imageId: string): void;
  redo(imageId: string): void;
}

/* ---------- immutable helpers ---------- */
const mapHoles = (p: Project, fn: (h: Hole) => Hole): Project => ({ ...p, holes: p.holes.map(fn) });
const mapImage = (p: Project, imageId: string, fn: (im: CoreImage) => CoreImage): Project =>
  mapHoles(p, h => (h.images.some(i => i.id === imageId) ? { ...h, images: h.images.map(i => (i.id === imageId ? fn(i) : i)) } : h));
export const findImage = (p: Project | null, id: string) => {
  for (const h of p?.holes ?? []) for (const i of h.images) if (i.id === id) return i;
  return undefined;
};
const sortImages = (a: CoreImage, b: CoreImage) => (a.from_m ?? 1e12) - (b.from_m ?? 1e12);

/* ---------- debounced feature sync ---------- */
const timers: Record<string, ReturnType<typeof setTimeout>> = {};
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let toastSeq = 0;

export const useStore = create<State>((set, get) => {
  const fail = (e: unknown) => get().toast(e instanceof Error ? e.message : String(e), 'error');
  const safe = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R | undefined> => {
    try { return await fn(...a); } catch (e) { fail(e); return undefined; }
  };

  const sync = async (imageId: string) => {
    delete timers[imageId];
    const im = findImage(get().project, imageId);
    if (!im) return;
    try {
      const out = await api.syncFeatures(imageId, im.features.map(({ from_m: _a, to_m: _b, ...f }) => f));
      const byId = new Map(out.map(f => [f.id, f]));
      set(s => s.project ? {
        dataVersion: s.dataVersion + 1,
        project: mapImage(s.project, imageId, i => ({
          ...i, features: i.features.map(f => { const o = byId.get(f.id); return o ? { ...f, from_m: o.from_m, to_m: o.to_m, closed: o.closed } : f; }),
        })),
      } : {});
    } catch (e) { fail(new Error('Save failed: ' + (e as Error).message)); }
  };
  const breakTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  const syncBreaks = async (imageId: string) => {
    delete breakTimers[imageId];
    const im = findImage(get().project, imageId);
    if (!im) return;
    try {
      const out = await api.putBreaks(imageId, im.breaks.map(({ depth_m: _d, ...b }) => b));
      const byId = new Map(out.breaks.map(b => [b.id, b]));
      set(s => ({
        dataVersion: s.dataVersion + 1, geotech: { ...s.geotech, [imageId]: out.geotech },
        project: s.project && mapImage(s.project, imageId, i => ({ ...i, breaks: i.breaks.map(b => ({ ...b, depth_m: byId.get(b.id)?.depth_m ?? b.depth_m })) })),
      }));
    } catch (e) { fail(new Error('Saving breaks failed: ' + (e as Error).message)); }
  };
  const scheduleSync = (imageId: string) => {
    clearTimeout(timers[imageId]);
    timers[imageId] = setTimeout(() => sync(imageId), 450);
  };
  window.addEventListener('beforeunload', () => Object.keys(timers).forEach(id => sync(id)));

  const replaceImage = (img: CoreImage) =>
    set(s => (s.project ? { project: mapImage(s.project, img.id, () => img) } : {}));

  const poll = () => {
    clearTimeout(pollTimer);
    const busy = (get().project?.holes ?? []).flatMap(h => h.images).filter(i => BUSY(i.status));
    if (!busy.length) return;
    pollTimer = setTimeout(async () => {
      for (const im of busy) {
        try {
          const f = await api.image(im.id);
          if (f.status !== im.status) {
            replaceImage(f);
            get().bump(); get().loadGeotech(f.id);
            if (f.status === 'error') get().toast('Analysis failed: ' + f.error, 'error');
            if (f.status === 'done') get().toast(`Logged ${f.name}: ${f.features.length} features`);
          }
        } catch { /* retry next tick */ }
      }
      poll();
    }, 2500);
  };

  return {
    health: null, projects: [], project: null, route: { view: 'overview' }, toasts: [], loading: true, history: {}, geotech: {}, dataVersion: 0,
    auth: 'checking', user: null, orgName: '', setupTokenRequired: false,

    async init() {
      setUnauthorizedHandler(() => {
        if (get().auth === 'ready') { set({ auth: 'login', user: null, project: null, projects: [] }); get().toast('Your session ended. Sign in again.', 'error'); }
      });
      try {
        const st = await api.authStatus();
        set({ orgName: st.org_name, setupTokenRequired: st.setup_token_required });
        if (st.setup_required) { set({ auth: 'setup', loading: false }); return; }
        if (!st.user) { set({ auth: 'login', loading: false }); return; }
        set({ user: st.user, auth: 'ready' });
      } catch (e) { fail(new Error('Cannot reach the server: ' + (e as Error).message)); set({ auth: 'login', loading: false }); return; }
      await get().loadApp();
    },
    async signedIn(user, orgName) {
      set({ user, orgName, auth: 'ready', loading: true, route: { view: 'overview' } });
      await get().loadApp();
    },
    async signOut() {
      try { await api.logout(); } catch { /* already signed out */ }
      set({ auth: 'login', user: null, project: null, projects: [], route: { view: 'overview' }, history: {}, geotech: {} });
    },
    setOrgName(name) { set({ orgName: name }); },
    async loadApp() {
      try { set({ health: await api.health() }); } catch { set({ health: null }); }
      try {
        const projects = await api.projects();
        set({ projects });
        let last: string | null = null;
        try { last = localStorage.getItem('cv.project'); } catch { /* storage blocked */ }
        await get().openProject((projects.find(p => p.id === last) ?? projects[0])?.id ?? null);
      } catch (e) { fail(new Error('Cannot reach the server: ' + (e as Error).message)); }
      set({ loading: false });
    },

    navigate(route) { set({ route }); },
    toast(text, kind = 'info') {
      const id = ++toastSeq;
      set(s => ({ toasts: [...s.toasts, { id, text, kind }] }));
      setTimeout(() => get().dismiss(id), kind === 'error' ? 7000 : 3500);
    },
    dismiss(id) { set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })); },

    openProject: safe(async (id: string | null, keepRoute = false) => {
      if (!id) { set({ project: null, route: { view: 'overview' } }); return; }
      const project = await api.project(id);
      project.holes.forEach(h => h.images.sort(sortImages));
      const r = get().route;
      let route: Route = { view: 'overview' };
      if (keepRoute) {
        if (r.view === 'model') route = r;
        else if ('holeId' in r && project.holes.some(h => h.id === r.holeId)) route = r.view === 'image' && !findImage(project, r.imageId) ? { view: 'hole', holeId: r.holeId } : r;
      }
      set({ project, route });
      try { localStorage.setItem('cv.project', id); } catch { /* storage blocked */ }
      poll();
    }),
    async reload() { const p = get().project; if (p) await get().openProject(p.id, true); },

    createProject: safe(async (name: string, deposit: string) => {
      const p = await api.createProject(name, deposit);
      set({ projects: await api.projects() });
      await get().openProject(p.id);
    }),
    patchProject: safe(async body => {
      const p = get().project; if (!p) return;
      set({ project: { ...p, ...body } });
      await api.patchProject(p.id, body);
      set({ projects: await api.projects() });
    }),
    deleteProject: safe(async () => {
      const p = get().project; if (!p) return;
      await api.deleteProject(p.id);
      const projects = await api.projects();
      set({ projects, project: null });
      await get().openProject(projects[0]?.id ?? null);
    }),
    importCsv: safe(async (kind: 'collars' | 'surveys' | 'assays', file: File) => {
      const p = get().project; if (!p) return;
      const r = await api.importCsv(p.id, kind, file);
      const head = kind === 'collars' ? `Collars: ${r.created} new, ${r.updated} updated`
        : kind === 'surveys' ? `Surveys loaded for ${r.holes} hole(s)`
          : `Assays: ${r.values} values for ${r.elements?.join(', ')} in ${r.holes} hole(s)`;
      get().toast(head + (r.errors.length ? ` · ${r.errors.length} issue(s): ${r.errors.slice(0, 3).join('; ')}` : ''), r.errors.length ? 'error' : 'info');
      await get().reload();
      get().bump();
    }),

    createHole: safe(async (body: HoleInput) => {
      const p = get().project; if (!p) return;
      const h = await api.createHole(p.id, body);
      set(s => (s.project ? { project: { ...s.project, holes: [...s.project.holes, h] }, route: { view: 'hole', holeId: h.id } } : {}));
      return h;
    }),
    patchHole: safe(async (id: string, body: Partial<HoleInput>) => {
      const h = await api.patchHole(id, body);
      set(s => (s.project ? { project: mapHoles(s.project, x => (x.id === id ? { ...x, ...h, surveys: x.surveys, images: x.images } : x)) } : {}));
      get().toast('Hole saved');
    }),
    deleteHole: safe(async (id: string) => {
      await api.deleteHole(id);
      set(s => (s.project ? { project: { ...s.project, holes: s.project.holes.filter(h => h.id !== id) }, route: { view: 'overview' } } : {}));
    }),
    saveSurveys: safe(async (id: string, sv: Survey[]) => {
      const surveys = await api.putSurveys(id, sv);
      set(s => (s.project ? { project: mapHoles(s.project, h => (h.id === id ? { ...h, surveys } : h)) } : {}));
      get().toast(`Survey saved (${surveys.length} stations)`);
    }),

    upload: safe(async (holeId: string, file: File, from: string, to: string, dir: Direction, analyze: boolean) => {
      const im = await api.uploadImage(holeId, file, from, to, dir, analyze);
      set(s => (s.project ? { project: mapHoles(s.project, h => (h.id === holeId ? { ...h, images: [...h.images, im].sort(sortImages) } : h)) } : {}));
      poll();
      return im;
    }),
    patchImage: safe(async (id: string, body: ImagePatch) => {
      const out = await api.patchImage(id, body);
      const byId = new Map(out.features.map(f => [f.id, f]));
      const bById = new Map(out.breaks.map(b => [b.id, b]));
      set(s => (s.project ? {
        dataVersion: s.dataVersion + 1,
        project: mapImage(s.project, id, i => ({
          ...i, from_m: out.from_m, to_m: out.to_m, direction: out.direction, core_boxes: out.core_boxes, scale_px_per_mm: out.scale_px_per_mm,
          features: i.features.map(f => { const o = byId.get(f.id); return o ? { ...f, from_m: o.from_m, to_m: o.to_m } : f; }),
          breaks: i.breaks.map(b => ({ ...b, depth_m: bById.get(b.id)?.depth_m ?? b.depth_m })),
        })),
      } : {}));
      await get().loadGeotech(id);
    }),
    setBreaks(imageId, fn) {
      set(s => (s.project ? { project: mapImage(s.project, imageId, i => ({ ...i, breaks: fn(i.breaks) })) } : {}));
      clearTimeout(breakTimers[imageId]);
      breakTimers[imageId] = setTimeout(() => syncBreaks(imageId), 400);
    },
    async loadGeotech(imageId) {
      try { const g = await api.imageGeotech(imageId); set(s => ({ geotech: { ...s.geotech, [imageId]: g } })); } catch { /* shown elsewhere */ }
    },
    bump() { set(s => ({ dataVersion: s.dataVersion + 1 })); },
    deleteImage: safe(async (id: string) => {
      const holeId = get().project?.holes.find(h => h.images.some(i => i.id === id))?.id;
      await api.deleteImage(id);
      set(s => (s.project ? {
        project: mapHoles(s.project, h => ({ ...h, images: h.images.filter(i => i.id !== id) })),
        route: holeId ? { view: 'hole', holeId } : { view: 'overview' },
      } : {}));
    }),
    analyze: safe(async (id: string) => {
      if (!get().health?.ai_configured) { get().toast('AI is off: set ANTHROPIC_API_KEY in .env and restart the server.', 'error'); return; }
      clearTimeout(timers[id]); await sync(id);
      replaceImage(await api.analyze(id));
      poll();
    }),

    setFeatures(imageId, fn, snapshot = false) {
      if (snapshot) get().snapshot(imageId);
      set(s => (s.project ? { project: mapImage(s.project, imageId, i => ({ ...i, features: fn(i.features) })) } : {}));
      scheduleSync(imageId);
    },
    snapshot(imageId) {
      const im = findImage(get().project, imageId); if (!im) return;
      set(s => {
        const h = s.history[imageId] ?? { u: [], r: [] };
        return { history: { ...s.history, [imageId]: { u: [...h.u, JSON.stringify(im.features)].slice(-100), r: [] } } };
      });
    },
    dropSnapshot(imageId) {
      set(s => {
        const h = s.history[imageId]; if (!h) return {};
        return { history: { ...s.history, [imageId]: { ...h, u: h.u.slice(0, -1) } } };
      });
    },
    undo(imageId) {
      const h = get().history[imageId], im = findImage(get().project, imageId);
      if (!h?.u.length || !im) return;
      const prev = h.u[h.u.length - 1];
      set(s => ({
        history: { ...s.history, [imageId]: { u: h.u.slice(0, -1), r: [...h.r, JSON.stringify(im.features)] } },
        project: s.project && mapImage(s.project, imageId, i => ({ ...i, features: JSON.parse(prev) })),
      }));
      scheduleSync(imageId);
    },
    redo(imageId) {
      const h = get().history[imageId], im = findImage(get().project, imageId);
      if (!h?.r.length || !im) return;
      const next = h.r[h.r.length - 1];
      set(s => ({
        history: { ...s.history, [imageId]: { u: [...h.u, JSON.stringify(im.features)], r: h.r.slice(0, -1) } },
        project: s.project && mapImage(s.project, imageId, i => ({ ...i, features: JSON.parse(next) })),
      }));
      scheduleSync(imageId);
    },
  };
});

/** Viewers are read-only; the server enforces this, the UI just hides the editing tools. */
export const useCanEdit = () => useStore(s => s.user?.role === 'admin' || s.user?.role === 'geologist');
export const useIsAdmin = () => useStore(s => s.user?.role === 'admin');
