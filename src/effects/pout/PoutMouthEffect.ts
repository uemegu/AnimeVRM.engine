import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { measureFaceLandmarks, type FaceLandmarks } from '../cry/faceLandmarks';

/** 正面から何度までは口の絵を出し切るか・何度で消し切るか（cos）。間が広いと、薄い絵と元の口が重なって見えるので狭くする */
const FULL_COS = Math.cos(THREE.MathUtils.degToRad(42));
const HIDDEN_COS = Math.cos(THREE.MathUtils.degToRad(48));
/** 板がこれより薄いときは、元の口を出す */
const SHOW_NATIVE_BELOW = 0.5;

/** 絵の大きさ（閉じた口の幅に対する、記号の高さ） */
const HEIGHT_PER_MOUTH = 0.4;
/** 線の色（参照の絵の線のいちばん濃い所） */
const LINE_COLOR = '#6e4640';

/**
 * ぷくっとむくれた口（漫画の「（」に横線を添えた記号）を口の前に貼る。
 * 参照の絵：右に「（」形の弧、その弧のいちばん左の点へ左から短い横線が入る。線は細く、両端が細くなる。
 * 元の口（顔のメッシュの FaceMouth の部品）は、絵を出している間だけ隠す。板なので、正面から外れたら元の口に戻す
 */
export class PoutMouthEffect {
  private readonly landmarks: FaceLandmarks | null;
  private readonly group = new THREE.Group();
  private plate: THREE.Mesh | null = null;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly texture: THREE.CanvasTexture | null;
  private readonly nativeMouths: THREE.Mesh[] = [];
  /** 元の口のまわりに残る唇の赤みを隠す当て板（顔の肌と同じ材質で、何もない肌の所の色を貼る） */
  private patch: THREE.Mesh | null = null;
  private on = false;
  private fade = 0;
  private readonly normal = new THREE.Vector3();
  private readonly position = new THREE.Vector3();
  private readonly toCamera = new THREE.Vector3();

  constructor(vrm: VRM) {
    this.group.name = 'PoutMouthEffect';
    this.group.visible = false;
    this.landmarks = measureFaceLandmarks(vrm);
    this.texture = typeof document !== 'undefined' ? drawGlyph() : null;
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      opacity: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    vrm.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (materials.some((m) => /FaceMouth/i.test(m.name))) this.nativeMouths.push(mesh);
    });

    const lm = this.landmarks;
    if (!lm?.mouth || !this.texture) return;
    lm.head.add(this.group);
    const height = Math.max(lm.mouth.width * HEIGHT_PER_MOUTH, 0.008);
    this.plate = new THREE.Mesh(new THREE.PlaneGeometry(height, height), this.material);
    this.plate.name = 'PoutMouthEffect_Plate';
    this.plate.renderOrder = 210;
    this.plate.frustumCulled = false;
    this.plate.quaternion.setFromRotationMatrix(faceBasis(lm));
    this.plate.position.copy(lm.mouth.center).addScaledVector(lm.forward, 0.004);
    this.group.add(this.plate);
    this.patch = makeSkinPatch(vrm, lm, height);
    if (this.patch) this.group.add(this.patch);
  }

  setEnabled(enabled: boolean): void {
    this.on = enabled;
  }

  update(delta: number, camera: THREE.Camera): void {
    const rate = Math.min(1, delta * 8);
    const target = this.on && this.plate ? 1 : 0;
    this.fade += (target - this.fade) * rate;
    if (!this.on && this.fade < 0.01) this.fade = 0;
    if (this.on && this.fade > 0.99) this.fade = 1;
    let facing = 0;
    if (this.plate && this.fade > 0) {
      this.plate.getWorldPosition(this.position);
      this.normal.set(0, 0, 1).transformDirection(this.plate.matrixWorld);
      camera.getWorldPosition(this.toCamera).sub(this.position).normalize();
      facing = THREE.MathUtils.smoothstep(this.normal.dot(this.toCamera), HIDDEN_COS, FULL_COS);
    }
    const opacity = this.fade * facing;
    this.material.opacity = opacity;
    this.group.visible = opacity > 0.001;
    const hideNative = opacity >= SHOW_NATIVE_BELOW;
    if (this.patch) this.patch.visible = hideNative;
    for (const mesh of this.nativeMouths) mesh.visible = !hideNative;
  }

  dispose(): void {
    for (const mesh of this.nativeMouths) mesh.visible = true;
    this.group.parent?.remove(this.group);
    this.plate?.geometry.dispose();
    this.patch?.geometry.dispose();
    this.material.dispose();
    this.texture?.dispose();
  }
}

/** 記号を描いた絵（正方形）。座標は中心を原点、上を +y、記号の高さを 1.8 とした単位 */
function drawGlyph(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const scale = size / 2.2;
  const toPx = (x: number, y: number): [number, number] => [size / 2 + x * scale, size / 2 - y * scale];
  g.fillStyle = LINE_COLOR;
  // 線の太さ：真ん中が太く、両端が細い
  const stroke = (p0: [number, number], c: [number, number], p1: [number, number], width: number, taperStart: boolean, taperEnd: boolean) => {
    const steps = 160;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0];
      const y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1];
      const a = taperStart ? Math.min(1, t / 0.35) : 1;
      const b = taperEnd ? Math.min(1, (1 - t) / 0.35) : 1;
      const r = (width / 2) * Math.max(0.25, Math.sqrt(Math.min(a, b))) * scale;
      const [px, py] = toPx(x, y);
      g.beginPath();
      g.arc(px, py, r, 0, Math.PI * 2);
      g.fill();
    }
  };
  const width = 0.15;
  // 右の「（」の弧：上の端から、いちばん左の点を通って下の端へ
  stroke([0.6, 0.9], [-0.2, -0.2], [0.6, -0.9], width, true, true);
  // 左から弧のいちばん左の点へ入る短い線（上へ少しふくらむ）
  stroke([-0.8, -0.3], [-0.35, 0.05], [0.2, -0.1], width * 0.9, true, false);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * 口の上に敷く当て板。顔の肌の部品と同じ材質を使い（光の当たり方が肌とそろう）、どの頂点にも口の下の何もない肌の
 * UV を入れて、その色一色にする。元の口の部品を隠しても、肌の絵に描かれた唇の赤みは残るので、これで覆う
 */
function makeSkinPatch(vrm: VRM, lm: FaceLandmarks, glyphHeight: number): THREE.Mesh | null {
  const head = lm.head;
  let skin: THREE.SkinnedMesh | null = null;
  let material: THREE.Material | null = null;
  vrm.scene.traverse((object) => {
    const mesh = object as THREE.SkinnedMesh;
    if (skin || !mesh.isSkinnedMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const found = materials.find((m) => /Face_00_SKIN/i.test(m.name) && !/Outline/i.test(m.name));
    if (found && mesh.skeleton.bones.includes(head as THREE.Bone)) {
      skin = mesh;
      material = found;
    }
  });
  if (!skin || !material) return null;
  const mesh = skin as THREE.SkinnedMesh;
  const uv = mesh.geometry.attributes.uv as THREE.BufferAttribute | undefined;
  if (!uv) return null;
  // バインドポーズのモデル座標 → 頭のボーンの座標
  const toHead = mesh.skeleton.boneInverses[mesh.skeleton.bones.indexOf(head as THREE.Bone)];
  const position = mesh.geometry.attributes.position as THREE.BufferAttribute;
  // 口の真ん中から下へ、口の幅の 0.6 倍の所（唇の赤みのない肌）
  const target = lm.mouth!.center.clone().addScaledVector(lm.up, -lm.mouth!.width * 0.6);
  const p = new THREE.Vector3();
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i).applyMatrix4(toHead);
    const d = p.distanceToSquared(target);
    if (d < bestDistance) { bestDistance = d; best = i; }
  }
  if (best < 0) return null;
  const geometry = new THREE.CircleGeometry(glyphHeight * 0.8, 24);
  const uvs = geometry.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uvs.count; i++) uvs.setXY(i, uv.getX(best), uv.getY(best));
  const patch = new THREE.Mesh(geometry, material);
  patch.name = 'PoutMouthEffect_SkinPatch';
  patch.renderOrder = 209;
  patch.frustumCulled = false;
  patch.quaternion.setFromRotationMatrix(faceBasis(lm));
  patch.position.copy(lm.mouth!.center).addScaledVector(lm.forward, 0.002);
  return patch;
}

/** 板の向き：Z を顔の正面、Y を上にした回転 */
function faceBasis(lm: FaceLandmarks): THREE.Matrix4 {
  const z = lm.forward.clone().normalize();
  const x = new THREE.Vector3().crossVectors(lm.up, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return new THREE.Matrix4().makeBasis(x, y, z);
}
