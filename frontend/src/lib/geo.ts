import type { Category, CoreImage, Feature, Hole, Pt } from '../api';

export const COLORS: Record<Category, string> = {
  mineralization: '#ff8a3d',
  alteration: '#2fbf9b',
  vein: '#4c8dff',
  structure: '#ff4d6a',
  lithology: '#9aa3b2',
};
export const CATEGORIES = Object.keys(COLORS) as Category[];
export const isOpen = (c: Category) => c === 'vein' || c === 'structure';
export const BUSY = (s: CoreImage['status']) => s === 'queued' || s === 'analyzing';

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 12);

export const clamp = (v: number, lo = 0, hi = 1000) => Math.min(hi, Math.max(lo, v));

export const centroid = (pts: Pt[]): Pt => [
  pts.reduce((s, p) => s + p[0], 0) / pts.length,
  pts.reduce((s, p) => s + p[1], 0) / pts.length,
];

/** Smooth Catmull-Rom path through the points, as SVG path data. */
export function smoothPath(pts: Pt[], closed: boolean): string {
  const n = pts.length;
  if (n < 3) return 'M' + pts.map(p => p.join(' ')).join('L');
  const g = (i: number) => (closed ? pts[(i + n * 2) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  let d = 'M' + g(0).join(' ');
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = g(i - 1), b = g(i), c = g(i + 1), e = g(i + 2);
    d += `C${b[0] + (c[0] - a[0]) / 6} ${b[1] + (c[1] - a[1]) / 6} ${c[0] - (e[0] - b[0]) / 6} ${c[1] - (e[1] - b[1]) / 6} ${c[0]} ${c[1]}`;
  }
  return d + (closed ? 'Z' : '');
}

export const depthText = (f: Pick<Feature, 'from_m' | 'to_m'>) =>
  f.from_m == null || f.to_m == null ? '' : f.from_m.toFixed(2) + (f.to_m - f.from_m > 0.004 ? '–' + f.to_m.toFixed(2) : '') + ' m';

export const runText = (im: Pick<CoreImage, 'from_m' | 'to_m'>) => `${im.from_m ?? '?'}–${im.to_m ?? '?'} m`;

/** Metres of core covered by photos with a depth range. */
export const loggedMetres = (h: Hole) =>
  h.images.reduce((s, im) => s + (im.from_m != null && im.to_m != null ? Math.max(0, im.to_m - im.from_m) : 0), 0);

export const fmt = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d).replace(/\.0+$/, '') : '–');
