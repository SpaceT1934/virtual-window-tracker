'use client';
import { useEffect, useState } from 'react';

type Packet = any;
type DebugPoint = { x: number; y: number; name?: string; index?: number; group?: string; pixel?: { x: number; y: number } };

const GROUP_COLOR: Record<string, string> = {
  yunet: 'bg-cyan-300',
  lbf: 'bg-amber-300',
};

export default function DebugPage() {
  const [packet, setPacket] = useState<Packet | null>(null);
  const [showAll, setShowAll] = useState(true);
  useEffect(() => { const ws = new WebSocket('ws://127.0.0.1:8765/ws/v1/tracking'); ws.onmessage = e => setPacket(JSON.parse(e.data)); return () => { ws.close(); }; }, []);
  const face = packet?.face;
  const points: DebugPoint[] = face?.debug_points ?? [];
  // "used" points = the two eyes actually driving geometry (from eyes payload).
  const eyeUsed = [face?.eyes?.left?.pixel, face?.eyes?.right?.pixel].filter(Boolean);
  const visible = showAll ? points : points.filter(p => p.group === 'yunet');
  return <main className="min-h-screen bg-[#111] p-6 text-[#eee]"><h1 className="mb-4 text-2xl">Face model debugger</h1><div className="grid gap-6 lg:grid-cols-[minmax(480px,2fr)_1fr]"><section className="relative aspect-video overflow-hidden rounded border border-white/20 bg-black"><img src="http://127.0.0.1:8765/api/v1/debug/stream" alt="camera" className="absolute inset-0 z-0 h-full w-full object-contain" /><div className="pointer-events-none absolute inset-0 z-10">{face?.bbox?.normalized && <div className="absolute border-2 border-green-400" style={{left:`${face.bbox.normalized.x*100}%`,top:`${face.bbox.normalized.y*100}%`,width:`${face.bbox.normalized.width*100}%`,height:`${face.bbox.normalized.height*100}%`}}/>}{visible.map((p,i)=><span key={`${p.group}-${p.name ?? p.index}-${i}`} title={`${p.group ?? ''} ${p.name ?? ''}${p.index!=null?' #'+p.index:''}`} className={`absolute h-[6px] w-[6px] -translate-x-1/2 -translate-y-1/2 rounded-full ${GROUP_COLOR[p.group ?? 'yunet'] ?? 'bg-cyan-300'}`} style={{left:`${p.x*100}%`,top:`${p.y*100}%`}} />)}</div></section><aside className="space-y-2 font-mono text-sm"><div>model: {face?.model ?? packet?.tracker_backend ?? '—'}</div><div>tracking: {String(packet?.tracking ?? false)}</div><div>level: {face?.quality?.tracking_level ?? '—'}</div><div>points: {face?.quality?.valid_points ?? points.length} / shown {visible.length}</div><div>eye source: {face?.eyes?.source ?? '—'}</div><div>position: {JSON.stringify(face?.viewer_position_m?.filtered ?? null)}</div><div>rotation: {JSON.stringify(face?.head_rotation_deg ?? null)}</div><div>processing: {packet?.processing_ms ?? '—'} ms</div><div>fps: {packet?.frame?.fps_window ?? packet?.frame?.fps ?? '—'}</div><label className="flex items-center gap-2 pt-1"><input type="checkbox" checked={showAll} onChange={e=>setShowAll(e.target.checked)} className="accent-cyan-400" /> show all detected points</label></aside></div></main>;
}
