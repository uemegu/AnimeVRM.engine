import * as THREE from 'three';
import { resolveAssetUrl } from '../utils/path';

/** 顔に重ねる絵（VRoid の顔の UV で描いたもの。engine に同梱） */
export const FACE_OVERLAY_TEXTURES = {
  blush: new URL('./textures/girl_face_blush.png', import.meta.url).href,
  sweat: new URL('./textures/girl_face_sweat.png', import.meta.url).href,
  anger: new URL('./textures/girl_face_anger.png', import.meta.url).href,
  /** 強い赤面（顔に濃い斜線と汗。blush より強い反応） */
  redface: new URL('./textures/girl_face_redface.avif', import.meta.url).href,
} as const;

/** 赤面の斜線を引く範囲（顔の UV。アルファが濃いところほど線が長く残る） */
const REDFACE_LINES_MASK = new URL('./textures/girl_face_redface_lines.avif', import.meta.url).href;

/**
 * 赤面の斜線（カメラから見てまっすぐ平行に引く。顔の丸みで曲がらないように UV ではなく見た目の向きで描く）。
 * 長さの単位はメートル。v は両目の中点から下向きの距離
 */
const HATCH = {
  /** 線の間隔 */
  spacing: 0.005,
  /** 線の太さ（間隔に対する割合の半分） */
  halfWidth: 0.06,
  /** 縦からの傾き（度） */
  slant: 12,
  /** 線の上端（目の中点から下へ）と、線ごとのばらつき */
  top: 0.002,
  topJitter: 0.016,
  /** 線の下端（口の横あたり）と、線ごとのばらつき */
  bottom: 0.056,
  bottomJitter: 0.022,
  /** 横の広がり（目の中点からの距離。外側ほど線が短く細くなる） */
  halfSpan: 0.052,
  /** 引かない線の割合（間隔を不ぞろいにする） */
  skip: 0.12,
  color: new THREE.Color(0.42, 0.05, 0.08),
  opacity: 0.85,
};

export type FaceOverlayKind = keyof typeof FACE_OVERLAY_TEXTURES;
export type FaceOverlayState = Record<FaceOverlayKind, boolean>;
export const FACE_OVERLAY_KINDS = Object.keys(FACE_OVERLAY_TEXTURES) as FaceOverlayKind[];

/** Accept old scenario paths too; the former per-avatar blush maps have been removed. */
export function getFaceOverlayKindForTexture(url: string): FaceOverlayKind | null {
  const match = url.split(/[?#]/)[0].match(/(?:^|\/)(?:girl2?_|)face_(blush|sweat|anger|redface)\.(?:png|avif)$/i);
  return match ? match[1].toLowerCase() as FaceOverlayKind : null;
}

export function isFaceSkinMaterial(material: THREE.Material): boolean {
  return /Face|顔/i.test(material.name)
    && !/Mouth|Eye|Brow|Lash|Line|口|目|眉|まつ/i.test(material.name)
    && !(material as THREE.Material & { isOutline?: boolean }).isOutline;
}

const _hatchCenter = new THREE.Vector3();

/** Layers use the face's UVs and deformation; neither the base map nor its alpha is changed. */
export class FaceOverlayEffect {
  private disposed = false;
  private loader = new THREE.TextureLoader();
  private textures = new Map<string, Promise<THREE.Texture>>();
  private patches: Array<{
    material: THREE.Material;
    compile: THREE.Material['onBeforeCompile'];
    cacheKey: THREE.Material['customProgramCacheKey'];
  }> = [];
  private layers = Object.fromEntries(FACE_OVERLAY_KINDS.map((kind) => [kind, {
    enabled: false,
    revision: 0,
    texture: { value: null as THREE.Texture | null },
    weight: { value: 0 },
  }])) as Record<FaceOverlayKind, {
    enabled: boolean;
    revision: number;
    texture: { value: THREE.Texture | null };
    weight: { value: number };
  }>;

  /** 赤面の斜線（範囲の絵・強さ・頭の中心のカメラ座標） */
  private hatch = {
    mask: { value: null as THREE.Texture | null },
    weight: { value: 0 },
    center: { value: new THREE.Vector2() },
  };

  constructor(root: THREE.Object3D) {
    const materials = new Set<THREE.Material>();
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry.getAttribute('uv')) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (isFaceSkinMaterial(material)) materials.add(material);
      }
    });
    for (const material of materials) this.patch(material);
  }

  getState(): FaceOverlayState {
    return Object.fromEntries(FACE_OVERLAY_KINDS.map((kind) => [kind, this.layers[kind].enabled])) as FaceOverlayState;
  }

  async setEnabled(kind: FaceOverlayKind, enabled: boolean, url: string = FACE_OVERLAY_TEXTURES[kind]): Promise<void> {
    if (this.disposed) return;
    const layer = this.layers[kind];
    const revision = ++layer.revision;
    layer.enabled = enabled;
    layer.weight.value = 0;
    if (kind === 'redface') this.hatch.weight.value = 0;
    if (!enabled) return;
    try {
      if (this.patches.length === 0) throw new Error('No face skin material with UVs was found');
      const [texture, mask] = await Promise.all([
        this.loadTexture(url),
        kind === 'redface' ? this.loadTexture(REDFACE_LINES_MASK) : Promise.resolve(null),
      ]);
      if (this.disposed || revision !== layer.revision) return;
      layer.texture.value = texture;
      layer.weight.value = 1;
      if (mask) {
        this.hatch.mask.value = mask;
        this.hatch.weight.value = 1;
      }
    } catch (error) {
      if (this.disposed || revision !== layer.revision) return;
      layer.enabled = false;
      throw error;
    }
  }

  /** 斜線を顔に貼りつけるため、毎フレーム両目の中点をカメラ座標で渡す */
  updateHatch(camera: THREE.Camera, eyesWorld: THREE.Vector3): void {
    if (this.hatch.weight.value <= 0) return;
    const p = _hatchCenter.copy(eyesWorld).applyMatrix4(camera.matrixWorldInverse);
    this.hatch.center.value.set(p.x, p.y);
  }

  private loadTexture(url: string): Promise<THREE.Texture> {
    const resolved = resolveAssetUrl(url);
    let pending = this.textures.get(resolved);
    if (!pending) {
      pending = this.loader.loadAsync(resolved).then((texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.flipY = false;
        texture.anisotropy = 16;
        texture.needsUpdate = true;
        return texture;
      }).catch((error) => {
        this.textures.delete(resolved);
        throw error;
      });
      this.textures.set(resolved, pending);
    }
    return pending;
  }

  private patch(material: THREE.Material): void {
    const compile = material.onBeforeCompile;
    const cacheKey = material.customProgramCacheKey;
    this.patches.push({ material, compile, cacheKey });
    const declarations = FACE_OVERLAY_KINDS.map((kind) => `
      uniform sampler2D faceOverlay_${kind};
      uniform float faceOverlayWeight_${kind};
    `).join('\n');
    const blend = FACE_OVERLAY_KINDS.map((kind) => `
      if (faceOverlayWeight_${kind} > 0.0) {
        vec4 layer = texture2D(faceOverlay_${kind}, vFaceOverlayUv);
        base = mix(base, layer.rgb, layer.a * faceOverlayWeight_${kind});
      }
    `).join('\n');
    const slant = THREE.MathUtils.degToRad(HATCH.slant);
    const f = (v: number) => v.toFixed(5);
    const hatch = `
      uniform sampler2D faceHatchMask;
      uniform float faceHatchWeight;
      uniform vec2 faceHatchCenter;
      float faceHatchHash(float n) { return fract(sin(n * 127.1 + 0.37) * 43758.5453); }
      float faceHatch() {
        if (faceHatchWeight <= 0.0) return 0.0;
        float mask = texture2D(faceHatchMask, vFaceOverlayUv).a;
        if (mask <= 0.0) return 0.0;
        vec2 p = vFaceHatchPos.xy - faceHatchCenter;
        float across = dot(p, vec2(${f(Math.cos(slant))}, ${f(Math.sin(slant))}));
        float v = dot(p, vec2(${f(Math.sin(slant))}, ${f(-Math.cos(slant))}));
        float u = across / ${f(HATCH.spacing)};
        float id = floor(u);
        if (faceHatchHash(id + 3.0) < ${f(HATCH.skip)}) return 0.0;
        // 外側の線ほど短い
        float side = clamp(abs(across) / ${f(HATCH.halfSpan)}, 0.0, 1.0);
        if (side >= 1.0) return 0.0;
        float shrink = 1.0 - side * side;
        float top = ${f(HATCH.top)} + (faceHatchHash(id + 11.0) - 0.5) * ${f(HATCH.topJitter)} + side * 0.012;
        float bottom = top + (${f(HATCH.bottom)} - top) * (0.55 + 0.45 * shrink) + (faceHatchHash(id + 17.0) - 0.5) * ${f(HATCH.bottomJitter)};
        float t = (v - top) / max(bottom - top, 0.001);
        if (t <= 0.0 || t >= 1.0) return 0.0;
        // 入り抜き：上は短く入り、下はゆっくり抜く
        float taper = smoothstep(0.0, 0.15, t) * (1.0 - smoothstep(0.55, 1.0, t));
        float w = ${f(HATCH.halfWidth)} * (0.75 + 0.5 * faceHatchHash(id + 5.0)) * taper * (0.6 + 0.4 * shrink);
        float c = 0.5 + (faceHatchHash(id + 23.0) - 0.5) * 0.4;
        float d = abs(fract(u) - c);
        float aa = fwidth(u) * 0.75;
        return (1.0 - smoothstep(w - aa, w + aa, d)) * smoothstep(0.0, 0.5, mask) * faceHatchWeight * ${f(HATCH.opacity)};
      }
    `;
    const hatchColor = `vec3(${f(HATCH.color.r)}, ${f(HATCH.color.g)}, ${f(HATCH.color.b)})`;
    material.onBeforeCompile = (shader, renderer) => {
      compile.call(material, shader, renderer);
      for (const kind of FACE_OVERLAY_KINDS) {
        shader.uniforms[`faceOverlay_${kind}`] = this.layers[kind].texture;
        shader.uniforms[`faceOverlayWeight_${kind}`] = this.layers[kind].weight;
      }
      shader.uniforms.faceHatchMask = this.hatch.mask;
      shader.uniforms.faceHatchWeight = this.hatch.weight;
      shader.uniforms.faceHatchCenter = this.hatch.center;
      shader.vertexShader = `varying vec2 vFaceOverlayUv;\nvarying vec3 vFaceHatchPos;\n${shader.vertexShader}`
        .replace('void main() {', 'void main() {\n vFaceOverlayUv = uv;')
        .replace('#include <project_vertex>', '#include <project_vertex>\n vFaceHatchPos = mvPosition.xyz;');
      shader.fragmentShader = `
        varying vec2 vFaceOverlayUv;
        varying vec3 vFaceHatchPos;
        ${declarations}
        ${hatch}
        vec3 applyFaceOverlays(vec3 base) { ${blend} return mix(base, ${hatchColor}, faceHatch()); }
        ${shader.fragmentShader}
      `.replace('#include <alphatest_fragment>', `
        diffuseColor.rgb = applyFaceOverlays(diffuseColor.rgb);
        #include <alphatest_fragment>
      `).replace('material.shadingShift = shadingShiftFactor;', `
        material.shadeColor = applyFaceOverlays(material.shadeColor);
        material.shadingShift = shadingShiftFactor;
      `);
    };
    material.customProgramCacheKey = () => `${cacheKey.call(material)}:face-overlays-v3`;
    material.needsUpdate = true;
  }

  dispose(): void {
    this.disposed = true;
    for (const { material, compile, cacheKey } of this.patches) {
      material.onBeforeCompile = compile;
      material.customProgramCacheKey = cacheKey;
      material.needsUpdate = true;
    }
    this.patches = [];
    for (const pending of this.textures.values()) {
      void pending.then((texture) => texture.dispose(), () => {});
    }
    this.textures.clear();
  }
}
