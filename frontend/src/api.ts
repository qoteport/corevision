/* Typed client for the FastAPI backend. */

export type Category = 'mineralization' | 'alteration' | 'vein' | 'structure' | 'lithology';
export type Direction = 'lr' | 'rl' | 'tb' | 'bt';
export type ImageStatus = 'new' | 'queued' | 'analyzing' | 'done' | 'error';
export type Pt = [number, number];

export interface Feature {
  id: string;
  label: string;
  category: Category;
  confidence: number;
  closed: boolean;
  pts: Pt[];
  source: 'ai' | 'user' | 'sam';
  verified: boolean;
  from_m: number | null;
  to_m: number | null;
}

export interface Analysis {
  core_boxes: number[][];
  headline: string;
  kpi: { sulphide_pct: number; vein_pct: number; alteration_score: number; prospectivity: number };
  minerals: { name: string; pct: number; conf: number; style: string }[];
  lithology: { unit: string; pct: number }[];
}

export interface CoreImage {
  id: string;
  hole_id: string;
  name: string;
  from_m: number | null;
  to_m: number | null;
  direction: Direction;
  width_px: number;
  height_px: number;
  status: ImageStatus;
  error: string | null;
  analysis: Analysis | null;
  model: string | null;
  features: Feature[];
  breaks: CoreBreak[];
  core_boxes: number[][] | null;
  scale_px_per_mm: number | null;
}

export interface CoreBreak { id: string; x: number; y: number; natural: boolean; source: 'ai' | 'user'; depth_m: number | null }

export interface Geotech {
  rqd: number | null; recovery: number | null; ff: number | null; pieces: number; natural: number; mechanical: number;
  recovered_m: number | null; run_m: number | null; px_per_mm: number | null; scale_source: string | null; warnings: string[];
}
export interface GeotechRun extends Geotech { image_id: string; name: string; from_m: number; to_m: number }
export interface HoleGeotech {
  hole_id: string; core_size: string; runs: GeotechRun[];
  summary: { logged_m: number; rqd: number; recovery: number; ff: number; rock_quality: string } | null;
}

export type CodeField = 'lithology' | 'alteration' | 'mineralization';
export interface LoggingCode { field: CodeField; code: string; description: string }

export interface Interval {
  id?: string; from_m: number; to_m: number; lithology: string; alteration: string; alteration_intensity: number;
  mineralization: string; sulphide_pct: number; vein_pct: number; comments: string; source: 'auto' | 'user';
}
export interface QaIssue { type: 'gap' | 'unlogged' | 'eoh'; from_m: number; to_m: number; message: string }
export interface IntervalLog { rows: Interval[]; qa: QaIssue[] }

export interface Assay { id: number; hole_id: string; sample_id: string; from_m: number; to_m: number; element: string; value: number; unit: string; below_detection: number }
export interface ElementInfo { element: string; unit: string; n: number; max: number }
export interface Intercept {
  hole_id: string; hole: string; from_m: number; to_m: number; length: number; grade: number; metal: number;
  unit: string; metal_unit: string; text: string; includes: { from_m: number; to_m: number; length: number; grade: number; text: string }[];
}
export interface InterceptQuery { element: string; cutoff: number; max_dilution: number; min_length: number; incl_cutoff?: number }
export interface Calibration { element: string; n: number; r: number | null; points: { hole: string; from_m: number; to_m: number; assay: number; visual: number; source: 'log' | 'photo' }[] }

export interface Survey { depth: number; azimuth: number; dip: number }

export interface Hole {
  id: string;
  project_id: string;
  name: string;
  x: number; y: number; z: number;
  azimuth: number; dip: number; length: number;
  core_size: string;
  surveys: Survey[];
  images: CoreImage[];
}

export interface ProjectSummary { id: string; name: string; deposit_style: string; crs_epsg: number | null; holes: number }
export interface Project extends Omit<ProjectSummary, 'holes'> { holes: Hole[] }

export interface Health {
  ok: boolean; ai_configured: boolean; model: string; effort: string;
  categories: Category[]; deposit_styles: string[]; core_sizes: Record<string, number>;
}

export interface ModelHole {
  id: string; name: string; x: number; y: number; z: number; length: number; surveyed: boolean;
  path: { depth: number; x: number; y: number; z: number }[];
  intervals: { id: string; label: string; category: Category; confidence: number; from_m: number; to_m: number; verified: boolean; source: string }[];
  assays: { from_m: number; to_m: number; element: string; value: number; unit: string }[];
}

export type Role = 'admin' | 'geologist' | 'viewer';
export interface User { id: string; email: string; name: string; role: Role; active: boolean; created_at: number | null; last_login_at: number | null }
export interface AuthStatus { setup_required: boolean; setup_token_required: boolean; org_name: string; user: User | null }

/** Called when the server says the session is gone, so the app can show the sign-in screen. */
let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  // The custom header is required by the server on every write (CSRF protection).
  const headers: Record<string, string> = { 'X-Requested-With': 'corevision' };
  const init: RequestInit = { method, headers, credentials: 'same-origin' };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetch(path, init);
  if (r.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized?.();
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const j = await r.json();
      msg = typeof j.detail === 'string' ? j.detail : (j.detail || []).map((d: { msg: string }) => d.msg).join('; ') || msg;
    } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return (r.status === 204 ? null : await r.json()) as T;
}

export type HoleInput = Pick<Hole, 'name' | 'x' | 'y' | 'z' | 'azimuth' | 'dip' | 'length'> & { core_size?: string };
export interface ImagePatch {
  from_m?: number; to_m?: number; direction?: Direction; clear_from?: boolean; clear_to?: boolean;
  core_boxes?: number[][]; clear_boxes?: boolean; scale_px_per_mm?: number; clear_scale?: boolean;
}
export type FeatureInput = Omit<Feature, 'from_m' | 'to_m'>;

export const api = {
  authStatus: () => req<AuthStatus>('GET', '/api/auth/status'),
  setup: (b: { org_name: string; name: string; email: string; password: string; setup_token?: string }) =>
    req<{ user: User; org_name: string }>('POST', '/api/auth/setup', b),
  login: (email: string, password: string) => req<{ user: User; org_name: string }>('POST', '/api/auth/login', { email, password }),
  logout: () => req<{ ok: boolean }>('POST', '/api/auth/logout'),
  changePassword: (current_password: string, new_password: string) => req<{ ok: boolean }>('POST', '/api/auth/password', { current_password, new_password }),
  users: () => req<User[]>('GET', '/api/users'),
  createUser: (b: { email: string; name: string; role: Role; password: string }) => req<User>('POST', '/api/users', b),
  updateUser: (id: string, b: Partial<{ name: string; role: Role; active: boolean; password: string }>) => req<User>('PATCH', `/api/users/${id}`, b),
  deleteUser: (id: string) => req<null>('DELETE', `/api/users/${id}`),
  patchOrg: (name: string) => req<{ name: string }>('PATCH', '/api/org', { name }),
  health: () => req<Health>('GET', '/api/health'),
  projects: () => req<ProjectSummary[]>('GET', '/api/projects'),
  project: (id: string) => req<Project>('GET', `/api/projects/${id}`),
  createProject: (name: string, deposit_style = '') => req<Project>('POST', '/api/projects', { name, deposit_style }),
  patchProject: (id: string, body: Partial<Pick<Project, 'name' | 'deposit_style' | 'crs_epsg'>>) => req<Project>('PATCH', `/api/projects/${id}`, body),
  deleteProject: (id: string) => req<null>('DELETE', `/api/projects/${id}`),
  createHole: (pid: string, body: HoleInput) => req<Hole>('POST', `/api/projects/${pid}/holes`, body),
  patchHole: (id: string, body: Partial<HoleInput>) => req<Hole>('PATCH', `/api/holes/${id}`, body),
  deleteHole: (id: string) => req<null>('DELETE', `/api/holes/${id}`),
  putSurveys: (id: string, s: Survey[]) => req<Survey[]>('PUT', `/api/holes/${id}/surveys`, s),
  importCsv: (pid: string, kind: 'collars' | 'surveys' | 'assays', file: File) => {
    const fd = new FormData(); fd.append('file', file);
    return req<{ created?: number; updated?: number; holes?: number; values?: number; elements?: string[]; errors: string[] }>('POST', `/api/projects/${pid}/import/${kind}`, fd);
  },
  uploadImage: (hid: string, file: File, from_m: string, to_m: string, direction: Direction, analyze: boolean) => {
    const fd = new FormData();
    fd.append('file', file);
    if (from_m.trim()) fd.append('from_m', from_m.trim());
    if (to_m.trim()) fd.append('to_m', to_m.trim());
    fd.append('direction', direction);
    fd.append('analyze', String(analyze));
    return req<CoreImage>('POST', `/api/holes/${hid}/images`, fd);
  },
  image: (id: string) => req<CoreImage>('GET', `/api/images/${id}`),
  patchImage: (id: string, body: ImagePatch) =>
    req<CoreImage>('PATCH', `/api/images/${id}`, body),
  deleteImage: (id: string) => req<null>('DELETE', `/api/images/${id}`),
  analyze: (id: string) => req<CoreImage>('POST', `/api/images/${id}/analyze`),
  syncFeatures: (id: string, f: FeatureInput[]) => req<Feature[]>('PUT', `/api/images/${id}/features`, f),
  model: (pid: string) => req<{ holes: ModelHole[] }>('GET', `/api/projects/${pid}/model`),
  putBreaks: (id: string, b: Omit<CoreBreak, 'depth_m'>[]) => req<{ breaks: CoreBreak[]; geotech: Geotech }>('PUT', `/api/images/${id}/breaks`, b),
  imageGeotech: (id: string) => req<Geotech>('GET', `/api/images/${id}/geotech`),
  holeGeotech: (id: string) => req<HoleGeotech>('GET', `/api/holes/${id}/geotech`),
  codes: (pid: string) => req<LoggingCode[]>('GET', `/api/projects/${pid}/codes`),
  putCodes: (pid: string, c: LoggingCode[]) => req<LoggingCode[]>('PUT', `/api/projects/${pid}/codes`, c),
  defaultCodes: () => req<LoggingCode[]>('GET', '/api/codes/defaults'),
  intervals: (hid: string) => req<IntervalLog>('GET', `/api/holes/${hid}/intervals`),
  putIntervals: (hid: string, rows: Interval[]) => req<IntervalLog>('PUT', `/api/holes/${hid}/intervals`, rows),
  draftIntervals: (hid: string) => req<IntervalLog>('POST', `/api/holes/${hid}/intervals/draft`),
  elements: (pid: string) => req<ElementInfo[]>('GET', `/api/projects/${pid}/assays/elements`),
  holeAssays: (hid: string, element?: string) => req<Assay[]>('GET', `/api/holes/${hid}/assays` + (element ? `?element=${encodeURIComponent(element)}` : '')),
  intercepts: (pid: string, q: InterceptQuery) => {
    const p = new URLSearchParams({ element: q.element, cutoff: String(q.cutoff), max_dilution: String(q.max_dilution), min_length: String(q.min_length) });
    if (q.incl_cutoff) p.set('incl_cutoff', String(q.incl_cutoff));
    return req<{ intercepts: Intercept[] }>('GET', `/api/projects/${pid}/intercepts?${p}`);
  },
  calibration: (pid: string, element: string) => req<Calibration>('GET', `/api/projects/${pid}/calibration?element=${encodeURIComponent(element)}`),
  imageUrl: (id: string) => `/api/images/${id}/file`,
  exportUrl: (pid: string, kind: string) => `/api/projects/${pid}/export/${kind}`,
};
