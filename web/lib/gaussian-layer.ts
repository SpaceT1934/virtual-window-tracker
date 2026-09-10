import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';

export type GaussianSource = File | string;

/** Loaded only when requested; the regular mesh path never initializes Spark. */
export function createGaussianLayer(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
  const spark = new SparkRenderer({ renderer, sortRadial: false, enableLod: false });
  const group = new THREE.Group();
  scene.add(spark, group);
  let active: SplatMesh | null = null;
  let generation = 0;
  let disposed = false;

  return {
    group,
    tune(blur: number, sigma: number) {
      spark.blurAmount = Math.min(1, Math.max(0.05, blur));
      spark.maxStdDev = Math.min(Math.sqrt(8), Math.max(2, sigma));
    },
    hide() { generation++; group.visible = false; },
    async load(source?: GaussianSource) {
      const request = ++generation;
      let bytes: ArrayBuffer | undefined;
      let fileName: string | undefined;
      if (typeof source === 'string') {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`预生成点云加载失败（HTTP ${response.status}）。`);
        bytes = await response.arrayBuffer();
        fileName = source.split(/[\\/?#]/).pop() || 'scene.gaussian.ply';
      } else if (source) {
        if (source.size > 128 * 1024 * 1024) throw new Error('当前入口限 128 MB；大型场景请先裁剪／压缩，后续再接入分块 LOD。');
        bytes = await source.arrayBuffer();
        fileName = source.name;
      }
      if (bytes && bytes.byteLength > 128 * 1024 * 1024) throw new Error('当前入口限 128 MB；大型场景请先裁剪／压缩，后续再接入分块 LOD。');
      if (disposed || request !== generation) return null;
      if (fileName?.toLowerCase().endsWith('.ply') && bytes) {
        const header = new TextDecoder().decode(bytes.slice(0, 2048));
        if (!/format binary_little_endian 1\.0/.test(header)) {
          throw new Error('PLY 需为二进制小端高斯格式；请从训练工具或 SuperSplat 重新导出。');
        }
      }
      const mesh = new SplatMesh(bytes ? { fileBytes: bytes, fileName, lod: false } : {
        constructSplats(splats) {
          const center = new THREE.Vector3();
          const scales = new THREE.Vector3(0.05, 0.025, 0.02);
          const orientation = new THREE.Quaternion();
          const color = new THREE.Color();
          for (let i = 0; i < 128; i++) {
            const u = i / 128 * Math.PI * 2;
            for (let j = 0; j < 32; j++) {
              const v = j / 32 * Math.PI * 2;
              center.set((0.9 + 0.28 * Math.cos(v)) * Math.cos(u),
                (0.9 + 0.28 * Math.cos(v)) * Math.sin(u), 0.28 * Math.sin(v));
              orientation.setFromEuler(new THREE.Euler(v, 0, u));
              color.setHSL(i / 128, 0.65, 0.5);
              splats.pushSplat(center, scales, orientation, 0.9, color);
            }
          }
        },
      });
      try {
        await mesh.initialized;
        if (disposed || request !== generation) { mesh.dispose(); return null; }
        const box = mesh.getBoundingBox();
        const size = box.getSize(new THREE.Vector3());
        const extent = Math.max(size.x, size.y, size.z);
        if (!Number.isFinite(extent) || extent <= 0) throw new Error('模型没有有效的高斯范围；普通网格 PLY 不等于高斯 PLY。');
        // Preserve asset scale. The window is a projection aperture, not a
        // container that silently fits every asset into its rectangle. Users
        // can position/scale content explicitly in the scene settings.
        mesh.scale.setScalar(1);
        mesh.position.copy(box.getCenter(new THREE.Vector3())).multiplyScalar(-1);
        if (active) { group.remove(active); active.dispose(); }
        active = mesh;
        group.add(mesh);
        group.visible = true;
        return fileName ?? '高斯算法测试环（4,096 个高斯，不是扫描模型）';
      } catch (error) {
        mesh.dispose();
        throw error;
      }
    },
    async dispose() {
      disposed = true;
      generation++;
      spark.autoUpdate = false;
      scene.remove(group, spark);
      // Keep render targets alive until an in-flight GPU readback/worker sort settles.
      // No new frames reference this layer once it has been detached.
      const deadline = performance.now() + 1000;
      while (spark.sorting && performance.now() < deadline) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
      }
      if (active) { group.remove(active); active.dispose(); }
      spark.dispose();
    },
  };
}
