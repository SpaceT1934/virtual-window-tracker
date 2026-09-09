'use client';
import { useEffect, useState } from 'react';

type Packet = any;
export default function DebugPage() {
  const [packet, setPacket] = useState<Packet | null>(null);
  useEffect(() => { const ws = new WebSocket('ws://127.0.0.1:8765/ws/v1/tracking'); ws.onmessage = e => setPacket(JSON.parse(e.data)); return () => ws.close(); }, []);
  const face = packet?.face; const points = face?.debug_points ?? [];
  return <main className="min-h-screen bg-[#111] p-6 text-[#eee]"><h1 className="mb-4 text-2xl">Face model debugger</h1><div className="grid gap-6 lg:grid-cols-[minmax(480px,2fr)_1fr]"><section className="relative aspect-video overflow-hidden rounded border border-white/20 bg-black"><div className="absolute inset-0 flex items-center justify-center text-white/40">Camera stream is processed by the local service</div>{face?.bbox?.normalized && <div className="absolute border-2 border-green-400" style={{left:`${face.bbox.normalized.x*100}%`,top:`${face.bbox.normalized.y*100}%`,width:`${face.bbox.normalized.width*100}%`,height:`${face.bbox.normalized.height*100}%`}}/>}{points.map((p:any,i:number)=><span key={i} className="absolute h-2 w-2 rounded-full bg-cyan-300" style={{left:`${p.x*100}%`,top:`${p.y*100}%`}} />)}</section><aside className="space-y-2 font-mono text-sm"><div>model: {face?.model ?? packet?.tracker_backend ?? '—'}</div><div>tracking: {String(packet?.tracking ?? false)}</div><div>level: {face?.quality?.tracking_level ?? '—'}</div><div>points: {face?.quality?.valid_points ?? points.length}</div><div>position: {JSON.stringify(face?.viewer_position_m?.filtered ?? null)}</div><div>rotation: {JSON.stringify(face?.head_rotation_deg ?? null)}</div><div>processing: {packet?.processing_ms ?? '—'} ms</div><div>fps: {packet?.frame?.fps_window ?? packet?.frame?.fps ?? '—'}</div></aside></div></main>;
}
