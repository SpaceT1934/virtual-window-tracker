'use client';
import { useCallback, useEffect, useState } from 'react';

import {
  DEFAULT_BACKEND_FOV_DEG,
  MAX_CALIBRATION_FOV_DEG,
  MIN_CALIBRATION_FOV_DEG,
  applyDepthScale,
  depthScaleFor,
  useTrueFovDeg,
} from '@/lib/fov-calibration';

type DebugPoint = { x: number; y: number; name?: string; index?: number; group?: string; pixel?: { x: number; y: number } };
type Packet = {
  tracker_backend?: string;
  tracking?: boolean;
  processing_ms?: number;
  camera_hfov_deg?: number;
  frame?: { fps_window?: number; fps?: number };
  face?: {
    model?: string;
    bbox?: { normalized?: { x: number; y: number; width: number; height: number } };
    debug_points?: DebugPoint[];
    quality?: { tracking_level?: string; valid_points?: number };
    eyes?: { source?: string };
    viewer_position_m?: { filtered?: { x: number; y: number; z: number } | null };
    head_rotation_deg?: unknown;
  };
};

const GROUP_COLOR: Record<string, string> = {
  yunet: 'bg-cyan-300',
  lbf: 'bg-amber-300',
};

export default function DebugPage() {
  const [packet, setPacket] = useState<Packet | null>(null);
  const [showAll, setShowAll] = useState(true);
  const [trueFov, setTrueFov] = useTrueFovDeg();
  const handleMessage = useCallback((event: MessageEvent<string>) => {
    setPacket(JSON.parse(event.data) as Packet);
  }, []);
  useEffect(() => {
    const ws = new WebSocket('ws://127.0.0.1:8765/ws/v1/tracking');
    ws.addEventListener('message', handleMessage);
    return () => {
      ws.removeEventListener('message', handleMessage);
      ws.close();
    };
  }, [handleMessage]);
  const face = packet?.face;
  const points: DebugPoint[] = face?.debug_points ?? [];
  const visible = showAll ? points : points.filter(p => p.group === 'yunet');
  const packetCameraFov = packet?.camera_hfov_deg;
  const backendFov = typeof packetCameraFov === 'number' && Number.isFinite(packetCameraFov) ? packetCameraFov : DEFAULT_BACKEND_FOV_DEG;
  const depthScale = depthScaleFor(backendFov, trueFov);
  const filtered = face?.viewer_position_m?.filtered ?? null;
  const corrected = filtered ? applyDepthScale(filtered, depthScale) : null;
  const sliderValue = trueFov ?? backendFov;
  return <main className="min-h-screen bg-[#111] p-6 text-[#eee]"><h1 className="mb-4 text-2xl">Face model debugger</h1><div className="grid gap-6 lg:grid-cols-[minmax(480px,2fr)_1fr]"><section className="relative aspect-video overflow-hidden rounded border border-white/20 bg-black"><div aria-label="camera" className="absolute inset-0 z-0 h-full w-full bg-contain bg-center bg-no-repeat" style={{ backgroundImage: 'url(http://127.0.0.1:8765/api/v1/debug/stream)' }} /><div className="pointer-events-none absolute inset-0 z-10">{face?.bbox?.normalized && <div className="absolute border-2 border-green-400" style={{left:`${face.bbox.normalized.x*100}%`,top:`${face.bbox.normalized.y*100}%`,width:`${face.bbox.normalized.width*100}%`,height:`${face.bbox.normalized.height*100}%`}}/>}{visible.map((p,i)=><span key={`${p.group}-${p.name ?? p.index}-${i}`} title={`${p.group ?? ''} ${p.name ?? ''}${p.index!=null?' #'+p.index:''}`} className={`absolute h-[6px] w-[6px] -translate-x-1/2 -translate-y-1/2 rounded-full ${GROUP_COLOR[p.group ?? 'yunet'] ?? 'bg-cyan-300'}`} style={{left:`${p.x*100}%`,top:`${p.y*100}%`}} />)}</div></section><aside className="space-y-2 font-mono text-sm">
      <div className="rounded border border-cyan-400/30 bg-cyan-400/5 p-3 font-sans">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <span className="text-xs text-white/70">真实水平视场角 HFOV</span>
          <span className="font-mono text-cyan-300">{sliderValue.toFixed(1)}°</span>
        </div>
        <input
          aria-label="真实水平视场角"
          type="range"
          min={MIN_CALIBRATION_FOV_DEG}
          max={MAX_CALIBRATION_FOV_DEG}
          step={0.5}
          value={sliderValue}
          onChange={e => setTrueFov(Number(e.target.value))}
          className="w-full accent-cyan-400"
        />
        <div className="mt-1 flex justify-between font-mono text-[10px] text-white/45">
          <span>{MIN_CALIBRATION_FOV_DEG}°</span>
          <span className={depthScale === 1 ? 'text-white/45' : 'text-amber-300'}>深度系数 {depthScale.toFixed(3)}×</span>
          <span>{MAX_CALIBRATION_FOV_DEG}°</span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <button type="button" onClick={() => setTrueFov(null)} disabled={trueFov === null} className="rounded border border-white/20 px-2 py-0.5 text-[11px] text-white/80 disabled:opacity-35">{trueFov === null ? '跟随后端' : '恢复跟随后端'}</button>
          <span className="font-mono text-[10px] text-white/45">后端设定 {backendFov.toFixed(1)}°</span>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-white/40 font-sans">拖动直到 z 修正后 ≈ 实测距离。FOV 只影响深度,x/y 无需修正。渲染页共用同一取值。</p>
      </div>
      <div>model: {face?.model ?? packet?.tracker_backend ?? '—'}</div><div>tracking: {String(packet?.tracking ?? false)}</div><div>level: {face?.quality?.tracking_level ?? '—'}</div><div>points: {face?.quality?.valid_points ?? points.length} / shown {visible.length}</div><div>eye source: {face?.eyes?.source ?? '—'}</div>
      <div>z 原始: {filtered ? `${filtered.z.toFixed(3)} m` : '—'}</div>
      <div className="text-cyan-300">z 修正后: {corrected ? `${corrected.z.toFixed(3)} m` : '—'}</div>
      <div>position(修正后): {JSON.stringify(corrected ?? null)}</div>
      <div>rotation: {JSON.stringify(face?.head_rotation_deg ?? null)}</div><div>processing: {packet?.processing_ms ?? '—'} ms</div><div>fps: {packet?.frame?.fps_window ?? packet?.frame?.fps ?? '—'}</div><label className="flex items-center gap-2 pt-1 font-sans"><input type="checkbox" checked={showAll} onChange={e=>setShowAll(e.target.checked)} className="accent-cyan-400" /> show all detected points</label></aside></div></main>;
}
