'use client';

import {
  ChevronDown,
  ChevronUp,
  LocateFixed,
  Maximize2,
  MousePointer2,
  RotateCcw,
  ScanFace,
  Settings2,
  Undo2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

import { Button } from '@/components/ui/button';

type ViewPosition = { x: number; y: number; z: number };
type ViewerPosition = { x: number; y: number; z: number };
type TrackerState = 'connecting' | 'tracking' | 'calibrating' | 'lost' | 'offline' | 'manual';
type TrackingPacket = {
  tracking?: boolean;
  face?: { viewer_position_m?: { filtered?: ViewerPosition } | null } | null;
};

type DisplaySettings = {
  connectionUrl: string;
  view: {
    eyeDistance: number;
    near: number;
    far: number;
    positionGain: number;
    depthGain: number;
    invertX: boolean;
    xLimit: number;
    yLimit: number;
    zMinimum: number;
    zMaximum: number;
    mouseXGain: number;
    mouseYGain: number;
    smoothing: number;
    lostResetMs: number;
    reconnectMs: number;
  };
  case: {
    width: number;
    height: number;
    depth: number;
    roomColor: string;
    sideColor: string;
    floorColor: string;
    edgeColor: string;
    gridColor: string;
    gridOpacity: number;
    roughness: number;
    metalness: number;
    backgroundColor: string;
    fogColor: string;
    fogNear: number;
    fogFar: number;
  };
  model: {
    x: number;
    y: number;
    z: number;
    scale: number;
    bronzeColor: string;
    darkBronzeColor: string;
    plinthTopColor: string;
    plinthColor: string;
    metalness: number;
    roughness: number;
  };
  lighting: {
    pixelRatioCap: number;
    exposure: number;
    hemisphereSky: string;
    hemisphereGround: string;
    hemisphereIntensity: number;
    keyColor: string;
    keyIntensity: number;
    keyDistance: number;
    keyAngle: number;
    keyPenumbra: number;
    keyDecay: number;
    keyX: number;
    keyY: number;
    keyZ: number;
    keyTargetX: number;
    keyTargetY: number;
    keyTargetZ: number;
    rimColor: string;
    rimIntensity: number;
    rimDistance: number;
    rimDecay: number;
    rimX: number;
    rimY: number;
    rimZ: number;
    fillColor: string;
    fillIntensity: number;
    fillDistance: number;
    fillDecay: number;
    fillX: number;
    fillY: number;
    fillZ: number;
  };
};

const DEFAULT_SETTINGS: DisplaySettings = {
  connectionUrl: 'ws://127.0.0.1:8765/ws/v1/tracking',
  view: {
    eyeDistance: 7.4,
    near: 0.1,
    far: 50,
    positionGain: 12.5,
    depthGain: 10,
    invertX: true,
    xLimit: 2.2,
    yLimit: 1.35,
    zMinimum: 5.2,
    zMaximum: 10.5,
    mouseXGain: 0.82,
    mouseYGain: 0.48,
    smoothing: 11,
    lostResetMs: 700,
    reconnectMs: 1500,
  },
  case: {
    width: 8,
    height: 4.5,
    depth: 5.8,
    roomColor: '#dedbd1',
    sideColor: '#c7c8c2',
    floorColor: '#b9b7ad',
    edgeColor: '#2d3332',
    gridColor: '#555d5b',
    gridOpacity: 0.19,
    roughness: 0.86,
    metalness: 0.02,
    backgroundColor: '#171b1c',
    fogColor: '#171b1c',
    fogNear: 15,
    fogFar: 28,
  },
  model: {
    x: 0,
    y: -0.18,
    z: -1.85,
    scale: 1.08,
    bronzeColor: '#9e6738',
    darkBronzeColor: '#30241e',
    plinthTopColor: '#1c2021',
    plinthColor: '#101415',
    metalness: 0.78,
    roughness: 0.28,
  },
  lighting: {
    pixelRatioCap: 2,
    exposure: 1.08,
    hemisphereSky: '#e8f1f0',
    hemisphereGround: '#25201c',
    hemisphereIntensity: 1.45,
    keyColor: '#ffe2bf',
    keyIntensity: 84,
    keyDistance: 18,
    keyAngle: Math.PI / 4.6,
    keyPenumbra: 0.48,
    keyDecay: 1.5,
    keyX: -2.5,
    keyY: 3.8,
    keyZ: 2.2,
    keyTargetX: 0,
    keyTargetY: -0.1,
    keyTargetZ: -2.7,
    rimColor: '#73b8c8',
    rimIntensity: 28,
    rimDistance: 11,
    rimDecay: 1.6,
    rimX: 2.8,
    rimY: 1.6,
    rimZ: -4.1,
    fillColor: '#ffb873',
    fillIntensity: 18,
    fillDistance: 10,
    fillDecay: 1.5,
    fillX: -3.2,
    fillY: -0.3,
    fillZ: -1.2,
  },
};

const trackerLabels: Record<TrackerState, string> = {
  connecting: '正在连接摄像头',
  tracking: '人脸跟踪中',
  calibrating: '正在校准中心',
  lost: '等待检测到人脸',
  offline: '跟踪服务未启动',
  manual: '鼠标预览模式',
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum);

const cloneSettings = () => structuredClone(DEFAULT_SETTINGS);
const baselineDepth = (settings: DisplaySettings) =>
  clamp(settings.view.eyeDistance, settings.view.zMinimum, settings.view.zMaximum);

function makeGrid(width: number, height: number, columns: number, rows: number, color: string, opacity: number) {
  const vertices: number[] = [];
  for (let column = 0; column <= columns; column += 1) {
    const x = -width / 2 + (column / columns) * width;
    vertices.push(x, -height / 2, 0, x, height / 2, 0);
  }
  for (let row = 0; row <= rows; row += 1) {
    const y = -height / 2 + (row / rows) * height;
    vertices.push(-width / 2, y, 0, width / 2, y, 0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  return new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
  );
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => material.dispose());
    }
  });
}

function createDisplayCase(settings: DisplaySettings) {
  const group = new THREE.Group();
  const { width, height, depth } = settings.case;
  const roomMaterial = new THREE.MeshStandardMaterial({
    color: settings.case.roomColor,
    roughness: settings.case.roughness,
    metalness: settings.case.metalness,
  });
  const sideMaterial = new THREE.MeshStandardMaterial({
    color: settings.case.sideColor,
    roughness: settings.case.roughness,
    metalness: settings.case.metalness,
  });
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: settings.case.floorColor,
    roughness: settings.case.roughness,
    metalness: settings.case.metalness,
  });

  const back = new THREE.Mesh(new THREE.PlaneGeometry(width, height), roomMaterial);
  back.position.z = -depth;
  back.receiveShadow = true;
  group.add(back);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -height / 2, -depth / 2);
  floor.receiveShadow = true;
  group.add(floor);

  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), sideMaterial);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, height / 2, -depth / 2);
  ceiling.receiveShadow = true;
  group.add(ceiling);

  for (const side of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(depth, height), sideMaterial);
    wall.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
    wall.position.set((width / 2) * side, 0, -depth / 2);
    wall.receiveShadow = true;
    group.add(wall);
  }

  const backGrid = makeGrid(width, height, 8, 5, settings.case.gridColor, settings.case.gridOpacity);
  backGrid.position.z = -depth + 0.012;
  group.add(backGrid);

  const floorGrid = makeGrid(width, depth, 8, 6, settings.case.gridColor, settings.case.gridOpacity);
  floorGrid.rotation.x = -Math.PI / 2;
  floorGrid.position.set(0, -height / 2 + 0.012, -depth / 2);
  group.add(floorGrid);

  const edgeGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-width / 2, -height / 2, -depth),
    new THREE.Vector3(-width / 2, height / 2, -depth),
    new THREE.Vector3(width / 2, height / 2, -depth),
    new THREE.Vector3(width / 2, -height / 2, -depth),
    new THREE.Vector3(-width / 2, -height / 2, -depth),
  ]);
  group.add(new THREE.Line(edgeGeometry, new THREE.LineBasicMaterial({ color: settings.case.edgeColor })));
  group.userData.materials = { roomMaterial, sideMaterial, floorMaterial };
  return group;
}

function createArtifact(settings: DisplaySettings) {
  const artifact = new THREE.Group();
  const bronze = new THREE.MeshStandardMaterial({
    color: settings.model.bronzeColor,
    metalness: settings.model.metalness,
    roughness: settings.model.roughness,
  });
  const darkBronze = new THREE.MeshStandardMaterial({
    color: settings.model.darkBronzeColor,
    metalness: settings.model.metalness,
    roughness: Math.min(settings.model.roughness + 0.07, 1),
  });

  const sculpture = new THREE.Mesh(new THREE.TorusKnotGeometry(0.78, 0.22, 180, 28, 2, 3), bronze);
  sculpture.rotation.set(0.48, -0.3, 0.08);
  sculpture.position.y = 0.32;
  sculpture.castShadow = true;
  sculpture.receiveShadow = true;
  artifact.add(sculpture);

  const innerRing = new THREE.Mesh(new THREE.TorusGeometry(0.74, 0.035, 12, 96), darkBronze);
  innerRing.rotation.set(Math.PI / 2.5, 0.3, -0.25);
  innerRing.position.y = 0.31;
  innerRing.castShadow = true;
  artifact.add(innerRing);

  // An asymmetric arm makes changes in viewpoint immediately readable while
  // the artifact itself remains fixed in the virtual case.
  const orientationArm = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.14, 0.2), bronze);
  orientationArm.position.set(0.95, 0.34, 0.08);
//   orientationArm.position.set(0.95, -0.1, 0.08);
  orientationArm.rotation.set(0.08, -0.38, 0.26);
  orientationArm.castShadow = true;
  artifact.add(orientationArm);

  const orientationTip = new THREE.Mesh(new THREE.SphereGeometry(0.18, 24, 16), darkBronze);
  orientationTip.position.set(1.45, 0.49, 0.27);
  orientationTip.castShadow = true;
  artifact.add(orientationTip);

  const plinthTopMaterial = new THREE.MeshStandardMaterial({ color: settings.model.plinthTopColor, metalness: 0.25, roughness: 0.32 });
  const plinthTop = new THREE.Mesh(new THREE.CylinderGeometry(1.18, 1.28, 0.14, 64), plinthTopMaterial);
  plinthTop.position.y = -0.75;
  plinthTop.castShadow = true;
  plinthTop.receiveShadow = true;
  artifact.add(plinthTop);

  const plinthMaterial = new THREE.MeshStandardMaterial({ color: settings.model.plinthColor, metalness: 0.12, roughness: 0.52 });
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.94, 1.12, 0.56, 64), plinthMaterial);
  plinth.position.y = -1.08;
  plinth.castShadow = true;
  plinth.receiveShadow = true;
  artifact.add(plinth);

  artifact.userData.materials = { bronze, darkBronze, plinthTopMaterial, plinthMaterial };
  return artifact;
}

type SceneHandles = {
  scene: THREE.Scene;
  caseGroup: THREE.Group;
  artifact: THREE.Group;
  hemisphere: THREE.HemisphereLight;
  key: THREE.SpotLight;
  rim: THREE.PointLight;
  fill: THREE.PointLight;
};

function applySceneSettings(handles: SceneHandles, settings: DisplaySettings) {
  const { scene, artifact, hemisphere, key, rim, fill } = handles;
  scene.background = new THREE.Color(settings.case.backgroundColor);
  const fog = scene.fog as THREE.Fog;
  fog.color.set(settings.case.fogColor);
  fog.near = settings.case.fogNear;
  fog.far = settings.case.fogFar;

  artifact.position.set(settings.model.x, settings.model.y, settings.model.z);
  artifact.scale.setScalar(settings.model.scale);
  const { bronze, darkBronze, plinthTopMaterial, plinthMaterial } = artifact.userData.materials as {
    bronze: THREE.MeshStandardMaterial;
    darkBronze: THREE.MeshStandardMaterial;
    plinthTopMaterial: THREE.MeshStandardMaterial;
    plinthMaterial: THREE.MeshStandardMaterial;
  };
  bronze.color.set(settings.model.bronzeColor);
  bronze.metalness = settings.model.metalness;
  bronze.roughness = settings.model.roughness;
  darkBronze.color.set(settings.model.darkBronzeColor);
  darkBronze.metalness = settings.model.metalness;
  darkBronze.roughness = Math.min(settings.model.roughness + 0.07, 1);
  plinthTopMaterial.color.set(settings.model.plinthTopColor);
  plinthMaterial.color.set(settings.model.plinthColor);

  hemisphere.color.set(settings.lighting.hemisphereSky);
  hemisphere.groundColor.set(settings.lighting.hemisphereGround);
  hemisphere.intensity = settings.lighting.hemisphereIntensity;
  key.color.set(settings.lighting.keyColor);
  key.intensity = settings.lighting.keyIntensity;
  key.distance = settings.lighting.keyDistance;
  key.angle = settings.lighting.keyAngle;
  key.penumbra = settings.lighting.keyPenumbra;
  key.decay = settings.lighting.keyDecay;
  key.position.set(settings.lighting.keyX, settings.lighting.keyY, settings.lighting.keyZ);
  key.target.position.set(settings.lighting.keyTargetX, settings.lighting.keyTargetY, settings.lighting.keyTargetZ);
  rim.color.set(settings.lighting.rimColor);
  rim.intensity = settings.lighting.rimIntensity;
  rim.distance = settings.lighting.rimDistance;
  rim.decay = settings.lighting.rimDecay;
  rim.position.set(settings.lighting.rimX, settings.lighting.rimY, settings.lighting.rimZ);
  fill.color.set(settings.lighting.fillColor);
  fill.intensity = settings.lighting.fillIntensity;
  fill.distance = settings.lighting.fillDistance;
  fill.decay = settings.lighting.fillDecay;
  fill.position.set(settings.lighting.fillX, settings.lighting.fillY, settings.lighting.fillZ);
}

function NumberControl({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.01,
  unit,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
}) {
  const update = (raw: string) => {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) onChange(clamp(numeric, min, max));
  };
  return (
    <label className="settings-control">
      <span>{label}</span>
      <span className="settings-value">{value.toFixed(step < 1 ? 2 : 0)}{unit}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => update(event.target.value)} />
      <input aria-label={label} type="number" min={min} max={max} step={step} value={value} onChange={(event) => update(event.target.value)} />
    </label>
  );
}

function ColorControl({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="settings-color-control">
      <span>{label}</span>
      <input aria-label={label} type="color" value={value} onChange={(event) => onChange(event.target.value)} />
      <code>{value}</code>
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(title === '模型' || title === '视角与深度');
  return (
    <section className="settings-section">
      <button type="button" className="settings-section-heading" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        {title}
        {open ? <ChevronUp /> : <ChevronDown />}
      </button>
      {open && <div className="settings-section-content">{children}</div>}
    </section>
  );
}

function SettingsPanel({ settings, update, reset, onClose }: {
  settings: DisplaySettings;
  update: (mutate: (draft: DisplaySettings) => void) => void;
  reset: () => void;
  onClose: () => void;
}) {
  const [urlDraft, setUrlDraft] = useState(settings.connectionUrl);
  const validUrl = (() => {
    try {
      const protocol = new URL(urlDraft).protocol;
      return protocol === 'ws:' || protocol === 'wss:';
    } catch {
      return false;
    }
  })();
  const number = (label: string, value: number, mutate: (value: number) => void, min: number, max: number, step?: number, unit?: string) => (
    <NumberControl label={label} value={value} onChange={mutate} min={min} max={max} step={step} unit={unit} />
  );
  const color = (label: string, value: string, mutate: (value: string) => void) => (
    <ColorControl label={label} value={value} onChange={mutate} />
  );
  return (
    <aside className="settings-panel" onPointerDown={(event) => event.stopPropagation()} onPointerMove={(event) => event.stopPropagation()}>
      <header className="settings-panel-header">
        <div><p>虚拟窗口</p><h2>显示设置</h2></div>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="关闭显示设置" onClick={onClose}><ChevronDown /></Button>
      </header>
      <p className="settings-intro">所有更改即时生效，仅保留到本次页面会话结束。</p>
      <div className="settings-scroll">
        <Section title="连接">
          <label className="settings-text-control"><span>跟踪 WebSocket 地址</span><input value={urlDraft} onChange={(event) => setUrlDraft(event.target.value)} spellCheck={false} /></label>
          <Button type="button" size="sm" disabled={!validUrl} onClick={() => update((draft) => { draft.connectionUrl = urlDraft; })}>连接此地址</Button>
          {!validUrl && <p className="settings-error">请输入以 ws:// 或 wss:// 开头的地址。</p>}
        </Section>
        <Section title="视角与深度">
          {number('默认观察距离', settings.view.eyeDistance, (value) => update((d) => { d.view.eyeDistance = value; }), 1, 20, 0.1)}
          {number('相机近平面', settings.view.near, (value) => update((d) => { d.view.near = Math.min(value, d.view.far - 0.1); }), 0.02, 5, 0.01)}
          {number('相机远平面', settings.view.far, (value) => update((d) => { d.view.far = Math.max(value, d.view.near + 0.1); }), 5, 100, 1)}
          {number('鼠标水平幅度', settings.view.mouseXGain, (value) => update((d) => { d.view.mouseXGain = value; }), 0, 4, 0.01)}
          {number('鼠标垂直幅度', settings.view.mouseYGain, (value) => update((d) => { d.view.mouseYGain = value; }), 0, 4, 0.01)}
          {number('过渡平滑度', settings.view.smoothing, (value) => update((d) => { d.view.smoothing = value; }), 1, 30, 1)}
        </Section>
        <Section title="跟踪响应">
          {number('水平跟随增益', settings.view.positionGain, (value) => update((d) => { d.view.positionGain = value; }), 0, 40, 0.1)}
          {number('纵深跟随增益', settings.view.depthGain, (value) => update((d) => { d.view.depthGain = value; }), 0, 40, 0.1)}
          {number('水平最大偏移', settings.view.xLimit, (value) => update((d) => { d.view.xLimit = value; }), 0.1, 8, 0.1)}
          {number('垂直最大偏移', settings.view.yLimit, (value) => update((d) => { d.view.yLimit = value; }), 0.1, 8, 0.1)}
          {number('观察距离最小值', settings.view.zMinimum, (value) => update((d) => { d.view.zMinimum = Math.min(value, d.view.zMaximum - 0.1); }), 0.5, 20, 0.1)}
          {number('观察距离最大值', settings.view.zMaximum, (value) => update((d) => { d.view.zMaximum = Math.max(value, d.view.zMinimum + 0.1); }), 1, 30, 0.1)}
          <label className="settings-toggle"><span>反转摄像头水平移动</span><input type="checkbox" checked={settings.view.invertX} onChange={(event) => update((d) => { d.view.invertX = event.target.checked; })} /></label>
        </Section>
        <Section title="展示箱">
          {number('宽度', settings.case.width, (value) => update((d) => { d.case.width = value; }), 2, 20, 0.1)}
          {number('高度', settings.case.height, (value) => update((d) => { d.case.height = value; }), 2, 15, 0.1)}
          {number('深度', settings.case.depth, (value) => update((d) => { d.case.depth = value; }), 1, 20, 0.1)}
          {number('网格透明度', settings.case.gridOpacity, (value) => update((d) => { d.case.gridOpacity = value; }), 0, 1, 0.01)}
          {number('表面粗糙度', settings.case.roughness, (value) => update((d) => { d.case.roughness = value; }), 0, 1, 0.01)}
          {number('表面金属度', settings.case.metalness, (value) => update((d) => { d.case.metalness = value; }), 0, 1, 0.01)}
          {number('雾起点', settings.case.fogNear, (value) => update((d) => { d.case.fogNear = Math.min(value, d.case.fogFar - 0.1); }), 0, 80, 0.5)}
          {number('雾终点', settings.case.fogFar, (value) => update((d) => { d.case.fogFar = Math.max(value, d.case.fogNear + 0.1); }), 1, 100, 0.5)}
          {color('后墙', settings.case.roomColor, (value) => update((d) => { d.case.roomColor = value; }))}
          {color('侧墙与顶棚', settings.case.sideColor, (value) => update((d) => { d.case.sideColor = value; }))}
          {color('地面', settings.case.floorColor, (value) => update((d) => { d.case.floorColor = value; }))}
          {color('网格', settings.case.gridColor, (value) => update((d) => { d.case.gridColor = value; }))}
          {color('后框边线', settings.case.edgeColor, (value) => update((d) => { d.case.edgeColor = value; }))}
          {color('场景背景', settings.case.backgroundColor, (value) => update((d) => { d.case.backgroundColor = value; }))}
          {color('雾颜色', settings.case.fogColor, (value) => update((d) => { d.case.fogColor = value; }))}
        </Section>
        <Section title="模型">
          <p className="settings-hint"><strong>屏幕平面 Z：</strong>负值在屏幕内，0 在屏幕平面，正值在屏幕外。</p>
          {number('模型 X', settings.model.x, (value) => update((d) => { d.model.x = value; }), -8, 8, 0.01)}
          {number('模型 Y', settings.model.y, (value) => update((d) => { d.model.y = value; }), -6, 6, 0.01)}
          {number('屏幕平面 Z', settings.model.z, (value) => update((d) => { d.model.z = value; }), -12, 4.8, 0.01)}
          {number('统一缩放', settings.model.scale, (value) => update((d) => { d.model.scale = value; }), 0.1, 4, 0.01)}
          {number('金属度', settings.model.metalness, (value) => update((d) => { d.model.metalness = value; }), 0, 1, 0.01)}
          {number('粗糙度', settings.model.roughness, (value) => update((d) => { d.model.roughness = value; }), 0, 1, 0.01)}
          {color('主金属', settings.model.bronzeColor, (value) => update((d) => { d.model.bronzeColor = value; }))}
          {color('深色金属', settings.model.darkBronzeColor, (value) => update((d) => { d.model.darkBronzeColor = value; }))}
          {color('台座顶面', settings.model.plinthTopColor, (value) => update((d) => { d.model.plinthTopColor = value; }))}
          {color('台座底座', settings.model.plinthColor, (value) => update((d) => { d.model.plinthColor = value; }))}
        </Section>
        <Section title="外观与灯光">
          {number('渲染像素比上限', settings.lighting.pixelRatioCap, (value) => update((d) => { d.lighting.pixelRatioCap = value; }), 1, 3, 0.1)}
          {number('色调曝光', settings.lighting.exposure, (value) => update((d) => { d.lighting.exposure = value; }), 0.1, 3, 0.01)}
          {number('半球光强度', settings.lighting.hemisphereIntensity, (value) => update((d) => { d.lighting.hemisphereIntensity = value; }), 0, 5, 0.01)}
          {number('主灯强度', settings.lighting.keyIntensity, (value) => update((d) => { d.lighting.keyIntensity = value; }), 0, 150, 1)}
          {number('主灯距离', settings.lighting.keyDistance, (value) => update((d) => { d.lighting.keyDistance = value; }), 0, 50, 0.5)}
          {number('主灯光锥角', settings.lighting.keyAngle, (value) => update((d) => { d.lighting.keyAngle = value; }), 0.01, Math.PI / 2, 0.01, ' rad')}
          {number('主灯衰减', settings.lighting.keyDecay, (value) => update((d) => { d.lighting.keyDecay = value; }), 0, 4, 0.01)}
          {number('主灯 X', settings.lighting.keyX, (value) => update((d) => { d.lighting.keyX = value; }), -20, 20, 0.1)}
          {number('主灯 Y', settings.lighting.keyY, (value) => update((d) => { d.lighting.keyY = value; }), -20, 20, 0.1)}
          {number('主灯 Z', settings.lighting.keyZ, (value) => update((d) => { d.lighting.keyZ = value; }), -20, 20, 0.1)}
          {number('主灯目标 X', settings.lighting.keyTargetX, (value) => update((d) => { d.lighting.keyTargetX = value; }), -20, 20, 0.1)}
          {number('主灯目标 Y', settings.lighting.keyTargetY, (value) => update((d) => { d.lighting.keyTargetY = value; }), -20, 20, 0.1)}
          {number('主灯目标 Z', settings.lighting.keyTargetZ, (value) => update((d) => { d.lighting.keyTargetZ = value; }), -20, 20, 0.1)}
          {number('主灯柔边', settings.lighting.keyPenumbra, (value) => update((d) => { d.lighting.keyPenumbra = value; }), 0, 1, 0.01)}
          {number('轮廓光强度', settings.lighting.rimIntensity, (value) => update((d) => { d.lighting.rimIntensity = value; }), 0, 80, 1)}
          {number('轮廓光距离', settings.lighting.rimDistance, (value) => update((d) => { d.lighting.rimDistance = value; }), 0, 50, 0.5)}
          {number('轮廓光衰减', settings.lighting.rimDecay, (value) => update((d) => { d.lighting.rimDecay = value; }), 0, 4, 0.01)}
          {number('轮廓光 X', settings.lighting.rimX, (value) => update((d) => { d.lighting.rimX = value; }), -20, 20, 0.1)}
          {number('轮廓光 Y', settings.lighting.rimY, (value) => update((d) => { d.lighting.rimY = value; }), -20, 20, 0.1)}
          {number('轮廓光 Z', settings.lighting.rimZ, (value) => update((d) => { d.lighting.rimZ = value; }), -20, 20, 0.1)}
          {number('补光强度', settings.lighting.fillIntensity, (value) => update((d) => { d.lighting.fillIntensity = value; }), 0, 80, 1)}
          {number('补光距离', settings.lighting.fillDistance, (value) => update((d) => { d.lighting.fillDistance = value; }), 0, 50, 0.5)}
          {number('补光衰减', settings.lighting.fillDecay, (value) => update((d) => { d.lighting.fillDecay = value; }), 0, 4, 0.01)}
          {number('补光 X', settings.lighting.fillX, (value) => update((d) => { d.lighting.fillX = value; }), -20, 20, 0.1)}
          {number('补光 Y', settings.lighting.fillY, (value) => update((d) => { d.lighting.fillY = value; }), -20, 20, 0.1)}
          {number('补光 Z', settings.lighting.fillZ, (value) => update((d) => { d.lighting.fillZ = value; }), -20, 20, 0.1)}
          {color('半球天空色', settings.lighting.hemisphereSky, (value) => update((d) => { d.lighting.hemisphereSky = value; }))}
          {color('半球地面色', settings.lighting.hemisphereGround, (value) => update((d) => { d.lighting.hemisphereGround = value; }))}
          {color('主灯色', settings.lighting.keyColor, (value) => update((d) => { d.lighting.keyColor = value; }))}
          {color('轮廓光色', settings.lighting.rimColor, (value) => update((d) => { d.lighting.rimColor = value; }))}
          {color('补光色', settings.lighting.fillColor, (value) => update((d) => { d.lighting.fillColor = value; }))}
        </Section>
      </div>
      <footer className="settings-footer"><Button type="button" variant="outline" size="sm" onClick={reset}><Undo2 />恢复默认</Button></footer>
    </aside>
  );
}

export function DisplayCase() {
  const mountRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<DisplaySettings>(cloneSettings());
  const targetRef = useRef<ViewPosition>({ x: 0, y: 0, z: baselineDepth(settingsRef.current) });
  const resetRef = useRef<() => void>(() => {});
  const draggingRef = useRef(false);
  const faceEnabledRef = useRef(true);
  const socketReadyRef = useRef(false);
  const neutralPositionRef = useRef<ViewerPosition | null>(null);
  const [settings, setSettings] = useState<DisplaySettings>(() => cloneSettings());
  const [isMoving, setIsMoving] = useState(false);
  const [faceEnabled, setFaceEnabled] = useState(true);
  const [trackerState, setTrackerState] = useState<TrackerState>('connecting');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const updateSettings = useCallback((mutate: (draft: DisplaySettings) => void) => {
    setSettings((previous) => {
      const next = structuredClone(previous);
      mutate(next);
      settingsRef.current = next;
      return next;
    });
  }, []);
  const resetSettings = useCallback(() => {
    const next = cloneSettings();
    settingsRef.current = next;
    setSettings(next);
  }, []);

  const calibrateFace = useCallback(() => {
    neutralPositionRef.current = null;
    targetRef.current = { x: 0, y: 0, z: baselineDepth(settingsRef.current) };
    setIsMoving(false);
    setTrackerState(socketReadyRef.current ? 'calibrating' : 'offline');
    resetRef.current();
  }, []);

  const resetView = useCallback(() => {
    if (faceEnabledRef.current) return calibrateFace();
    targetRef.current = { x: 0, y: 0, z: baselineDepth(settingsRef.current) };
    draggingRef.current = false;
    setIsMoving(false);
    resetRef.current();
  }, [calibrateFace]);

  const toggleTrackingMode = useCallback(() => {
    const enabled = !faceEnabledRef.current;
    faceEnabledRef.current = enabled;
    setFaceEnabled(enabled);
    draggingRef.current = false;
    targetRef.current = { x: 0, y: 0, z: baselineDepth(settingsRef.current) };
    resetRef.current();
    if (enabled) {
      neutralPositionRef.current = null;
      setTrackerState(socketReadyRef.current ? 'calibrating' : 'connecting');
    } else setTrackerState('manual');
  }, []);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let lostTimer: number | undefined;
    const connect = () => {
      if (disposed) return;
      if (faceEnabledRef.current) setTrackerState('connecting');
      socket = new WebSocket(settings.connectionUrl);
      socket.onopen = () => {
        socketReadyRef.current = true;
        if (faceEnabledRef.current) setTrackerState(neutralPositionRef.current ? 'lost' : 'calibrating');
      };
      socket.onmessage = (event) => {
        if (!faceEnabledRef.current) return;
        let packet: TrackingPacket;
        try { packet = JSON.parse(event.data) as TrackingPacket; } catch { return; }
        const position = packet.face?.viewer_position_m?.filtered;
        const currentSettings = settingsRef.current;
        if (!packet.tracking || !position) {
          setTrackerState('lost');
          window.clearTimeout(lostTimer);
          lostTimer = window.setTimeout(() => {
            targetRef.current = { x: 0, y: 0, z: baselineDepth(settingsRef.current) };
          }, currentSettings.view.lostResetMs);
          return;
        }
        window.clearTimeout(lostTimer);
        if (!neutralPositionRef.current) {
          neutralPositionRef.current = { ...position };
          targetRef.current = { x: 0, y: 0, z: baselineDepth(currentSettings) };
          setTrackerState('tracking');
          return;
        }
        const neutral = neutralPositionRef.current;
        const horizontalDirection = currentSettings.view.invertX ? -1 : 1;
        targetRef.current = {
          x: clamp((position.x - neutral.x) * currentSettings.view.positionGain * horizontalDirection, -currentSettings.view.xLimit, currentSettings.view.xLimit),
          y: clamp((position.y - neutral.y) * currentSettings.view.positionGain, -currentSettings.view.yLimit, currentSettings.view.yLimit),
          z: clamp(currentSettings.view.eyeDistance + (position.z - neutral.z) * currentSettings.view.depthGain, currentSettings.view.zMinimum, currentSettings.view.zMaximum),
        };
        setTrackerState('tracking');
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        socketReadyRef.current = false;
        if (faceEnabledRef.current) setTrackerState('offline');
        if (!disposed) reconnectTimer = window.setTimeout(connect, settingsRef.current.view.reconnectMs);
      };
    };
    connect();
    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(lostTimer);
      socket?.close();
    };
  }, [settings.connectionUrl]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const initial = settingsRef.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(initial.case.backgroundColor);
    scene.fog = new THREE.Fog(initial.case.fogColor, initial.case.fogNear, initial.case.fogFar);
    const camera = new THREE.PerspectiveCamera(45, 16 / 9, initial.view.near, initial.view.far);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    mount.appendChild(renderer.domElement);

    let caseKey = '';
    let caseGroup = createDisplayCase(initial);
    scene.add(caseGroup);
    const artifact = createArtifact(initial);
    scene.add(artifact);
    const hemisphere = new THREE.HemisphereLight();
    const key = new THREE.SpotLight();
    key.target.position.set(0, -0.1, -2.7);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.00025;
    const rim = new THREE.PointLight();
    const fill = new THREE.PointLight();
    scene.add(hemisphere, key, key.target, rim, fill);
    const handles: SceneHandles = { scene, caseGroup, artifact, hemisphere, key, rim, fill };
    const current = new THREE.Vector3(0, 0, baselineDepth(initial));
    const desired = new THREE.Vector3(0, 0, baselineDepth(initial));
    let animationFrame = 0;
    let previousAnimationTime = performance.now();

    const resize = () => renderer.setSize(mount.clientWidth, mount.clientHeight);
    const updateOffAxisProjection = (eye: THREE.Vector3, active: DisplaySettings) => {
      const distanceToScreen = Math.max(eye.z, active.view.near * 2);
      const scale = active.view.near / distanceToScreen;
      const left = (-active.case.width / 2 - eye.x) * scale;
      const right = (active.case.width / 2 - eye.x) * scale;
      const bottom = (-active.case.height / 2 - eye.y) * scale;
      const top = (active.case.height / 2 - eye.y) * scale;
      camera.projectionMatrix.makePerspective(left, right, top, bottom, active.view.near, active.view.far);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    };
    const animate = (animationTime = performance.now()) => {
      animationFrame = requestAnimationFrame(animate);
      const active = settingsRef.current;
      const nextCaseKey = JSON.stringify(active.case);
      if (nextCaseKey !== caseKey) {
        scene.remove(caseGroup);
        disposeObject(caseGroup);
        caseGroup = createDisplayCase(active);
        handles.caseGroup = caseGroup;
        scene.add(caseGroup);
        caseKey = nextCaseKey;
      }
      applySceneSettings(handles, active);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, active.lighting.pixelRatioCap));
      renderer.toneMappingExposure = active.lighting.exposure;
      camera.near = active.view.near;
      camera.far = active.view.far;
      const deltaSeconds = Math.min((animationTime - previousAnimationTime) / 1000, 0.1);
      previousAnimationTime = animationTime;
      desired.set(targetRef.current.x, targetRef.current.y, targetRef.current.z);
      const smoothing = 1 - Math.exp(-active.view.smoothing * deltaSeconds);
      current.lerp(desired, smoothing);
      camera.position.copy(current);
      camera.quaternion.identity();
      camera.updateMatrixWorld();
      updateOffAxisProjection(current, active);
      renderer.render(scene, camera);
    };
    resetRef.current = () => desired.set(0, 0, baselineDepth(settingsRef.current));
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();
    animate();
    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      disposeObject(scene);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  const moveView = (event: React.PointerEvent<HTMLDivElement>) => {
    if (faceEnabledRef.current || !draggingRef.current) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    const y = 1 - ((event.clientY - bounds.top) / bounds.height) * 2;
    const active = settingsRef.current;
    targetRef.current = { x: x * active.view.mouseXGain, y: y * active.view.mouseYGain, z: baselineDepth(active) };
    setIsMoving(true);
  };
  const startView = (event: React.PointerEvent<HTMLDivElement>) => {
    if (faceEnabledRef.current) return;
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsMoving(true);
    moveView(event);
  };
  const endView = (event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setIsMoving(false);
  };
  const toggleFullscreen = () => {
    const element = mountRef.current?.closest<HTMLElement>('.case-shell');
    if (!element) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void element.requestFullscreen();
  };

  const statusLabel = !faceEnabled && isMoving ? '鼠标视角偏移' : trackerLabels[trackerState];
  const statusColor = trackerState === 'tracking' ? 'bg-[#71c8a2]' : trackerState === 'offline' ? 'bg-[#e36f63]' : trackerState === 'lost' ? 'bg-[#e8a45e]' : 'bg-[#7fb3c8]';
  return (
    <section className="w-[min(100vw,177.78vh)] max-w-none">
      <div className="case-shell relative overflow-hidden bg-[#101415] shadow-[0_42px_100px_rgba(0,0,0,0.55)]">
        <div data-case-viewport className="relative aspect-video w-full cursor-crosshair overflow-hidden bg-[#171b1c]" onPointerDown={startView} onPointerMove={moveView} onPointerUp={endView} onPointerCancel={endView}>
          <div ref={mountRef} className="absolute inset-0" aria-label="三维虚拟展示箱" />
          <div className="screen-frame pointer-events-none absolute inset-0 z-30" aria-hidden="true" />
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-end bg-gradient-to-b from-black/40 to-transparent px-5 pb-12 pt-5 sm:px-8 sm:pt-7"><div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-[11px] text-white/65 backdrop-blur-md"><span className={`size-1.5 rounded-full ${statusColor}`} />{statusLabel}</div></div>
          {settingsOpen && <SettingsPanel settings={settings} update={updateSettings} reset={resetSettings} onClose={() => setSettingsOpen(false)} />}
          <div className="absolute bottom-4 left-4 right-4 z-40 flex items-end justify-end gap-3 sm:bottom-7 sm:left-8 sm:right-8"><div className="flex gap-2">
            <Button type="button" variant="outline" size="icon-lg" aria-label={faceEnabled ? '切换到鼠标模式' : '启用人脸跟踪'} onClick={toggleTrackingMode} className={`border-white/15 text-white hover:bg-black/55 hover:text-white ${faceEnabled ? 'bg-[#6f9f91]/45' : 'bg-black/35'}`}>{faceEnabled ? <ScanFace /> : <MousePointer2 />}</Button>
            <Button type="button" variant="outline" size="icon-lg" aria-label={faceEnabled ? '重新校准中心' : '复位视角'} onClick={resetView} className="border-white/15 bg-black/35 text-white hover:bg-black/55 hover:text-white">{faceEnabled ? <LocateFixed /> : <RotateCcw />}</Button>
            <Button type="button" variant="outline" size="icon-lg" aria-label="打开显示设置" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((current) => !current)} className={`border-white/15 text-white hover:bg-black/55 hover:text-white ${settingsOpen ? 'bg-[#6f9f91]/45' : 'bg-black/35'}`}><Settings2 /></Button>
            <Button type="button" variant="outline" size="icon-lg" aria-label="全屏查看" onClick={toggleFullscreen} className="border-white/15 bg-black/35 text-white hover:bg-black/55 hover:text-white"><Maximize2 /></Button>
          </div></div>
        </div>
      </div>
    </section>
  );
}
