import * as THREE from 'three';

/** 瞳の絵の中心（左右2つの瞳を1枚に並べた VRoid の絵。見つからないときの既定値） */
const DEFAULT_CENTERS: [THREE.Vector2, THREE.Vector2] = [new THREE.Vector2(0.278, 0.509), new THREE.Vector2(0.722, 0.509)];

/**
 * 瞳を小さくする（驚いて瞳が縮む漫画の表現）。
 * 瞳の絵は左右の瞳を1枚に並べてあるので、絵全体ではなくそれぞれの瞳の中心で縮める
 */
export class IrisShrinkEffect {
  private readonly scale = { value: 1 };
  private readonly centerL = { value: DEFAULT_CENTERS[0].clone() };
  private readonly centerR = { value: DEFAULT_CENTERS[1].clone() };
  private patches: Array<{
    material: THREE.Material;
    compile: THREE.Material['onBeforeCompile'];
    cacheKey: THREE.Material['customProgramCacheKey'];
  }> = [];

  constructor(root: THREE.Object3D) {
    const materials = new Set<THREE.Material & { map?: THREE.Texture | null }>();
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (material && /EyeIris|Iris|瞳|虹彩/i.test(material.name) && !(material as { isOutline?: boolean }).isOutline) materials.add(material);
      }
    });
    for (const material of materials) {
      this.patch(material);
      if (material.map) this.findCenters(material.map);
    }
  }

  /** 瞳の大きさ（1 で元のまま、小さいほど縮む） */
  setScale(scale: number): void {
    this.scale.value = scale;
  }

  /** 絵の透明でないところから、左右それぞれの瞳の中心を求める */
  private findCenters(texture: THREE.Texture): void {
    const image = texture.image as CanvasImageSource & { width?: number; height?: number } | undefined;
    if (!image || !image.width || !image.height || typeof document === 'undefined') return;
    try {
      const w = 256;
      const h = Math.max(1, Math.round(256 * image.height / image.width));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(image, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      const halves = [{ x0: 0, x1: w / 2 }, { x0: w / 2, x1: w }].map(({ x0, x1 }) => {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let y = 0; y < h; y++) {
          for (let x = Math.floor(x0); x < x1; x++) {
            if (data[(y * w + x) * 4 + 3] < 32) continue;
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          }
        }
        return Number.isFinite(minX) ? new THREE.Vector2((minX + maxX + 1) / 2 / w, (minY + maxY + 1) / 2 / h) : null;
      });
      // 片側にしか絵がない（瞳1つの絵）ときは、縮める中心を両方そこにする
      const [l, r] = halves;
      if (l) this.centerL.value.copy(l);
      if (r) this.centerR.value.copy(r);
      if (l && !r) this.centerR.value.copy(l);
      if (r && !l) this.centerL.value.copy(r);
    } catch {
      // 読めない絵（別オリジンなど）は既定の中心のまま
    }
  }

  private patch(material: THREE.Material): void {
    const compile = material.onBeforeCompile;
    const cacheKey = material.customProgramCacheKey;
    this.patches.push({ material, compile, cacheKey });
    material.onBeforeCompile = (shader, renderer) => {
      compile.call(material, shader, renderer);
      shader.uniforms.irisShrinkScale = this.scale;
      shader.uniforms.irisShrinkCenterL = this.centerL;
      shader.uniforms.irisShrinkCenterR = this.centerR;
      shader.fragmentShader = `
        uniform float irisShrinkScale;
        uniform vec2 irisShrinkCenterL;
        uniform vec2 irisShrinkCenterR;
        ${shader.fragmentShader}
      `.replace('vec2 mapUv = ( mapUvTransform * vec3( uv, 1 ) ).xy;', `
        vec2 irisCenter = uv.x < 0.5 ? irisShrinkCenterL : irisShrinkCenterR;
        vec2 irisUv = irisCenter + (uv - irisCenter) / irisShrinkScale;
        vec2 mapUv = ( mapUvTransform * vec3( irisUv, 1 ) ).xy;
      `);
    };
    material.customProgramCacheKey = () => `${cacheKey.call(material)}:iris-shrink-v1`;
    material.needsUpdate = true;
  }

  dispose(): void {
    for (const { material, compile, cacheKey } of this.patches) {
      material.onBeforeCompile = compile;
      material.customProgramCacheKey = cacheKey;
      material.needsUpdate = true;
    }
    this.patches = [];
  }
}
