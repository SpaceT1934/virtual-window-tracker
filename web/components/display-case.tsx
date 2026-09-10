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
import {
  DEFAULT_BACKEND_FOV_DEG,
  MAX_CALIBRATION_FOV_DEG,
  MIN_CALIBRATION_FOV_DEG,
  depthScaleFor,
  setTrueFovDeg,
  useTrueFovDeg,
} from '@/lib/fov-calibration';
import { RenderBudget, renderPixelRatio } from '@/lib/render-budget';
import { WindowMotion } from '@/lib/window-motion';
import { applyWindowProjection } from '@/lib/window-projection';
import { TrackingSession, physicalView } from '@/lib/window-tracking';
import { windowPlaneFromAnchor } from '@/lib/window-anchor';

type ViewPosition = { x: number; y: number; z: number };
type ViewerPosition = { x: number; y: number; z: number };
type TrackerState = 'connecting' | 'tracking' | 'calibrating' | 'lost' | 'offline' | 'manual';
type TrackingPacket = {
  frame?: { fps?: number };
  tracking?: boolean;
  camera_hfov_deg?: number;
  face?: { viewer_position_m?: { filtered?: ViewerPosition } | null } | null;
};

type WindowSettings = {
  enabled: boolean;
  lockAspect: boolean;
  x: number;
  y: number;
  z: number;
  rotationX: number;
  rotationY: number;
  rotationZ: number;
  width: number;
  height: number;
  scale: number;
  trackingScale: number;
};
type PresentationMode = 'model' | 'window';

type DisplaySettings = {
  presentationMode: PresentationMode;
  connectionUrl: string;
  view: {
    visibleWidthM: number;
    neutralDistanceM: number;
    minimumEyeDistanceM: number;
    cameraOffsetX: number;
    cameraOffsetY: number;
    cameraOffsetZ: number;
    near: number;
    far: number;
    invertX: boolean;
    mouseDragEnabled: boolean;
    smoothing: number;
    lostResetMs: number;
    reconnectMs: number;
  };
  case: {
    visible: boolean;
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
    skyColor: string;
  };
  model: {
    x: number;
    y: number;
    rotationX: number;
    rotationY: number;
    rotationZ: number;
    depthM: number;
    scale: number;
    bronzeColor: string;
    darkBronzeColor: string;
    plinthTopColor: string;
    plinthColor: string;
    metalness: number;
    roughness: number;
  };
  window: WindowSettings;
  lighting: {
    autoResolution: boolean;
    maxRenderMegapixels: number;
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
  presentationMode: 'model',
  connectionUrl: 'ws://127.0.0.1:8765/ws/v1/tracking',
  view: {
    visibleWidthM: 0.30,
    neutralDistanceM: 0.6,
    minimumEyeDistanceM: 0.03,
    cameraOffsetX: 0,
    cameraOffsetY: 0,
    cameraOffsetZ: 0,
    near: 0.1,
    far: 200,
    invertX: true,
    mouseDragEnabled: true,
    smoothing: 28,
    lostResetMs: 700,
    reconnectMs: 1500,
  },
  case: {
    visible: true,
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
    skyColor: '#4d6870',
  },
  model: {
    x: 0,
    y: -0.18,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
    depthM: -0.12,
    scale: 1.08,
    bronzeColor: '#9e6738',
    darkBronzeColor: '#30241e',
    plinthTopColor: '#1c2021',
    plinthColor: '#101415',
    metalness: 0.78,
    roughness: 0.28,
  },
  window: {
    enabled: false,
    lockAspect: true,
    x: 0,
    y: 0,
    z: 0,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
    width: 8,
    height: 4.5,
    scale: 1,
    // GLB files commonly use scene units larger than metres. Keep tracking
    // motion conservative by default; users can raise this after matching the
    // window width to the asset's authored units.
    trackingScale: 0.35,
  },
  lighting: {
    autoResolution: false,
    maxRenderMegapixels: 8.3,
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
const SETTINGS_STORAGE_KEY = 'virtual-window-tracker.settings.v2';
function loadStoredSettings(): DisplaySettings {
  if (typeof window === 'undefined') return cloneSettings();
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return cloneSettings();
    const saved = JSON.parse(raw) as Partial<DisplaySettings>;
    const defaults = cloneSettings();
    const presentationMode = saved.presentationMode ?? (saved.window?.enabled ? 'window' : 'model');
    return {
      ...defaults,
      ...saved,
      presentationMode,
      view: { ...defaults.view, ...saved.view },
      case: { ...defaults.case, ...saved.case },
      model: { ...defaults.model, ...saved.model },
      window: { ...defaults.window, ...saved.window },
      lighting: { ...defaults.lighting, ...saved.lighting },
    };
  } catch {
    return cloneSettings();
  }
}
const baselineDepth = (settings: DisplaySettings) =>
  settings.view.neutralDistanceM * settings.case.width / settings.view.visibleWidthM;
const baselineDepthForWindow = (settings: DisplaySettings) =>
  settings.view.neutralDistanceM * (settings.presentationMode === 'window' ? settings.window.width * settings.window.scale : settings.case.width) / settings.view.visibleWidthM * (settings.presentationMode === 'window' ? settings.window.trackingScale : 1);

/** Convert the model's depth to the same world units used by the screen plane. */
const modelWorldZ = (settings: DisplaySettings) =>
  settings.model.depthM * settings.case.width / settings.view.visibleWidthM;

function windowFrame(settings: DisplaySettings) {
  const w = settings.window;
  const center = new THREE.Vector3(w.x, w.y, w.z);
  // FPS orientation: yaw around world Y and pitch around the camera-local X
  // axis. Build an orthonormal basis directly instead of composing XYZ
  // Euler rotations, which can introduce an unintended roll around Z.
  const yaw = w.rotationY;
  const pitch = clamp(w.rotationX, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const right = new THREE.Vector3(cosYaw, 0, sinYaw);
  const up = new THREE.Vector3(sinYaw * sinPitch, cosPitch, -cosYaw * sinPitch);
  const width = Math.max(0.1, w.width * w.scale);
  const height = Math.max(0.1, (w.lockAspect ? w.width * settings.case.height / settings.case.width : w.height) * w.scale);
  return { center, right, up, width, height };
}

function presentationFrame(settings: DisplaySettings) {
  if (settings.presentationMode === 'window') return windowFrame(settings);
  return {
    center: new THREE.Vector3(0, 0, 0),
    right: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    width: settings.case.width,
    height: settings.case.height,
  };
}

function placeWindowInFrontOfEye(settings: DisplaySettings, eye: THREE.Vector3) {
  const frame = windowFrame(settings);
  const normal = frame.right.clone().cross(frame.up).normalize();
  const distance = baselineDepthForWindow(settings);
  const center = eye.clone().addScaledVector(normal, -distance);
  settings.window.x = center.x;
  settings.window.y = center.y;
  settings.window.z = center.z;
}

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
  group.visible = settings.case.visible;
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
  const showCase = settings.case.visible && settings.presentationMode === 'model';
  scene.background = new THREE.Color(showCase ? settings.case.backgroundColor : settings.case.skyColor);
  // Window mode is a view into the uploaded world. The showcase box is a
  // separate presentation environment and must not appear around that view.
  handles.caseGroup.visible = showCase;
  artifact.position.set(settings.model.x, settings.model.y, modelWorldZ(settings));
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
  const [open, setOpen] = useState(title === '模型' || title === '视角与深度' || title === '跟踪响应' || title === '虚拟窗户');
  const order = title === '视角与深度' ? 'view' : title === '模型' ? 'model' : title === '虚拟窗户' ? 'window' : title === '跟踪响应' ? 'tracking' : title === '展示箱' ? 'case' : title === '连接' ? 'connection' : 'advanced';
  return (
    <section className={`settings-section settings-section-${order}`}>
      <button type="button" className="settings-section-heading" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        {title}
        {open ? <ChevronUp /> : <ChevronDown />}
      </button>
      {open && <div className="settings-section-content">{children}</div>}
    </section>
  );
}

function SettingsPanel({ settings, update, reset, onClose, backendFovDeg, onModeChange }: {
  settings: DisplaySettings;
  update: (mutate: (draft: DisplaySettings) => void) => void;
  reset: () => void;
  onClose: () => void;
  backendFovDeg: number;
  onModeChange: (mode: PresentationMode) => void;
}) {
  const isWindowMode = settings.presentationMode === 'window';
  const [urlDraft, setUrlDraft] = useState(settings.connectionUrl);
  const [trueFov, setTrueFov] = useTrueFovDeg();
  const depthScale = depthScaleFor(backendFovDeg, trueFov);
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
        <div><p>虚拟窗口</p><h2>{isWindowMode ? '窗户模式设置' : '模型展示设置'}</h2></div>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="关闭显示设置" onClick={onClose}><ChevronDown /></Button>
      </header>
      <div className="settings-mode-tabs" role="tablist" aria-label="显示模式">
        <button type="button" role="tab" aria-selected={!isWindowMode} className={!isWindowMode ? 'active' : ''} onClick={() => onModeChange('model')}>模型展示</button>
        <button type="button" role="tab" aria-selected={isWindowMode} className={isWindowMode ? 'active' : ''} onClick={() => onModeChange('window')}>窗户模式</button>
      </div>
      <p className="settings-intro">更改即时生效，并保存在此浏览器；恢复默认会回到原始参数。</p>
      <div className="settings-scroll">
        <Section title="连接">
          <label className="settings-text-control"><span>跟踪 WebSocket 地址</span><input value={urlDraft} onChange={(event) => setUrlDraft(event.target.value)} spellCheck={false} /></label>
          <Button type="button" size="sm" disabled={!validUrl} onClick={() => update((draft) => { draft.connectionUrl = urlDraft; })}>连接此地址</Button>
          {!validUrl && <p className="settings-error">请输入以 ws:// 或 wss:// 开头的地址。</p>}
        </Section>
        <Section title="视角与深度">
          <p className="settings-hint">统一使用真实尺寸窗口投影。请测量可见画面宽度和校准时眼睛到屏幕的距离（米）；全屏或调整窗口尺寸后请重新校准。</p>
          {number('画面区域实测宽度', settings.view.visibleWidthM, (value) => update((d) => { d.view.visibleWidthM = value; }), 0.1, 3, 0.01, ' m')}
          {number('校准时眼屏距离', settings.view.neutralDistanceM, (value) => update((d) => { d.view.neutralDistanceM = value; }), 0.2, 2, 0.01, ' m')}
          {number('最小眼屏距离', settings.view.minimumEyeDistanceM, (value) => update((d) => { d.view.minimumEyeDistanceM = value; }), 0.01, 0.3, 0.01, ' m')}
          <p className="settings-hint">摄像头与屏幕平行时，填写摄像头相对屏幕中心的偏置（米）。X 向右、Y 向上、Z 向观看者。</p>
          {number('摄像头偏置 X', settings.view.cameraOffsetX, (value) => update((d) => { d.view.cameraOffsetX = value; }), -1, 1, 0.001, ' m')}
          {number('摄像头偏置 Y', settings.view.cameraOffsetY, (value) => update((d) => { d.view.cameraOffsetY = value; }), -1, 1, 0.001, ' m')}
          {number('摄像头偏置 Z', settings.view.cameraOffsetZ, (value) => update((d) => { d.view.cameraOffsetZ = value; }), -1, 1, 0.001, ' m')}
          {number('相机近平面', settings.view.near, (value) => update((d) => { d.view.near = Math.min(value, d.view.far - 0.1); }), 0.02, 5, 0.01)}
          {number('相机远平面', settings.view.far, (value) => update((d) => { d.view.far = Math.max(value, d.view.near + 0.1); }), 5, 5000, 1)}
          {number('跟随速度（越大越快）', settings.view.smoothing, (value) => update((d) => { d.view.smoothing = value; }), 1, 60, 1)}
        </Section>
        <Section title="跟踪响应">
          <p className="settings-hint">X、Y、Z 均使用同一米制比例；Z 为眼睛相对校准位置的真实前后移动。</p>
          <p className="settings-hint">实时视场角校正：深度由后端的视场角推算（z 与 tan(hfov/2) 成反比），广角摄像头沿用默认值会把距离算大、跟随幅度偏小。改成摄像头的真实视场角即可，只影响深度、x/y 无需修正；想用实测距离核对 z，去 /debug 页面看。</p>
          {number('真实水平视场角', trueFov ?? backendFovDeg, (value) => setTrueFov(value), MIN_CALIBRATION_FOV_DEG, MAX_CALIBRATION_FOV_DEG, 1, '°')}
          <div className="flex flex-wrap items-center gap-3 text-xs text-white/60">
            <Button type="button" variant="outline" size="sm" disabled={trueFov === null} onClick={() => setTrueFov(null)}>跟随后端</Button>
            <span>后端设定 <code>{backendFovDeg.toFixed(1)}°</code></span>
            <span>深度系数 <code className={depthScale === 1 ? undefined : 'text-amber-300'}>×{depthScale.toFixed(3)}</code></span>
            {trueFov !== null && <span className="text-amber-300">修正已生效</span>}
          </div>
          <label className="settings-toggle"><span>反转摄像头水平移动</span><input type="checkbox" checked={settings.view.invertX} onChange={(event) => update((d) => { d.view.invertX = event.target.checked; })} /></label>
          <label className="settings-toggle"><span>鼠标拖拽旋转模型</span><input type="checkbox" disabled={isWindowMode} checked={isWindowMode ? false : settings.view.mouseDragEnabled} onChange={(event) => update((d) => { d.view.mouseDragEnabled = event.target.checked; })} /></label>
        </Section>
        <Section title="展示箱">
          <label className="settings-toggle"><span>显示演示盒子（可选背景内容）</span><input type="checkbox" checked={settings.case.visible} onChange={(event) => update((d) => { d.case.visible = event.target.checked; })} /></label>
          {number('宽度', settings.case.width, (value) => update((d) => { d.case.width = value; }), 2, 20, 0.1)}
          {number('高度', settings.case.height, (value) => update((d) => { d.case.height = value; }), 2, 15, 0.1)}
          {number('深度', settings.case.depth, (value) => update((d) => { d.case.depth = value; }), 1, 20, 0.1)}
          {number('网格透明度', settings.case.gridOpacity, (value) => update((d) => { d.case.gridOpacity = value; }), 0, 1, 0.01)}
          {number('表面粗糙度', settings.case.roughness, (value) => update((d) => { d.case.roughness = value; }), 0, 1, 0.01)}
          {number('表面金属度', settings.case.metalness, (value) => update((d) => { d.case.metalness = value; }), 0, 1, 0.01)}
          {color('后墙', settings.case.roomColor, (value) => update((d) => { d.case.roomColor = value; }))}
          {color('侧墙与顶棚', settings.case.sideColor, (value) => update((d) => { d.case.sideColor = value; }))}
          {color('地面', settings.case.floorColor, (value) => update((d) => { d.case.floorColor = value; }))}
          {color('网格', settings.case.gridColor, (value) => update((d) => { d.case.gridColor = value; }))}
          {color('后框边线', settings.case.edgeColor, (value) => update((d) => { d.case.edgeColor = value; }))}
          {color('场景背景', settings.case.backgroundColor, (value) => update((d) => { d.case.backgroundColor = value; }))}
          {color('无盒子时天空色', settings.case.skyColor, (value) => update((d) => { d.case.skyColor = value; }))}
        </Section>
        {!isWindowMode && <Section title="模型">
          <p className="settings-hint">世界坐标中屏幕平面固定为 <strong>z = 0</strong>；屏幕后方为负，朝向观看者为正。观察点 z 是眼睛到屏幕的距离，不是模型 z。</p>
          {number('模型 X（场景单位）', settings.model.x, (value) => update((d) => { d.model.x = value; }), -8, 8, 0.01)}
          {number('模型 Y（场景单位）', settings.model.y, (value) => update((d) => { d.model.y = value; }), -6, 6, 0.01)}
          {number('相对窗口深度（米）', settings.model.depthM, (value) => update((d) => { d.model.depthM = value; }), -2, 2, 0.01, ' m')}
          {number('模型旋转 X', settings.model.rotationX, (value) => update((d) => { d.model.rotationX = value; }), -Math.PI, Math.PI, 0.01, ' rad')}
          {number('模型旋转 Y', settings.model.rotationY, (value) => update((d) => { d.model.rotationY = value; }), -Math.PI, Math.PI, 0.01, ' rad')}
          {number('模型旋转 Z', settings.model.rotationZ, (value) => update((d) => { d.model.rotationZ = value; }), -Math.PI, Math.PI, 0.01, ' rad')}
          <p className="settings-hint">负值在窗口后方，正值向观看者凸出；窗口只是投影视口，不限制模型尺寸。</p>
          {number('统一缩放', settings.model.scale, (value) => update((d) => { d.model.scale = value; }), 0.1, 4, 0.01)}
        </Section>}
        {isWindowMode && <Section title="虚拟窗户">
          <p className="settings-hint">窗户是独立的浮空投影视口，不需要存在于 GLB 网格中。飞行到目标位置后确认，或直接编辑数值。</p>
          <p className="settings-hint">当前已启用窗户投影。窗口本身是独立的世界坐标平面，GLB 场景保持固定。</p>
          <label className="settings-toggle"><span>锁定屏幕宽高比</span><input type="checkbox" checked={settings.window.lockAspect} onChange={(event) => update((d) => { d.window.lockAspect = event.target.checked; })} /></label>
          {number('窗户 X', settings.window.x, (value) => update((d) => { d.window.x = value; }), -50, 50, 0.01)}
          {number('窗户 Y', settings.window.y, (value) => update((d) => { d.window.y = value; }), -50, 50, 0.01)}
          {number('窗户 Z', settings.window.z, (value) => update((d) => { d.window.z = value; }), -50, 50, 0.01)}
          {number('旋转 X', settings.window.rotationX, (value) => update((d) => { d.window.rotationX = value; }), -Math.PI, Math.PI, 0.01, ' rad')}
          {number('旋转 Y', settings.window.rotationY, (value) => update((d) => { d.window.rotationY = value; }), -Math.PI, Math.PI, 0.01, ' rad')}
          {number('窗户宽度', settings.window.width, (value) => update((d) => { d.window.width = value; }), 0.5, 50, 0.1)}
          {!settings.window.lockAspect && number('窗户高度', settings.window.height, (value) => update((d) => { d.window.height = value; }), 0.5, 50, 0.1)}
          {number('统一缩放', settings.window.scale, (value) => update((d) => { d.window.scale = value; }), 0.1, 10, 0.01)}
          {number('头部移动响应', settings.window.trackingScale, (value) => update((d) => { d.window.trackingScale = value; }), 0.05, 2, 0.01)}
        </Section>}
        <Section title="高级外观与灯光">
          <label className="settings-toggle"><span>卡顿时自动降低分辨率</span><input type="checkbox" checked={settings.lighting.autoResolution} onChange={(event) => update((d) => { d.lighting.autoResolution = event.target.checked; })} /></label>
          {number('渲染像素预算', settings.lighting.maxRenderMegapixels, (value) => update((d) => { d.lighting.maxRenderMegapixels = value; }), 0.5, 16, 0.1, ' MP')}
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
  const targetRef = useRef<ViewPosition>({ x: 0, y: 0, z: baselineDepth(DEFAULT_SETTINGS) });
  const resetRef = useRef<() => void>(() => {});
  const loadContentRef = useRef<(source: 'mesh' | File) => Promise<void>>(async () => {});
  const draggingRef = useRef(false);
  const faceEnabledRef = useRef(true);
  const socketReadyRef = useRef(false);
  const trackingSessionRef = useRef(new TrackingSession());
  const trueFovRef = useRef<number | null>(null);
  const backendFovRef = useRef(DEFAULT_BACKEND_FOV_DEG);
  const latestPositionRef = useRef<ViewerPosition | null>(null);
  const modelDragRef = useRef({ x: 0, y: 0 });
  const windowModeRef = useRef<'display' | 'flight'>('display');
  const windowBackupRef = useRef<WindowSettings | null>(null);
  const flightEyeRef = useRef(new THREE.Vector3(0, 0, baselineDepth(DEFAULT_SETTINGS)));
  const flightKeysRef = useRef(new Set<string>());
  const flightSyncFrameRef = useRef(0);
  const metricsRef = useRef({ frames: 0, trackingFps: 0, receivedAt: 0 });
  // Keep the first render deterministic for SSR/hydration. Browser storage is
  // loaded after mount so a saved mode cannot change the server-rendered tree.
  const [settings, setSettings] = useState<DisplaySettings>(() => cloneSettings());
  const [settingsReady, setSettingsReady] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [faceEnabled, setFaceEnabled] = useState(true);
  const [trackerState, setTrackerState] = useState<TrackerState>('connecting');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showMetrics, setShowMetrics] = useState(false);
  const [windowMode, setWindowMode] = useState<'display' | 'flight'>('display');

  useEffect(() => { windowModeRef.current = windowMode; }, [windowMode]);
  const [contentLabel, setContentLabel] = useState('网格模型');
  const [renderStats, setRenderStats] = useState('正在测量渲染帧率');
  const [trueFov] = useTrueFovDeg();
  const [backendFov, setBackendFov] = useState(DEFAULT_BACKEND_FOV_DEG);
  const [metrics, setMetrics] = useState({ fps: 0, trackingFps: 0, age: null as number | null });

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const stored = loadStoredSettings();
      settingsRef.current = stored;
      setSettings(stored);
      setSettingsReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!settingsReady) return;
    try { window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings)); } catch { /* storage may be disabled */ }
  }, [settings, settingsReady]);

  useEffect(() => {
    if (!showMetrics) return;
    let previousTime = performance.now();
    let previousFrames = metricsRef.current.frames;
    const timer = window.setInterval(() => {
      const now = performance.now();
      const value = metricsRef.current;
      setMetrics({ fps: (value.frames - previousFrames) * 1000 / (now - previousTime), trackingFps: value.trackingFps, age: value.receivedAt ? now - value.receivedAt : null });
      previousTime = now;
      previousFrames = value.frames;
    }, 500);
    return () => window.clearInterval(timer);
  }, [showMetrics]);

  useEffect(() => {
    settingsRef.current = settings;
    const position = latestPositionRef.current;
    const neutral = trackingSessionRef.current.neutral;
    const view = settings.view;
    if (faceEnabledRef.current && position && neutral) {
      const windowWidth = settings.presentationMode === 'window' ? settings.window.width * settings.window.scale : settings.case.width;
      targetRef.current = physicalView(position, neutral, windowWidth,
        view.visibleWidthM, view.neutralDistanceM, view.invertX, view.minimumEyeDistanceM,
        { x: view.cameraOffsetX, y: view.cameraOffsetY, z: view.cameraOffsetZ },
        settings.presentationMode === 'window' ? settings.window.trackingScale : 1);
    } else {
      targetRef.current = { x: 0, y: 0, z: baselineDepthForWindow(settings) };
    }
  }, [settings]);

  const updateSettings = useCallback((mutate: (draft: DisplaySettings) => void) => {
    setSettings((previous) => {
      const next = structuredClone(previous);
      mutate(next);
      next.view.minimumEyeDistanceM = clamp(next.view.minimumEyeDistanceM, 0.005, Math.max(0.005, next.view.neutralDistanceM));
      next.view.near = Math.max(0.0001, Math.min(next.view.near, next.view.far - 0.1));
      next.view.far = Math.max(next.view.far, next.case.depth + 5);
      return next;
    });
  }, []);
  const resetSettings = useCallback(() => {
    const next = cloneSettings();
    latestPositionRef.current = null;
    trackingSessionRef.current.resetCalibration();
    setTrueFovDeg(null);
    settingsRef.current = next;
    setSettings(next);
    try { window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next)); } catch { /* storage may be disabled */ }
  }, []);

  const calibrateFace = useCallback(() => {
    latestPositionRef.current = null;
    trackingSessionRef.current.resetCalibration();
    targetRef.current = { x: 0, y: 0, z: baselineDepthForWindow(settingsRef.current) };
    setIsMoving(false);
    setTrackerState(socketReadyRef.current ? 'calibrating' : 'offline');
    resetRef.current();
  }, []);

  const resetView = useCallback(() => {
    if (faceEnabledRef.current) return calibrateFace();
    targetRef.current = { x: 0, y: 0, z: baselineDepthForWindow(settingsRef.current) };
    draggingRef.current = false;
    setIsMoving(false);
    resetRef.current();
  }, [calibrateFace]);

  const startWindowFlight = useCallback(() => {
    draggingRef.current = false;
    windowBackupRef.current = structuredClone(settingsRef.current.window);
    const currentSettings = settingsRef.current;
    const currentFrame = windowFrame(currentSettings);
    const currentNormal = currentFrame.right.clone().cross(currentFrame.up).normalize();
    flightEyeRef.current.copy(currentFrame.center).addScaledVector(currentNormal, baselineDepthForWindow(currentSettings));
    targetRef.current = { x: 0, y: 0, z: baselineDepthForWindow(currentSettings) };
    resetRef.current();
    windowModeRef.current = 'flight';
    setWindowMode('flight');
    updateSettings((draft) => { draft.presentationMode = 'window'; draft.window.enabled = true; draft.view.mouseDragEnabled = false; draft.window.rotationZ = 0; });
  }, [updateSettings]);
  const confirmWindowFlight = useCallback(() => {
    if (document.pointerLockElement) document.exitPointerLock();
    windowModeRef.current = 'display';
    setWindowMode('display');
    windowBackupRef.current = null;
    trackingSessionRef.current.resetCalibration();
    latestPositionRef.current = null;
    setTrackerState(faceEnabledRef.current ? 'calibrating' : 'manual');
  }, []);
  const cancelWindowFlight = useCallback(() => {
    if (document.pointerLockElement) document.exitPointerLock();
    const backup = windowBackupRef.current;
    if (backup) {
      updateSettings((draft) => { draft.window = structuredClone(backup); });
      windowBackupRef.current = null;
    }
    windowModeRef.current = 'display';
    setWindowMode('display');
  }, [updateSettings]);

  const switchPresentationMode = useCallback((mode: PresentationMode) => {
    if (document.pointerLockElement) document.exitPointerLock();
    windowModeRef.current = 'display';
    setWindowMode('display');
    draggingRef.current = false;
    updateSettings((draft) => {
      draft.presentationMode = mode;
      draft.window.enabled = mode === 'window';
      if (mode === 'window') {
        draft.view.mouseDragEnabled = false;
        draft.window.rotationZ = 0;
      }
    });
    latestPositionRef.current = null;
    trackingSessionRef.current.resetCalibration();
    resetRef.current();
    setTrackerState(faceEnabledRef.current ? 'calibrating' : 'manual');
  }, [updateSettings]);

  const applyFlightLook = useCallback((dx: number, dy: number) => {
    if (windowModeRef.current !== 'flight' || (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001)) return;
    const next = structuredClone(settingsRef.current);
    // FPS look: horizontal mouse delta rotates the window around world Y;
    // vertical mouse delta rotates it around world X. Do not touch the model
    // transform or the window position here.
    // Invert the previous drag direction: moving the mouse right turns the
    // view right, and moving it down turns the view down.
    next.window.rotationY += dx * 0.0025;
    next.window.rotationX += dy * 0.0025;
    next.window.rotationX = clamp(next.window.rotationX, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
    // Keep the first-person eye fixed while the screen plane turns in front
    // of it. Rotating the plane around its own center would orbit the eye and
    // produce the old "model display" feeling.
    placeWindowInFrontOfEye(next, flightEyeRef.current);
    settingsRef.current = next;
    setSettings(next);
    setIsMoving(true);
  }, []);

  useEffect(() => {
    if (windowMode !== 'flight') return;
    const flightKeys = flightKeysRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === 'escape') { event.preventDefault(); cancelWindowFlight(); return; }
      if (key === 'enter') { event.preventDefault(); confirmWindowFlight(); return; }
      if (['w', 'a', 's', 'd', 'q', 'e', 'shift', 'alt', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) {
        event.preventDefault();
        flightKeys.add(key);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => flightKeys.delete(event.key.toLowerCase());
    const onMouseMove = (event: MouseEvent) => {
      if (document.pointerLockElement) applyFlightLook(event.movementX, event.movementY);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousemove', onMouseMove);
    const onBlur = () => flightKeys.clear();
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('blur', onBlur);
      flightKeys.clear();
    };
  }, [windowMode, cancelWindowFlight, confirmWindowFlight, applyFlightLook]);

  const toggleTrackingMode = useCallback(() => {
    const enabled = !faceEnabledRef.current;
    latestPositionRef.current = null;
    faceEnabledRef.current = enabled;
    setFaceEnabled(enabled);
    draggingRef.current = false;
    targetRef.current = { x: 0, y: 0, z: baselineDepthForWindow(settingsRef.current) };
    resetRef.current();
    if (enabled) {
      trackingSessionRef.current.resetCalibration();
      setTrackerState(socketReadyRef.current ? 'calibrating' : 'connecting');
    } else setTrackerState('manual');
  }, []);

  // The debug page owns the FOV override; this view only consumes it. Changing
  // it invalidates the neutral calibration that was recorded in the old depth
  // scale, so drop it and let the next stable samples re-establish it.
  useEffect(() => {
    if (trueFovRef.current === trueFov) return;
    trueFovRef.current = trueFov;
    trackingSessionRef.current.resetCalibration();
    latestPositionRef.current = null;
  }, [trueFov]);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    const lostTimer = window.setInterval(() => {
      if (!faceEnabledRef.current || windowModeRef.current === 'flight') return;
      const state = trackingSessionRef.current.stale(
        performance.now(), settingsRef.current.view.lostResetMs,
      );
      if (state.lost && socketReadyRef.current) setTrackerState('lost');
      if (state.reset) {
        latestPositionRef.current = null;
        targetRef.current = { x: 0, y: 0, z: baselineDepthForWindow(settingsRef.current) };
      }
    }, 100);
    const connect = () => {
      if (disposed) return;
      if (faceEnabledRef.current) setTrackerState('connecting');
      socket = new WebSocket(settings.connectionUrl);
      socket.onopen = () => {
        if (disposed) return;
        socketReadyRef.current = true;
        trackingSessionRef.current.reconnect();
        latestPositionRef.current = null;
        metricsRef.current.receivedAt = 0;
        if (faceEnabledRef.current) setTrackerState('calibrating');
      };
      socket.onmessage = (event) => {
        if (disposed || !faceEnabledRef.current || windowModeRef.current === 'flight') return;
        let packet: TrackingPacket;
        try { packet = JSON.parse(event.data) as TrackingPacket; } catch { return; }
        if (packet && typeof packet === 'object') {
          metricsRef.current.receivedAt = performance.now();
          metricsRef.current.trackingFps = Number.isFinite(packet.frame?.fps) ? packet.frame!.fps! : 0;
        }
        const now = performance.now();
        if (Number.isFinite(packet.camera_hfov_deg) && packet.camera_hfov_deg !== backendFovRef.current) {
          backendFovRef.current = packet.camera_hfov_deg!;
          setBackendFov(packet.camera_hfov_deg!);
        }
        const position = trackingSessionRef.current.accept(
          packet,
          now,
          depthScaleFor(backendFovRef.current, trueFovRef.current),
        );
        const neutral = trackingSessionRef.current.neutral;
        const currentSettings = settingsRef.current;
        if (!position || !neutral) {
          const lost = trackingSessionRef.current.stale(
            now, currentSettings.view.lostResetMs,
          ).lost;
          setTrackerState(lost ? 'lost' : 'calibrating');
          return;
        }
        latestPositionRef.current = position;
        const windowWidth = currentSettings.presentationMode === 'window' ? currentSettings.window.width * currentSettings.window.scale : currentSettings.case.width;
        targetRef.current = physicalView(
          position,
          neutral,
          windowWidth,
          currentSettings.view.visibleWidthM,
          currentSettings.view.neutralDistanceM,
          currentSettings.view.invertX,
          currentSettings.view.minimumEyeDistanceM,
          { x: currentSettings.view.cameraOffsetX, y: currentSettings.view.cameraOffsetY, z: currentSettings.view.cameraOffsetZ },
          currentSettings.presentationMode === 'window' ? currentSettings.window.trackingScale : 1,
        );
        setTrackerState('tracking');
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (disposed) return;
        socketReadyRef.current = false;
        if (faceEnabledRef.current) setTrackerState('offline');
        if (!disposed) reconnectTimer = window.setTimeout(connect, settingsRef.current.view.reconnectMs);
      };
    };
    connect();
    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      window.clearInterval(lostTimer);
      socketReadyRef.current = false;
      socket?.close();
    };
  }, [settings.connectionUrl]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const initial = settingsRef.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(initial.presentationMode === 'model' && initial.case.visible ? initial.case.backgroundColor : initial.case.skyColor);
    const camera = new THREE.PerspectiveCamera(45, 16 / 9, initial.view.near, initial.view.far);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    mount.appendChild(renderer.domElement);

    let caseKey = JSON.stringify(initial.case);
    let appliedSettings: DisplaySettings | null = null;
    let appliedPixelRatio = 0;
    const renderBudget = new RenderBudget();
    let caseGroup = createDisplayCase(initial);
    scene.add(caseGroup);
    const artifact = createArtifact(initial);
    scene.add(artifact);
    const windowPreview = new THREE.LineLoop(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: '#9fe6cf', transparent: true, opacity: 0.8 }),
    );
    windowPreview.visible = false;
    scene.add(windowPreview);
    let disposed = false;
    let contentRequest = 0;
    let uploadedModel: THREE.Object3D | null = null;
    let selectedContent: 'mesh' | 'uploaded' = 'mesh';
    let selectedContentLabel = '网格模型';
    loadContentRef.current = async (source) => {
      const request = ++contentRequest;
      if (source === 'mesh') {
        selectedContent = 'mesh';
        selectedContentLabel = '网格模型';
        renderer.shadowMap.needsUpdate = true;
        setContentLabel(selectedContentLabel);
        return;
      }
      setContentLabel('正在加载模型…');
      let url: string | null = null;
      try {
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
        const objectUrl = URL.createObjectURL(source);
        url = objectUrl;
        const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
          new GLTFLoader().load(objectUrl, resolve, undefined, reject);
        });
        URL.revokeObjectURL(objectUrl);
        url = null;
        if (disposed || request !== contentRequest) {
          disposeObject(gltf.scene);
          return;
        }
        if (uploadedModel) { scene.remove(uploadedModel); disposeObject(uploadedModel); }
        uploadedModel = gltf.scene;
        selectedContent = 'uploaded';
        selectedContentLabel = source.name;
        // Preserve the asset's authored transform. In floating-window mode
        // this transform is the fixed world-space scene transform and must
        // not be replaced by the legacy showcase-model controls.
        uploadedModel.userData.authoredTransform = {
          position: uploadedModel.position.clone(),
          quaternion: uploadedModel.quaternion.clone(),
          scale: uploadedModel.scale.clone(),
        };
        scene.add(uploadedModel);
        if (settingsRef.current.presentationMode === 'model') {
          uploadedModel.position.copy(artifact.position);
          uploadedModel.scale.copy(artifact.scale);
        }
        renderer.shadowMap.needsUpdate = true;
        setContentLabel(selectedContentLabel);
      } catch (error) {
        if (url) URL.revokeObjectURL(url);
        if (!disposed && request === contentRequest) {
          renderer.shadowMap.needsUpdate = true;
          setContentLabel(`模型加载失败，已保留 ${selectedContentLabel}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };
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
    const motion = new WindowMotion({ x: 0, y: 0, z: baselineDepthForWindow(initial) });
    const current = motion.position;
    let animationFrame = 0;
    let previousAnimationTime = performance.now();
    let statsStarted = previousAnimationTime;
    let frameIntervals: number[] = [];

    const resize = () => renderer.setSize(mount.clientWidth, mount.clientHeight);
    const animate = (animationTime = performance.now()) => {
      animationFrame = requestAnimationFrame(animate);
      const active = settingsRef.current;
      if (active !== appliedSettings) {
        if (appliedSettings?.lighting.autoResolution !== active.lighting.autoResolution) renderBudget.reset();
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
        renderer.toneMappingExposure = active.lighting.exposure;
        renderer.shadowMap.needsUpdate = true;
        appliedSettings = active;
      }
      // Content selection and presentation mode jointly own visibility. A GLB
      // hidden by the model-mode mesh must become visible again when entering
      // window mode, where it represents the fixed world behind the aperture.
      const showUploadedModel = uploadedModel !== null
        && (selectedContent === 'uploaded' || active.presentationMode === 'window');
      scene.userData.hasUploadedModel = uploadedModel !== null;
      artifact.visible = active.presentationMode === 'model' && !showUploadedModel;
      if (uploadedModel) uploadedModel.visible = showUploadedModel;
      const pixelRatio = renderPixelRatio(
        mount.clientWidth,
        mount.clientHeight,
        window.devicePixelRatio,
        active.lighting.pixelRatioCap,
        active.lighting.maxRenderMegapixels * 1_000_000,
        active.lighting.autoResolution ? renderBudget.scale : 1,
      );
      if (pixelRatio !== appliedPixelRatio) {
        renderer.setPixelRatio(pixelRatio);
        appliedPixelRatio = pixelRatio;
      }
      const frameMs = animationTime - previousAnimationTime;
      const deltaSeconds = Math.min(frameMs / 1000, 0.1);
      previousAnimationTime = animationTime;
      if (frameMs > 0 && frameMs < 1000) frameIntervals.push(frameMs);
      if (animationTime - statsStarted >= 1000 && frameIntervals.length) {
        const sorted = [...frameIntervals].sort((a, b) => a - b);
        const fps = 1000 * frameIntervals.length / frameIntervals.reduce((sum, value) => sum + value, 0);
        const p95 = sorted[Math.floor((sorted.length - 1) * 0.95)];
        if (active.lighting.autoResolution && !document.hidden) {
          renderBudget.observe(1000 / fps, p95);
        }
        setRenderStats(`${fps.toFixed(0)} FPS · P95 ${p95.toFixed(1)} ms · 像素比 ${appliedPixelRatio.toFixed(2)}`);
        statsStarted = animationTime;
        frameIntervals = [];
      }
      motion.update(targetRef.current, deltaSeconds, active.view.smoothing);
      if (windowModeRef.current === 'flight' && active.presentationMode === 'window') {
        const keys = flightKeysRef.current;
        const frame = windowFrame(active);
        const normal = frame.right.clone().cross(frame.up).normalize();
        const forward = normal.clone().negate();
        const speed = (keys.has('shift') ? 5.4 : keys.has('alt') ? 0.24 : 1.35) * deltaSeconds;
        let changed = false;
        const move = (axis: THREE.Vector3, amount: number) => {
          flightEyeRef.current.addScaledVector(axis, amount);
          changed = true;
        };
        // Three's camera looks along local -Z, represented here by `forward`.
        if (keys.has('w')) move(forward, speed);
        if (keys.has('s')) move(forward, -speed);
        if (keys.has('a')) move(frame.right, -speed);
        if (keys.has('d')) move(frame.right, speed);
        if (keys.has('q')) move(new THREE.Vector3(0, 1, 0), -speed);
        if (keys.has('e')) move(new THREE.Vector3(0, 1, 0), speed);
        if (keys.has('arrowleft')) { active.window.rotationY += 1.4 * deltaSeconds; changed = true; }
        if (keys.has('arrowright')) { active.window.rotationY -= 1.4 * deltaSeconds; changed = true; }
        if (keys.has('arrowup')) { active.window.rotationX += 1.4 * deltaSeconds; changed = true; }
        if (keys.has('arrowdown')) { active.window.rotationX -= 1.4 * deltaSeconds; changed = true; }
        if (changed) {
          active.window.rotationX = clamp(active.window.rotationX, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
          placeWindowInFrontOfEye(active, flightEyeRef.current);
          settingsRef.current = active;
          flightSyncFrameRef.current += 1;
          if (flightSyncFrameRef.current % 3 === 0) setSettings(structuredClone(active));
        }
      }
      artifact.rotation.set(active.model.rotationX, active.model.rotationY, active.model.rotationZ);
      if (uploadedModel) {
        if (active.presentationMode === 'window') {
          const authored = uploadedModel.userData.authoredTransform as {
            position: THREE.Vector3;
            quaternion: THREE.Quaternion;
            scale: THREE.Vector3;
          } | undefined;
          if (authored) {
            uploadedModel.position.copy(authored.position);
            uploadedModel.quaternion.copy(authored.quaternion);
            uploadedModel.scale.copy(authored.scale);
          }
        } else {
          uploadedModel.position.copy(artifact.position);
          uploadedModel.scale.copy(artifact.scale);
          uploadedModel.rotation.set(active.model.rotationX, active.model.rotationY, active.model.rotationZ);
        }
      }
      const frame = presentationFrame(active);
      const plane = windowPlaneFromAnchor(frame);
      const normal = frame.right.clone().cross(frame.up).normalize();
      const eye = active.presentationMode === 'window'
        ? (windowModeRef.current === 'flight'
          ? flightEyeRef.current.clone()
          : frame.center.clone().addScaledVector(frame.right, current.x).addScaledVector(frame.up, current.y).addScaledVector(normal, current.z))
        : new THREE.Vector3(current.x, current.y, current.z);
      applyWindowProjection(
        camera,
        eye,
        frame.width,
        frame.height,
        active.view.near,
        Math.max(active.view.far, Math.abs(current.z) + active.case.depth + 1),
        active.presentationMode === 'window' ? plane : undefined,
      );
      windowPreview.visible = windowModeRef.current === 'flight' || active.presentationMode === 'window';
      if (windowPreview.visible) {
        const points = [plane.bottomLeft, plane.bottomRight,
          new THREE.Vector3(plane.bottomRight.x, plane.bottomRight.y, plane.bottomRight.z)
            .add(new THREE.Vector3(plane.topLeft.x, plane.topLeft.y, plane.topLeft.z).sub(plane.bottomLeft)), plane.topLeft];
        windowPreview.geometry.setFromPoints(points.map((p) => new THREE.Vector3(p.x, p.y, p.z)));
      }
      renderer.render(scene, camera);
      metricsRef.current.frames += 1;
    };
    resetRef.current = () => motion.reset({
      x: 0,
      y: 0,
      z: baselineDepthForWindow(settingsRef.current),
    });
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();
    animate();
    return () => {
      disposed = true;
      contentRequest += 1;
      loadContentRef.current = async () => {};
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      disposeObject(scene);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  const moveView = (event: React.PointerEvent<HTMLDivElement>) => {
    const isFlight = windowModeRef.current === 'flight';
    if (isFlight) {
      if (!draggingRef.current) return;
      if (document.pointerLockElement) return;
      const dx = event.movementX || event.clientX - modelDragRef.current.x;
      const dy = event.movementY || event.clientY - modelDragRef.current.y;
      modelDragRef.current = { x: event.clientX, y: event.clientY };
      applyFlightLook(dx, dy);
      return;
    }
    if (!draggingRef.current || !settingsRef.current.view.mouseDragEnabled || settingsRef.current.presentationMode === 'window') return;
    const previous = modelDragRef.current;
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    modelDragRef.current = { x: event.clientX, y: event.clientY };
    const active = settingsRef.current;
    const next = structuredClone(active);
    next.model.rotationY += dx * 0.01;
    next.model.rotationX += dy * 0.01;
    settingsRef.current = next;
    setSettings(next);
    setIsMoving(true);
  };
  const startView = (event: React.PointerEvent<HTMLDivElement>) => {
    if (windowModeRef.current === 'flight') {
      event.preventDefault();
      draggingRef.current = true;
      modelDragRef.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
      const pointerLock = event.currentTarget.requestPointerLock?.();
      if (pointerLock) void pointerLock.catch(() => {});
      setIsMoving(true);
      return;
    }
    if (!settingsRef.current.view.mouseDragEnabled || settingsRef.current.presentationMode === 'window') return;
    draggingRef.current = true;
    modelDragRef.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsMoving(true);
    moveView(event);
  };
  const endView = (event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (windowModeRef.current === 'flight' && document.pointerLockElement) document.exitPointerLock();
    setIsMoving(false);
  };
  const toggleFullscreen = () => {
    const element = mountRef.current?.closest<HTMLElement>('.case-shell');
    if (!element) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void element.requestFullscreen();
  };

  const statusLabel = windowMode === 'flight' ? '飞行设置窗户' : isMoving ? '鼠标旋转模型' : trackerLabels[trackerState];
  const statusColor = trackerState === 'tracking' ? 'bg-[#71c8a2]' : trackerState === 'offline' ? 'bg-[#e36f63]' : trackerState === 'lost' ? 'bg-[#e8a45e]' : 'bg-[#7fb3c8]';
  return (
    <section className="max-w-none" style={{ width: `min(100vw, ${100 * settings.case.width / settings.case.height}vh)` }}>
      <div
        className="case-shell relative overflow-hidden bg-[#101415] shadow-[0_42px_100px_rgba(0,0,0,0.55)]"
        style={{ '--case-aspect': settings.case.width / settings.case.height } as React.CSSProperties}
      >
        <div data-case-viewport style={{ aspectRatio: `${settings.case.width} / ${settings.case.height}` }} className={`relative w-full overflow-hidden bg-[#171b1c] ${windowMode === 'flight' ? 'cursor-none' : 'cursor-crosshair'}`} onPointerDown={startView} onPointerMove={moveView} onPointerUp={endView} onPointerCancel={endView}>
          <div ref={mountRef} className="absolute inset-0" aria-label="三维虚拟展示箱" />
          <div className="screen-frame pointer-events-none absolute inset-0 z-30" aria-hidden="true" />
          <div className="absolute left-4 top-4 z-40 max-w-[55%] rounded-lg bg-black/50 p-2 text-xs text-white/80" onPointerDown={(event) => event.stopPropagation()}>
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={() => void loadContentRef.current('mesh')}>网格</button>
              <label className="cursor-pointer">上传模型<input aria-label="上传本地三维模型" type="file" className="sr-only" accept=".glb,.gltf,model/gltf-binary,model/gltf+json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadContentRef.current(file); event.target.value = ''; }} /></label>
              <button type="button" className={settings.presentationMode === 'model' ? 'text-[#c8eadc]' : ''} onClick={() => switchPresentationMode('model')}>模型展示</button>
              <button type="button" className={settings.presentationMode === 'window' ? 'text-[#c8eadc]' : ''} onClick={() => switchPresentationMode('window')}>窗户模式</button>
              {settings.presentationMode === 'window' && (windowMode === 'display' ? <button type="button" onClick={startWindowFlight}>设置窗户</button> : <><button type="button" onClick={confirmWindowFlight}>确认窗户</button><button type="button" onClick={cancelWindowFlight}>取消</button></>)}
            </div>
            <output className="mt-1 block break-words text-[10px] text-white/60">{contentLabel}</output>
            <output className="block text-[10px] text-white/50" aria-label="渲染性能">{renderStats}</output>
          </div>
          {windowMode === 'flight' && <div className="pointer-events-none absolute bottom-20 left-1/2 z-40 -translate-x-1/2 rounded-xl border border-[#9fe6cf]/35 bg-[#0b1515]/85 px-4 py-3 text-center text-xs text-[#d7eee5] shadow-xl backdrop-blur-md"><div className="font-semibold tracking-wide text-[#9fe6cf]">飞行设置窗户</div><div className="mt-1 text-[11px] text-white/70">点击画面捕获鼠标 · 鼠标左右旋转 Y 轴 · 上下旋转 X 轴 · W 前进 / S 后退 · A/D 横移 · Q 下降 / E 上升 · ←/→ 微调 Y 轴 · Shift 加速 · Enter 确认 · Esc 取消</div></div>}
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-end bg-gradient-to-b from-black/40 to-transparent px-5 pb-12 pt-5 sm:px-8 sm:pt-7"><div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-[11px] text-white/65 backdrop-blur-md"><span className={`size-1.5 rounded-full ${statusColor}`} />{statusLabel}</div></div>
          {settingsOpen && <SettingsPanel settings={settings} update={updateSettings} reset={resetSettings} backendFovDeg={backendFov} onModeChange={switchPresentationMode} onClose={() => setSettingsOpen(false)} />}
          {showMetrics && <output className="pointer-events-none absolute left-4 top-28 z-40 rounded bg-black/70 p-3 text-xs text-white">
            渲染 {metrics.fps.toFixed(0)} FPS · 追踪 {metrics.age !== null && metrics.age < 1000 ? metrics.trackingFps.toFixed(0) : '—'} FPS<br />
            数据距今 {metrics.age === null ? '尚未收到' : `${Math.round(metrics.age)} ms`}
            {trueFov !== null && <><br />视场角修正 {trueFov.toFixed(1)}° · 深度 ×{depthScaleFor(backendFov, trueFov).toFixed(2)}</>}
          </output>}
          <div className="absolute bottom-4 left-4 right-4 z-40 flex items-end justify-end gap-3 sm:bottom-7 sm:left-8 sm:right-8" onPointerDown={(event) => event.stopPropagation()}><div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" aria-pressed={showMetrics} onClick={() => setShowMetrics((value) => !value)} className="border-white/15 bg-black/35 text-white">性能</Button>
            <Button type="button" variant="outline" size="icon-lg" aria-label={faceEnabled ? '关闭面部追踪' : '开启面部追踪'} title={faceEnabled ? '面追：开启' : '面追：关闭'} onClick={toggleTrackingMode} className={`border-white/15 text-white hover:bg-black/55 hover:text-white ${faceEnabled ? 'bg-[#6f9f91]/45' : 'bg-black/35'}`}><ScanFace /></Button>
            <Button type="button" variant="outline" size="icon-lg" aria-label={settings.view.mouseDragEnabled ? '关闭鼠标拖拽旋转' : '开启鼠标拖拽旋转'} title={settings.view.mouseDragEnabled ? '鼠标拖拽：开启' : '鼠标拖拽：关闭'} onClick={() => updateSettings((draft) => { draft.view.mouseDragEnabled = !draft.view.mouseDragEnabled; })} className={`border-white/15 text-white hover:bg-black/55 hover:text-white ${settings.view.mouseDragEnabled ? 'bg-[#6f9f91]/45' : 'bg-black/35'}`}><MousePointer2 /></Button>
            <Button type="button" variant="outline" size="icon-lg" aria-label={faceEnabled ? '重新校准中心' : '复位视角'} onClick={resetView} className="border-white/15 bg-black/35 text-white hover:bg-black/55 hover:text-white">{faceEnabled ? <LocateFixed /> : <RotateCcw />}</Button>
            <Button type="button" variant="outline" size="icon-lg" aria-label="打开显示设置" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((current) => !current)} className={`border-white/15 text-white hover:bg-black/55 hover:text-white ${settingsOpen ? 'bg-[#6f9f91]/45' : 'bg-black/35'}`}><Settings2 /></Button>
            <Button type="button" variant="outline" size="icon-lg" aria-label="全屏查看" onClick={toggleFullscreen} className="border-white/15 bg-black/35 text-white hover:bg-black/55 hover:text-white"><Maximize2 /></Button>
          </div></div>
        </div>
      </div>
    </section>
  );
}
