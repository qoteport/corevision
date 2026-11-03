import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { Pause, Play, RefreshCw, RotateCcw } from 'lucide-react';
import { useStore } from '../store';
import { api, type ModelHole } from '../api';
import { CATEGORIES, COLORS, fmt } from '../lib/geo';

/* ---------- geometry ---------- */
const RADIAL = 8;

interface Prepared extends ModelHole { P: THREE.Vector3[]; D: number[] }
type Interval = ModelHole['intervals'][number];
interface Seg { key: string; hole: Prepared; d0: number; d1: number; a: Interval }

function posAt(h: Prepared, d: number): THREE.Vector3 {
  const D = h.D;
  d = Math.max(0, Math.min(h.length, d));
  let lo = 0, hi = D.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (D[m] <= d) lo = m; else hi = m; }
  const t = D[hi] === D[lo] ? 0 : (d - D[lo]) / (D[hi] - D[lo]);
  return h.P[lo].clone().lerp(h.P[hi], t);
}

function tubeGeom(h: Prepared, d0: number, d1: number, r: number) {
  const n = Math.max(2, Math.min(160, Math.ceil((d1 - d0) / Math.max(0.05, h.length / 240)) + 1));
  const pts = Array.from({ length: n }, (_, i) => posAt(h, d0 + ((d1 - d0) * i) / (n - 1)));
  const segs = Math.max(2, (n - 1) * 2);
  return { g: new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'centripetal'), segs, r, RADIAL, false), segs };
}

/** Tube along a depth range, revealed up to `upTo` (bit depth) using the index draw range. */
function Tube({ h, d0, d1, r, upTo, color, opacity = 1, basic = false, onOver, onOut }: {
  h: Prepared; d0: number; d1: number; r: number; upTo: number; color: string | number; opacity?: number; basic?: boolean;
  onOver?: (e: ThreeEvent<PointerEvent>) => void; onOut?: () => void;
}) {
  const { g, segs } = useMemo(() => tubeGeom(h, d0, d1, r), [h, d0, d1, r]);
  useEffect(() => () => g.dispose(), [g]);
  const frac = Math.max(0, Math.min(1, (upTo - d0) / (d1 - d0)));
  useLayoutEffect(() => { g.setDrawRange(0, Math.floor(frac * segs) * RADIAL * 6); }, [g, segs, frac]);
  if (frac <= 0) return null;
  const transparent = opacity < 1;
  return (
    <mesh geometry={g} onPointerMove={onOver ? e => { e.stopPropagation(); onOver(e); } : undefined} onPointerOut={onOut}>
      {basic ? <meshBasicMaterial color={color} transparent={transparent} opacity={opacity} depthWrite={!transparent} />
        : <meshLambertMaterial color={color} transparent={transparent} opacity={opacity} />}
    </mesh>
  );
}

function Bit({ h, depth, r }: { h: Prepared; depth: number; r: number }) {
  const ref = useRef<THREE.Mesh>(null);
  useLayoutEffect(() => {
    const m = ref.current; if (!m) return;
    const L = Math.max(0.001, Math.min(depth, h.length));
    const p = posAt(h, L);
    let dir = posAt(h, Math.min(h.length, L + 0.5)).sub(p);
    if (dir.lengthSq() < 1e-12) dir = p.clone().sub(posAt(h, Math.max(0, L - 0.5)));
    m.position.copy(p);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.normalize());
  }, [h, depth]);
  return <mesh ref={ref}><coneGeometry args={[r * 3, r * 8, 12]} /><meshLambertMaterial color="#ffd23f" /></mesh>;
}

/** Hole name drawn into a sprite, so no DOM nodes are mixed into the WebGL canvas. */
function Label({ text, position, span }: { text: string; position: THREE.Vector3; span: number }) {
  const tex = useMemo(() => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    const g = c.getContext('2d')!;
    g.font = '600 30px system-ui, sans-serif';
    const w = Math.min(250, g.measureText(text).width + 16);
    g.fillStyle = 'rgba(0,0,0,0.6)'; g.beginPath(); g.roundRect(0, 10, w, 44, 8); g.fill();
    g.fillStyle = '#fff'; g.fillText(text, 8, 43);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [text]);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <sprite position={[position.x, position.y + span * 0.05, position.z]} scale={[span * 0.18, span * 0.045, 1]} center={new THREE.Vector2(0.1, 0.5)}>
      <spriteMaterial map={tex} depthTest={false} transparent />
    </sprite>
  );
}

function Ribbon({ a, b, color, visible }: { a: Seg; b: Seg; color: string; visible: boolean }) {
  const g = useMemo(() => {
    const v = [posAt(a.hole, a.d0), posAt(a.hole, a.d1), posAt(b.hole, b.d1), posAt(b.hole, b.d0)];
    const geo = new THREE.BufferGeometry().setFromPoints([v[0], v[1], v[2], v[0], v[2], v[3]]);
    geo.computeVertexNormals();
    return geo;
  }, [a, b]);
  useEffect(() => () => g.dispose(), [g]);
  return <mesh geometry={g} visible={visible}><meshBasicMaterial color={color} transparent opacity={0.3} side={THREE.DoubleSide} depthWrite={false} /></mesh>;
}

/** Advances the bit while playing. */
function Driver({ playing, speed, max, setDepth, onEnd }: { playing: boolean; speed: number; max: number; setDepth: (f: (d: number) => number) => void; onEnd: () => void }) {
  useFrame((_, dt) => {
    if (!playing) return;
    setDepth(d => { const n = d + (dt * max * speed) / 25; if (n >= max) { onEnd(); return max; } return n; });
  });
  return null;
}

/** Frames the whole project. Waits for OrbitControls (registered via makeDefault) so they don't override it. */
function CameraRig({ span, resetKey }: { span: number; resetKey: number }) {
  const camera = useThree(s => s.camera);
  const controls = useThree(s => s.controls) as OrbitControlsImpl | null;
  useEffect(() => {
    if (!controls) return;
    const th = 0.8, ph = 1.05, rad = span * 1.7;
    camera.position.set(rad * Math.sin(ph) * Math.cos(th), rad * Math.cos(ph), rad * Math.sin(ph) * Math.sin(th));
    camera.near = span / 1000; camera.far = span * 50; camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.update();
  }, [span, resetKey, camera, controls]);
  return null;
}

/* Sequential grade ramp (cool → hot), log-scaled between the minimum and the 95th percentile. */
const GRADE_STOPS = ['#2c3e91', '#2b83ba', '#3fb68f', '#e9d34a', '#f08a2c', '#d7263d'];
function gradeColor(v: number, lo: number, hi: number): string {
  const a = Math.log10(Math.max(lo, 1e-6) + 1e-6), b = Math.log10(Math.max(hi, lo * 1.0001, 1e-5));
  const t = Math.max(0, Math.min(1, (Math.log10(Math.max(v, 1e-6)) - a) / Math.max(1e-9, b - a)));
  const f = t * (GRADE_STOPS.length - 1), i = Math.min(GRADE_STOPS.length - 2, Math.floor(f));
  return '#' + new THREE.Color(GRADE_STOPS[i]).lerp(new THREE.Color(GRADE_STOPS[i + 1]), f - i).getHexString();
}

/* ---------- view ---------- */
export default function Scene3D() {
  const project = useStore(s => s.project);
  const reload = useStore(s => s.reload);
  const [holes, setHoles] = useState<ModelHole[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [depth, setDepth] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [show, setShow] = useState({ corr: true, segs: true, lith: false, path: true });
  const [colorBy, setColorBy] = useState<string>('category'); // 'category' or an assay element
  const [hover, setHover] = useState<{ text: string; x: number; y: number } | null>(null);
  const [resetKey, setResetKey] = useState(0);

  // Re-fetch when anything that affects the model changes.
  const sig = useMemo(() => JSON.stringify(project?.holes.map(h => [h.id, h.x, h.y, h.z, h.azimuth, h.dip, h.length, h.surveys,
    h.images.map(i => i.features.map(f => [f.id, f.from_m, f.to_m, f.label, f.category, f.confidence, f.verified]))])), [project]);
  useEffect(() => {
    if (!project) return;
    let live = true;
    api.model(project.id).then(m => { if (live) { setHoles(m.holes); setErr(null); } }).catch(e => live && setErr(e.message));
    return () => { live = false; };
  }, [project?.id, sig]); // eslint-disable-line react-hooks/exhaustive-deps

  const scene = useMemo(() => {
    if (!holes?.length) return null;
    // East → x, RL → y (up), North → −z, centred on the origin to keep float precision with real coordinates.
    const raw = holes.map(h => h.path.map(p => new THREE.Vector3(p.x, p.z, -p.y)));
    const box = new THREE.Box3().setFromPoints(raw.flat());
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const prepared: Prepared[] = holes.map((h, i) => ({ ...h, P: raw[i].map(v => v.clone().sub(c)), D: h.path.map(p => p.depth) }));
    const span = Math.max(size.x, size.y, size.z, 30);
    const segs: Seg[] = prepared.flatMap(h => h.intervals.map(a => {
      const d0 = Math.max(0, Math.min(h.length, a.from_m));
      const d1 = Math.min(h.length, Math.max(a.to_m, d0 + Math.max(0.15, h.length / 250)));
      return { key: a.id, hole: h, d0, d1, a };
    })).filter(s => s.d1 > s.d0);
    // Correlation: same-label mineralization/vein between each hole and its nearest collar neighbour.
    const pairs: { a: Seg; b: Seg; key: string; at: number }[] = [];
    const seen = new Set<string>();
    const best = (h: Prepared) => {
      const m = new Map<string, Seg>();
      segs.filter(s => s.hole === h && (s.a.category === 'mineralization' || s.a.category === 'vein')).forEach(s => {
        const k = s.a.label.toLowerCase().trim(); const o = m.get(k); if (!o || s.a.confidence > o.a.confidence) m.set(k, s);
      });
      return m;
    };
    prepared.forEach((h, i) => {
      let bj = -1, bd = Infinity;
      prepared.forEach((g, j) => { if (j !== i) { const d = h.P[0].distanceToSquared(g.P[0]); if (d < bd) { bd = d; bj = j; } } });
      if (bj < 0) return;
      const key = [i, bj].sort().join('-'); if (seen.has(key)) return; seen.add(key);
      const A = best(h), B = best(prepared[bj]);
      A.forEach((a, k) => { const b = B.get(k); if (b) pairs.push({ a, b, key: key + k, at: Math.max(a.d0, b.d0) }); });
    });
    return { prepared, span, r0: span / 450, top: box.max.y - c.y, segs, pairs, maxL: Math.max(...prepared.map(h => h.length)) };
  }, [holes]);

  useEffect(() => { if (scene) setDepth(scene.maxL); }, [scene?.maxL]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!project) return null;
  if (err) return <div className="page err">Could not load the model: {err}</div>;
  if (!holes) return <div className="page mu">Loading model…</div>;
  if (!scene) return <div className="page"><div className="empty"><h2>No drillholes yet</h2><p className="mu">Add a hole with its collar, azimuth, dip and length to see it here.</p></div></div>;
  const { prepared, span, r0, top, segs, pairs, maxL } = scene;
  const elements = [...new Set(prepared.flatMap(h => h.assays.map(a => a.element)))].sort();
  const byGrade = colorBy !== 'category' && elements.includes(colorBy);
  const gradeRows = byGrade ? prepared.flatMap(h => h.assays.filter(a => a.element === colorBy && a.to_m > a.from_m).map((a, i) => ({ h, a, key: `${h.id}-${i}` }))) : [];
  const vals = gradeRows.map(g => g.a.value).sort((x, y) => x - y);
  const gMin = vals[0] ?? 0, gMax = vals[Math.floor(vals.length * 0.95)] ?? 1;
  const gUnit = gradeRows[0]?.a.unit ?? '';

  return (
    <div className="scene">
      <Canvas camera={{ fov: 50 }} dpr={[1, 2]} onPointerMissed={() => setHover(null)}>
        <ambientLight intensity={0.7} />
        <directionalLight position={[1, 2, 1]} intensity={1.6} />
        <gridHelper args={[span * 1.8, 18, '#8a93a5', '#343b48']} position={[0, top, 0]} />
        <mesh><boxGeometry args={[span * 1.4, span * 0.9, span * 1.4]} /><meshBasicMaterial color="#8a6d3b" transparent opacity={0.04} depthWrite={false} /></mesh>
        {prepared.map(h => (
          <group key={h.id}>
            {show.path && <Tube h={h} d0={0} d1={h.length} r={r0 * 0.9} upTo={h.length} color="#bfc5d0" opacity={0.13} basic />}
            <Tube h={h} d0={0} d1={h.length} r={r0} upTo={depth} color="#c9ced8" />
            <Bit h={h} depth={depth} r={r0} />
            <mesh position={h.P[0]}><boxGeometry args={[r0 * 10, r0 * 14, r0 * 10]} /><meshLambertMaterial color="#ff8a3d" /></mesh>
            <Label text={h.name + (h.surveyed ? '' : ' ·')} position={h.P[0]} span={span} />
          </group>
        ))}
        {byGrade && gradeRows.map(({ h, a, key }) => (
          <Tube key={key} h={h} d0={Math.max(0, a.from_m)} d1={Math.min(h.length, a.to_m)} r={r0 * 1.9} upTo={depth} color={gradeColor(a.value, gMin, gMax)}
            onOver={e => setHover({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY, text: `${h.name} ${a.from_m}–${a.to_m} m\n${colorBy} ${a.value} ${a.unit}` })}
            onOut={() => setHover(null)} />
        ))}
        {!byGrade && segs.map(s => (s.a.category === 'lithology' ? show.lith : show.segs) && (
          <Tube key={s.key} h={s.hole} d0={s.d0} d1={s.d1} r={r0 * (s.a.category === 'lithology' ? 1.4 : 1.9)} upTo={depth}
            color={COLORS[s.a.category]} opacity={s.a.category === 'lithology' ? 0.45 : 0.95}
            onOver={e => setHover({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY, text: `${s.a.label} · ${s.a.category} · ${s.a.confidence}%${s.a.verified ? ' · verified' : ''}\n${s.hole.name} ${s.a.from_m.toFixed(1)}–${s.a.to_m.toFixed(1)} m` })}
            onOut={() => setHover(null)} />
        ))}
        {pairs.map(q => <Ribbon key={q.key} a={q.a} b={q.b} color={COLORS[q.a.a.category]} visible={show.corr && depth >= q.at} />)}
        <OrbitControls makeDefault enableDamping dampingFactor={0.12} />
        <CameraRig span={span} resetKey={resetKey} />
        <Driver playing={playing} speed={speed} max={maxL} setDepth={setDepth} onEnd={() => setPlaying(false)} />
      </Canvas>

      {hover && <div className="tip3d" style={{ position: 'absolute', left: hover.x + 14, top: hover.y + 14, zIndex: 3, whiteSpace: 'pre' }}>{hover.text}</div>}

      <div className="overlay ov-top">
        <select className="input sm" style={{ width: 'auto' }} value={colorBy} onChange={e => setColorBy(e.target.value)} aria-label="Colour intervals by">
          <option value="category">Colour: logged category</option>
          {elements.map(el => <option key={el} value={el}>Colour: {el} grade</option>)}
        </select>
        <div className="legend grow">
          {byGrade ? (
            <span style={{ gap: 8 }}>
              <span className="num">{fmt(gMin, 2)}</span>
              <span style={{ width: 120, height: 9, borderRadius: 4, display: 'inline-block', background: `linear-gradient(90deg, ${GRADE_STOPS.join(',')})` }} />
              <span className="num">≥ {fmt(gMax, 2)} {gUnit} {colorBy}</span>
            </span>
          ) : CATEGORIES.map(c => <span key={c}><span className="dot" style={{ background: COLORS[c] }} />{c}</span>)}
        </div>
        <label className="check"><input type="checkbox" checked={show.segs} onChange={e => setShow({ ...show, segs: e.target.checked })} />intervals</label>
        <label className="check"><input type="checkbox" checked={show.lith} onChange={e => setShow({ ...show, lith: e.target.checked })} />lithology</label>
        <label className="check"><input type="checkbox" checked={show.corr} onChange={e => setShow({ ...show, corr: e.target.checked })} />correlation</label>
        <label className="check"><input type="checkbox" checked={show.path} onChange={e => setShow({ ...show, path: e.target.checked })} />planned path</label>
        <button className="btn sm" onClick={() => setResetKey(k => k + 1)}><RotateCcw size={13} />View</button>
        <button className="btn sm" onClick={() => reload()}><RefreshCw size={13} />Refresh</button>
      </div>

      <div className="overlay ov-bottom">
        <button className="btn primary sm" onClick={() => { if (!playing && depth >= maxL) setDepth(0); setPlaying(p => !p); }}>
          {playing ? <><Pause size={14} />Pause</> : <><Play size={14} />Drill</>}
        </button>
        <input type="range" min={0} max={maxL} step={0.1} value={depth} onChange={e => { setPlaying(false); setDepth(+e.target.value); }} aria-label="Bit depth" />
        <span className="num" style={{ width: 92, textAlign: 'right' }}>{fmt(depth, 1)} m</span>
        <div className="seg">{[1, 2, 4].map(s => <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)}>{s}×</button>)}</div>
      </div>
      <div className="mu tiny" style={{ position: 'absolute', bottom: 70, left: 16, zIndex: 2 }}>Drag to orbit · right-drag to pan · scroll to zoom · paths are desurveyed with minimum curvature (· = no survey)</div>
    </div>
  );
}
