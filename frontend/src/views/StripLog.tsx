import type { Assay, GeotechRun, Hole, Interval } from '../api';
import { CATEGORIES, COLORS, depthText, fmt } from '../lib/geo';
import { rqdColor } from './Geotech';

const SHORT: Record<string, string> = { core: 'core', log: 'log', mineralization: 'mineral.', alteration: 'alter.', vein: 'vein', structure: 'struct.', lithology: 'lith.', grade: 'grade', rqd: 'RQD' };

/** Stable pastel colour for a lithology code. */
export const codeColor = (s: string) => {
  let h = 0;
  for (const ch of s.toUpperCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 55%)`;
};

/** Downhole strip log: interval log, AI/user features by category, assay grade and RQD against depth. */
export default function StripLog({ hole, onPick, intervals = [], assays = [], runs = [] }: {
  hole: Hole; onPick: (imageId: string) => void; intervals?: Interval[]; assays?: Assay[]; runs?: GeotechRun[];
}) {
  const cols = ['core', ...(intervals.length ? ['log'] : []), ...CATEGORIES, ...(assays.length ? ['grade'] : []), ...(runs.some(r => r.rqd != null) ? ['rqd'] : [])];
  const W = 60 + cols.length * 44, H = 680, top = 26, ax = 46;
  const cw = (W - ax - 8) / cols.length;
  const cx = (c: string) => ax + cols.indexOf(c) * cw;
  const L = Math.max(1, hole.length);
  const y = (d: number) => top + (Math.min(L, Math.max(0, d)) / L) * (H - top - 10);
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500].find(s => L / s <= 12) ?? 1000;
  const ticks: number[] = [];
  for (let d = 0; d <= L + 1e-6; d += step) ticks.push(d);
  const maxG = Math.max(1e-9, ...assays.map(a => a.value));
  // log scale for grade bars so a few high values don't flatten the rest
  const gw = (v: number) => (Math.log10(1 + v) / Math.log10(1 + maxG)) * (cw - 4);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block', color: 'var(--ink)' }} role="img" aria-label={`Downhole log for ${hole.name}`}>
      {ticks.map(d => (
        <g key={d}>
          <line x1={ax - 4} x2={W - 6} y1={y(d)} y2={y(d)} stroke="currentColor" strokeOpacity={0.1} />
          <text x={ax - 8} y={y(d) + 3} textAnchor="end" fontSize={10} fill="currentColor" opacity={0.55}>{d}</text>
        </g>
      ))}
      {cols.map(c => <text key={c} x={cx(c) + cw / 2} y={14} textAnchor="middle" fontSize={9.5} fill="currentColor" opacity={0.65}>{SHORT[c]}</text>)}
      {cols.slice(1).map(c => <line key={c} x1={cx(c)} x2={cx(c)} y1={top} y2={H - 10} stroke="currentColor" strokeOpacity={0.06} />)}

      {hole.images.map(im => (
        <g key={im.id}>
          {im.from_m != null && im.to_m != null && (
            <rect x={cx('core') + 2} y={y(im.from_m)} width={cw - 4} height={Math.max(1.5, y(im.to_m) - y(im.from_m))} fill="currentColor" fillOpacity={0.2} rx={2}
              style={{ cursor: 'pointer' }} onClick={() => onPick(im.id)}><title>{`${im.name} · ${im.from_m}–${im.to_m} m`}</title></rect>
          )}
          {im.features.map(f => {
            if (f.from_m == null || f.to_m == null) return null;
            const y0 = y(f.from_m);
            return (
              <rect key={f.id} x={cx(f.category) + 2} y={y0} width={cw - 4} height={Math.max(2, y(f.to_m) - y0)} rx={1.5}
                fill={COLORS[f.category]} fillOpacity={0.35 + 0.6 * f.confidence / 100} stroke={f.verified ? '#fff' : 'none'} strokeOpacity={0.6}
                style={{ cursor: 'pointer' }} onClick={() => onPick(im.id)}>
                <title>{`${f.label} · ${f.confidence}% · ${depthText(f)}${f.verified ? ' · verified' : ''}`}</title>
              </rect>
            );
          })}
        </g>
      ))}

      {intervals.map((r, i) => (
        <rect key={i} x={cx('log') + 2} y={y(r.from_m)} width={cw - 4} height={Math.max(1.5, y(r.to_m) - y(r.from_m))} rx={1.5}
          fill={r.lithology ? codeColor(r.lithology) : 'currentColor'} fillOpacity={r.lithology ? 0.85 : 0.15}>
          <title>{`${r.from_m}–${r.to_m} m · ${[r.lithology, r.alteration, r.mineralization].filter(Boolean).join(' · ') || 'unlogged'}${r.sulphide_pct ? ` · ${r.sulphide_pct}% sulph` : ''}`}</title>
        </rect>
      ))}

      {assays.map(a => (
        <rect key={a.id} x={cx('grade') + 2} y={y(a.from_m)} width={Math.max(1, gw(a.value))} height={Math.max(1.5, y(a.to_m) - y(a.from_m) - 0.5)}
          fill="var(--ac)" fillOpacity={a.below_detection ? 0.25 : 0.85}>
          <title>{`${a.from_m}–${a.to_m} m · ${a.element} ${a.below_detection ? '<DL' : a.value} ${a.unit}${a.sample_id ? ` · ${a.sample_id}` : ''}`}</title>
        </rect>
      ))}

      {runs.filter(r => r.rqd != null).map(r => (
        <rect key={r.image_id} x={cx('rqd') + 2} y={y(r.from_m)} width={Math.max(1, (r.rqd! / 100) * (cw - 4))} height={Math.max(1.5, y(r.to_m) - y(r.from_m))}
          fill={rqdColor(r.rqd!)} fillOpacity={0.85} style={{ cursor: 'pointer' }} onClick={() => onPick(r.image_id)}>
          <title>{`${r.from_m}–${r.to_m} m · RQD ${fmt(r.rqd!)}% · recovery ${fmt(r.recovery ?? 0)}% · ${fmt(r.ff ?? 0, 2)} fractures/m`}</title>
        </rect>
      ))}
      <text x={10} y={H / 2} fontSize={10} fill="currentColor" opacity={0.55} transform={`rotate(-90 10 ${H / 2})`} textAnchor="middle">depth (m)</text>
    </svg>
  );
}
