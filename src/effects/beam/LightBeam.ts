import * as THREE from 'three';

/** 光線が始点から終点まで伸びきるまでの秒数 */
const EXTEND_SEC = 0.12;
/** 撃ち終わってから細くなって消えるまでの秒数 */
const FADE_SEC = 0.25;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uTime;
  uniform float uHead;
  varying vec2 vUv;

  void main() {
    // 横方向：白い芯と色のついた外側の光
    float x = abs(vUv.y - 0.5) * 2.0;
    float core = exp(-x * x * 60.0);
    float glow = exp(-x * x * 6.0);
    // 縦方向：伸びている先端より先は描かない。流れる揺らぎで力がほとばしって見えるようにする
    float along = vUv.x;
    if (along > uHead) discard;
    float flicker = 0.8 + 0.2 * sin(along * 40.0 - uTime * 60.0) * sin(along * 13.0 + uTime * 23.0);
    float tip = smoothstep(uHead, uHead - 0.04, along);
    vec3 color = (vec3(1.0) * core * 2.5 + uColor * glow * 1.6) * flicker * uIntensity * tip;
    gl_FragColor = vec4(color, 1.0);
  }
`;

/** 光線の指定（始点・終点・撃ち続ける秒数・色・太さ） */
export interface LightBeamSettings {
  from: [number, number, number];
  to: [number, number, number];
  duration: number;
  color: string;
  width: number;
}

/**
 * 始点から終点へ放つ光線。始点から一気に伸び、撃ち続けたあと細くなって消える。
 * 帯は光線の軸の周りでカメラへ向け、加算合成の明るい色でブルームに光らせる。
 * 撃ってからの秒数だけで見た目が決まるので、途中から再生しても同じ絵になる
 */
export class LightBeam {
  private readonly mesh: THREE.Mesh;
  private readonly flare: THREE.Sprite;
  private readonly material: THREE.ShaderMaterial;
  private readonly from: THREE.Vector3;
  private readonly to: THREE.Vector3;
  private readonly settings: LightBeamSettings;

  constructor(scene: THREE.Scene, settings: LightBeamSettings) {
    this.settings = settings;
    this.from = new THREE.Vector3(...settings.from);
    this.to = new THREE.Vector3(...settings.to);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(settings.color) },
        uIntensity: { value: 1 },
        uTime: { value: 0 },
        uHead: { value: 0 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    // 長さ 1・幅 1 の帯（u が始点→終点、v が幅）。毎フレーム置き直す
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.mesh.name = 'LightBeam';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    scene.add(this.mesh);

    // 撃ち出す手元の光
    const flareMaterial = new THREE.SpriteMaterial({
      map: LightBeam.flareTexture(),
      color: new THREE.Color(settings.color).multiplyScalar(3),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
    });
    this.flare = new THREE.Sprite(flareMaterial);
    this.flare.position.copy(this.from);
    this.flare.renderOrder = 4;
    scene.add(this.flare);
  }

  /** 撃ってからの秒数で、伸び・明るさ・太さを当てる。消えきったら false */
  update(elapsed: number, camera: THREE.Camera): boolean {
    const { duration, width } = this.settings;
    const total = EXTEND_SEC + duration + FADE_SEC;
    const visible = elapsed >= 0 && elapsed < total;
    this.mesh.visible = visible;
    this.flare.visible = visible;
    if (!visible) return elapsed < total;

    const head = Math.min(1, elapsed / EXTEND_SEC);
    const fade = 1 - THREE.MathUtils.clamp((elapsed - EXTEND_SEC - duration) / FADE_SEC, 0, 1);
    // 撃った瞬間は太く、すぐ落ち着く
    const burst = 1 + 0.8 * Math.exp(-elapsed * 12);
    const beamWidth = width * burst * (0.25 + 0.75 * fade);
    this.material.uniforms.uHead.value = head;
    this.material.uniforms.uTime.value = elapsed;
    this.material.uniforms.uIntensity.value = fade;

    // 帯を始点→終点に沿わせ、軸の周りで回してカメラに面を向ける
    const axis = this.to.clone().sub(this.from);
    const length = axis.length();
    axis.normalize();
    const center = this.from.clone().addScaledVector(axis, length / 2);
    const toCamera = camera.getWorldPosition(new THREE.Vector3()).sub(center);
    const side = new THREE.Vector3().crossVectors(axis, toCamera).normalize();
    const normal = new THREE.Vector3().crossVectors(side, axis).normalize();
    this.mesh.matrixAutoUpdate = false;
    this.mesh.matrix.makeBasis(axis.clone().multiplyScalar(length), side.clone().multiplyScalar(beamWidth), normal);
    this.mesh.matrix.setPosition(center);
    this.mesh.matrixWorldNeedsUpdate = true;

    const flareSize = width * 2 * burst * fade;
    this.flare.scale.set(flareSize, flareSize, 1);
    return true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.flare.removeFromParent();
    this.flare.material.dispose();
  }

  private static texture: THREE.Texture | null = null;

  /** 中心ほど明るい丸い光（1枚を使い回す） */
  private static flareTexture(): THREE.Texture {
    if (LightBeam.texture) return LightBeam.texture;
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.3, 'rgba(255,255,255,0.5)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    LightBeam.texture = new THREE.CanvasTexture(canvas);
    return LightBeam.texture;
  }
}
