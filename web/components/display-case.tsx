'use client';

import { LocateFixed, Maximize2, MousePointer2, RotateCcw, ScanFace } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

import { Button } from '@/components/ui/button';

const CASE_WIDTH = 8;
const CASE_HEIGHT = 4.5;
const CASE_DEPTH = 5.8;
const EYE_DISTANCE = 7.4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 50;
const TRACKER_WS_URL = 'ws://127.0.0.1:8765/ws/v1/tracking';
const POSITION_GAIN = 12.5;
const DEPTH_GAIN = 10;
// A front-facing camera's image-space X axis is opposite to the viewer's
// physical left/right movement in front of the screen.
const CAMERA_X_DIRECTION = -1;

type ViewPosition = { x: number; y: number; z: number };
type TrackerState = 'connecting' | 'tracking' | 'calibrating' | 'lost' | 'offline' | 'manual';
type ViewerPosition = { x: number; y: number; z: number };
type TrackingPacket = {
  tracking?: boolean;
  face?: {
    viewer_position_m?: {
      filtered?: ViewerPosition;
    } | null;
  } | null;
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum);

const trackerLabels: Record<TrackerState, string> = {
  connecting: '正在连接摄像头',
  tracking: '人脸跟踪中',
  calibrating: '正在校准中心',
  lost: '等待检测到人脸',
  offline: '跟踪服务未启动',
  manual: '鼠标预览模式',
};

function makeGrid(
  width: number,
  height: number,
  columns: number,
  rows: number,
  color: number,
) {
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
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.19 }),
  );
}

function createArtifact() {
  const artifact = new THREE.Group();
  const bronze = new THREE.MeshStandardMaterial({
    color: 0x9e6738,
    metalness: 0.78,
    roughness: 0.28,
  });
  const darkBronze = new THREE.MeshStandardMaterial({
    color: 0x30241e,
    metalness: 0.72,
    roughness: 0.35,
  });

  const sculpture = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.78, 0.22, 180, 28, 2, 3),
    bronze,
  );
  sculpture.rotation.set(0.48, -0.3, 0.08);
  sculpture.position.y = 0.32;
  sculpture.castShadow = true;
  sculpture.receiveShadow = true;
  artifact.add(sculpture);

  const innerRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.74, 0.035, 12, 96),
    darkBronze,
  );
  innerRing.rotation.set(Math.PI / 2.5, 0.3, -0.25);
  innerRing.position.y = 0.31;
  innerRing.castShadow = true;
  artifact.add(innerRing);

  // An asymmetric arm makes changes in viewpoint immediately readable while
  // the artifact itself remains fixed in the virtual case.
  const orientationArm = new THREE.Mesh(
    new THREE.BoxGeometry(1.05, 0.14, 0.2),
    bronze,
  );
  orientationArm.position.set(0.95, 0.34, 0.08);
  orientationArm.rotation.set(0.08, -0.38, 0.26);
  orientationArm.castShadow = true;
  artifact.add(orientationArm);

  const orientationTip = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 24, 16),
    darkBronze,
  );
  orientationTip.position.set(1.45, 0.49, 0.27);
  orientationTip.castShadow = true;
  artifact.add(orientationTip);

  const plinthTop = new THREE.Mesh(
    new THREE.CylinderGeometry(1.18, 1.28, 0.14, 64),
    new THREE.MeshStandardMaterial({
      color: 0x1c2021,
      metalness: 0.25,
      roughness: 0.32,
    }),
  );
  plinthTop.position.y = -0.75;
  plinthTop.castShadow = true;
  plinthTop.receiveShadow = true;
  artifact.add(plinthTop);

  const plinth = new THREE.Mesh(
    new THREE.CylinderGeometry(0.94, 1.12, 0.56, 64),
    new THREE.MeshStandardMaterial({
      color: 0x101415,
      metalness: 0.12,
      roughness: 0.52,
    }),
  );
  plinth.position.y = -1.08;
  plinth.castShadow = true;
  plinth.receiveShadow = true;
  artifact.add(plinth);

  artifact.position.set(0, -0.18, -1.85);
  artifact.scale.setScalar(1.08);
  return artifact;
}

function createDisplayCase(scene: THREE.Scene) {
  const roomMaterial = new THREE.MeshStandardMaterial({
    color: 0xdedbd1,
    roughness: 0.86,
    metalness: 0.02,
  });
  const sideMaterial = roomMaterial.clone();
  sideMaterial.color.setHex(0xc7c8c2);
  const floorMaterial = roomMaterial.clone();
  floorMaterial.color.setHex(0xb9b7ad);

  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(CASE_WIDTH, CASE_HEIGHT),
    roomMaterial,
  );
  back.position.z = -CASE_DEPTH;
  back.receiveShadow = true;
  scene.add(back);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(CASE_WIDTH, CASE_DEPTH),
    floorMaterial,
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -CASE_HEIGHT / 2, -CASE_DEPTH / 2);
  floor.receiveShadow = true;
  scene.add(floor);

  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(CASE_WIDTH, CASE_DEPTH),
    sideMaterial,
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, CASE_HEIGHT / 2, -CASE_DEPTH / 2);
  ceiling.receiveShadow = true;
  scene.add(ceiling);

  const left = new THREE.Mesh(
    new THREE.PlaneGeometry(CASE_DEPTH, CASE_HEIGHT),
    sideMaterial,
  );
  left.rotation.y = Math.PI / 2;
  left.position.set(-CASE_WIDTH / 2, 0, -CASE_DEPTH / 2);
  left.receiveShadow = true;
  scene.add(left);

  const right = new THREE.Mesh(
    new THREE.PlaneGeometry(CASE_DEPTH, CASE_HEIGHT),
    sideMaterial,
  );
  right.rotation.y = -Math.PI / 2;
  right.position.set(CASE_WIDTH / 2, 0, -CASE_DEPTH / 2);
  right.receiveShadow = true;
  scene.add(right);

  const backGrid = makeGrid(CASE_WIDTH, CASE_HEIGHT, 8, 5, 0x555d5b);
  backGrid.position.z = -CASE_DEPTH + 0.012;
  scene.add(backGrid);

  const floorGrid = makeGrid(CASE_WIDTH, CASE_DEPTH, 8, 6, 0x525957);
  floorGrid.rotation.x = -Math.PI / 2;
  floorGrid.position.set(0, -CASE_HEIGHT / 2 + 0.012, -CASE_DEPTH / 2);
  scene.add(floorGrid);

  const edgeGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-CASE_WIDTH / 2, -CASE_HEIGHT / 2, -CASE_DEPTH),
    new THREE.Vector3(-CASE_WIDTH / 2, CASE_HEIGHT / 2, -CASE_DEPTH),
    new THREE.Vector3(CASE_WIDTH / 2, CASE_HEIGHT / 2, -CASE_DEPTH),
    new THREE.Vector3(CASE_WIDTH / 2, -CASE_HEIGHT / 2, -CASE_DEPTH),
    new THREE.Vector3(-CASE_WIDTH / 2, -CASE_HEIGHT / 2, -CASE_DEPTH),
  ]);
  scene.add(new THREE.Line(edgeGeometry, new THREE.LineBasicMaterial({ color: 0x2d3332 })));

}

export function DisplayCase() {
  const mountRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<ViewPosition>({ x: 0, y: 0, z: EYE_DISTANCE });
  const resetRef = useRef<() => void>(() => {});
  const draggingRef = useRef(false);
  const faceEnabledRef = useRef(true);
  const socketReadyRef = useRef(false);
  const neutralPositionRef = useRef<ViewerPosition | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  const [faceEnabled, setFaceEnabled] = useState(true);
  const [trackerState, setTrackerState] = useState<TrackerState>('connecting');

  const calibrateFace = useCallback(() => {
    neutralPositionRef.current = null;
    targetRef.current = { x: 0, y: 0, z: EYE_DISTANCE };
    setIsMoving(false);
    setTrackerState(socketReadyRef.current ? 'calibrating' : 'offline');
    resetRef.current();
  }, []);

  const resetView = useCallback(() => {
    if (faceEnabledRef.current) {
      calibrateFace();
      return;
    }
    targetRef.current = { x: 0, y: 0, z: EYE_DISTANCE };
    draggingRef.current = false;
    setIsMoving(false);
    resetRef.current();
  }, [calibrateFace]);

  const toggleTrackingMode = useCallback(() => {
    const enabled = !faceEnabledRef.current;
    faceEnabledRef.current = enabled;
    setFaceEnabled(enabled);
    draggingRef.current = false;
    targetRef.current = { x: 0, y: 0, z: EYE_DISTANCE };
    resetRef.current();
    if (enabled) {
      neutralPositionRef.current = null;
      setTrackerState(socketReadyRef.current ? 'calibrating' : 'connecting');
    } else {
      setTrackerState('manual');
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let lostTimer: number | undefined;

    const connect = () => {
      if (disposed) return;
      if (faceEnabledRef.current) setTrackerState('connecting');
      socket = new WebSocket(TRACKER_WS_URL);

      socket.onopen = () => {
        socketReadyRef.current = true;
        if (faceEnabledRef.current) {
          setTrackerState(neutralPositionRef.current ? 'lost' : 'calibrating');
        }
      };

      socket.onmessage = (event) => {
        if (!faceEnabledRef.current) return;
        let packet: TrackingPacket;
        try {
          packet = JSON.parse(event.data) as TrackingPacket;
        } catch {
          return;
        }
        const position = packet.face?.viewer_position_m?.filtered;
        if (!packet.tracking || !position) {
          setTrackerState('lost');
          window.clearTimeout(lostTimer);
          lostTimer = window.setTimeout(() => {
            targetRef.current = { x: 0, y: 0, z: EYE_DISTANCE };
          }, 700);
          return;
        }

        window.clearTimeout(lostTimer);
        if (!neutralPositionRef.current) {
          neutralPositionRef.current = { ...position };
          targetRef.current = { x: 0, y: 0, z: EYE_DISTANCE };
          setTrackerState('tracking');
          return;
        }

        const neutral = neutralPositionRef.current;
        targetRef.current = {
          x: clamp(
            (position.x - neutral.x) * POSITION_GAIN * CAMERA_X_DIRECTION,
            -2.2,
            2.2,
          ),
          y: clamp((position.y - neutral.y) * POSITION_GAIN, -1.35, 1.35),
          z: clamp(EYE_DISTANCE + (position.z - neutral.z) * DEPTH_GAIN, 5.2, 10.5),
        };
        setTrackerState('tracking');
      };

      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        socketReadyRef.current = false;
        if (faceEnabledRef.current) setTrackerState('offline');
        if (!disposed) reconnectTimer = window.setTimeout(connect, 1500);
      };
    };

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(lostTimer);
      socket?.close();
    };
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x171b1c);
    scene.fog = new THREE.Fog(0x171b1c, 15, 28);

    const camera = new THREE.PerspectiveCamera(45, 16 / 9, CAMERA_NEAR, CAMERA_FAR);
    camera.position.set(0, 0, EYE_DISTANCE);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    mount.appendChild(renderer.domElement);

    createDisplayCase(scene);
    scene.add(createArtifact());
    scene.add(new THREE.HemisphereLight(0xe8f1f0, 0x25201c, 1.45));

    const keyLight = new THREE.SpotLight(0xffe2bf, 84, 18, Math.PI / 4.6, 0.48, 1.5);
    keyLight.position.set(-2.5, 3.8, 2.2);
    keyLight.target.position.set(0, -0.1, -2.7);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.bias = -0.00025;
    scene.add(keyLight, keyLight.target);

    const rimLight = new THREE.PointLight(0x73b8c8, 28, 11, 1.6);
    rimLight.position.set(2.8, 1.6, -4.1);
    scene.add(rimLight);

    const fillLight = new THREE.PointLight(0xffb873, 18, 10, 1.5);
    fillLight.position.set(-3.2, -0.3, -1.2);
    scene.add(fillLight);

    const current = new THREE.Vector3(0, 0, EYE_DISTANCE);
    const desired = new THREE.Vector3(0, 0, EYE_DISTANCE);
    let animationFrame = 0;
    let previousAnimationTime = performance.now();

    const resize = () => {
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };

    // The front of the case is the physical screen plane (z = 0). An off-axis
    // frustum keeps that plane locked to the display while the viewer moves,
    // creating the illusion of looking through a fixed window into the case.
    const updateOffAxisProjection = (eye: THREE.Vector3) => {
      const distanceToScreen = Math.max(eye.z, CAMERA_NEAR * 2);
      const scale = CAMERA_NEAR / distanceToScreen;
      const left = (-CASE_WIDTH / 2 - eye.x) * scale;
      const right = (CASE_WIDTH / 2 - eye.x) * scale;
      const bottom = (-CASE_HEIGHT / 2 - eye.y) * scale;
      const top = (CASE_HEIGHT / 2 - eye.y) * scale;
      camera.projectionMatrix.makePerspective(
        left,
        right,
        top,
        bottom,
        CAMERA_NEAR,
        CAMERA_FAR,
      );
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    };

    const animate = (animationTime = performance.now()) => {
      animationFrame = requestAnimationFrame(animate);
      const deltaSeconds = Math.min((animationTime - previousAnimationTime) / 1000, 0.1);
      previousAnimationTime = animationTime;
      desired.set(targetRef.current.x, targetRef.current.y, targetRef.current.z);
      const smoothing = 1 - Math.exp(-11 * deltaSeconds);
      current.lerp(desired, smoothing);
      camera.position.copy(current);
      camera.quaternion.identity();
      camera.updateMatrixWorld();
      updateOffAxisProjection(current);
      renderer.render(scene, camera);
    };

    resetRef.current = () => desired.set(0, 0, EYE_DISTANCE);
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();
    animate();

    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.LineSegments) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  const moveView = (event: React.PointerEvent<HTMLDivElement>) => {
    if (faceEnabledRef.current || !draggingRef.current) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    const y = 1 - ((event.clientY - bounds.top) / bounds.height) * 2;
    targetRef.current = { x: x * 0.82, y: y * 0.48, z: EYE_DISTANCE };
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
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsMoving(false);
  };

  const toggleFullscreen = () => {
    const element = mountRef.current?.closest<HTMLElement>('.case-shell');
    if (!element) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void element.requestFullscreen();
  };

  const statusLabel = !faceEnabled && isMoving ? '鼠标视角偏移' : trackerLabels[trackerState];
  const statusColor =
    trackerState === 'tracking'
      ? 'bg-[#71c8a2]'
      : trackerState === 'offline'
        ? 'bg-[#e36f63]'
        : trackerState === 'lost'
          ? 'bg-[#e8a45e]'
          : 'bg-[#7fb3c8]';

  return (
    <section className="w-[min(100vw,177.78vh)] max-w-none">
      <div className="case-shell relative overflow-hidden bg-[#101415] shadow-[0_42px_100px_rgba(0,0,0,0.55)]">
        <div
          data-case-viewport
          className="relative aspect-video w-full cursor-crosshair overflow-hidden bg-[#171b1c]"
          onPointerDown={startView}
          onPointerMove={moveView}
          onPointerUp={endView}
          onPointerCancel={endView}
        >
          <div ref={mountRef} className="absolute inset-0" aria-label="三维虚拟展示箱" />
          <div className="screen-frame pointer-events-none absolute inset-0 z-30" aria-hidden="true" />

          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-end bg-gradient-to-b from-black/40 to-transparent px-5 pb-12 pt-5 sm:px-8 sm:pt-7">
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-[11px] text-white/65 backdrop-blur-md">
              <span className={`size-1.5 rounded-full ${statusColor}`} />
              {statusLabel}
            </div>
          </div>

          <div className="absolute bottom-4 left-4 right-4 flex items-end justify-end gap-3 sm:bottom-7 sm:left-8 sm:right-8">
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon-lg"
                aria-label={faceEnabled ? '切换到鼠标模式' : '启用人脸跟踪'}
                onClick={toggleTrackingMode}
                className={`border-white/15 text-white hover:bg-black/55 hover:text-white ${
                  faceEnabled ? 'bg-[#6f9f91]/45' : 'bg-black/35'
                }`}
              >
                {faceEnabled ? <ScanFace /> : <MousePointer2 />}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-lg"
                aria-label={faceEnabled ? '重新校准中心' : '复位视角'}
                onClick={resetView}
                className="border-white/15 bg-black/35 text-white hover:bg-black/55 hover:text-white"
              >
                {faceEnabled ? <LocateFixed /> : <RotateCcw />}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-lg"
                aria-label="全屏查看"
                onClick={toggleFullscreen}
                className="border-white/15 bg-black/35 text-white hover:bg-black/55 hover:text-white"
              >
                <Maximize2 />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
