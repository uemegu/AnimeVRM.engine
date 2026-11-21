import * as THREE from 'three';
import { VRM, VRMExpression, VRMExpressionMorphTargetBind } from '@pixiv/three-vrm';

/**
 * 頬を膨らませる・つまんで引っぱる形状キーを、読み込み時に顔のメッシュへ作り足す。
 *
 * VRoid の顔には頬の形状キーがない（ARKit の cheekPuff、MetaHuman の mouthCheekBlow に当たるもの）。
 * そこで、モデリングでいう「範囲を減衰させた押し出し」（Maya のソフト選択、Softimage の puff）と同じ形を、
 * 顔の目印（目の骨・口の頂点）から決めた頬の位置を中心に計算して形状キーにする。
 *
 * - Cheek_Puff_L / _R：頬の中心の周りを、頂点の法線と横向きの間の向きへ押し出す。口の端寄りが一番ふくらみ、
 *   下まぶたより上には届かない
 * - Cheek_Pinch_L / _R：頬の1点を指でつまんで横・前へ引っぱる。つまんだ点がとがり、口の端も引かれる
 *
 * 法線も形に合わせて変える（変えないと、ふくらんだ頬の陰が元のまま平らに見える）。
 * 顔の部品（白目・まつ毛・口の中）も同じ変形で動かし、肌との間にすき間を作らない。
 * 目の骨か口の形状キー（Fcl_MTH_A）がないモデルでは何もしない。
 */

const SHAPES = ['Cheek_Puff_L', 'Cheek_Puff_R', 'Cheek_Pinch_L', 'Cheek_Pinch_R'] as const;
type CheekShape = (typeof SHAPES)[number];

/** 頬だけを引く表情の名前（自分の手でつまむときに使う） */
export const PINCH_SHAPE_EXPRESSIONS = { left: 'cheekPinchShapeLeft', right: 'cheekPinchShapeRight' } as const;

/** つまむ所（読み込み時の姿勢のワールド座標）と、つまんで引いたときにそこが動く量（ワールド座標） */
export interface CheekPinchPoints {
  left: { point: THREE.Vector3; pull: THREE.Vector3 };
  right: { point: THREE.Vector3; pull: THREE.Vector3 };
}

/** 形状キーを組み合わせて作る表情 */
const CHEEK_EXPRESSIONS: Record<string, { shapeKey: string; weight: number }[]> = {
  // ぷくー：片方の頬（体の左）を膨らませて怒る。口は閉じてとがらせる（怒りマークは StageManager が付ける）
  puku: [
    { shapeKey: 'Cheek_Puff_L', weight: 1.0 },
    { shapeKey: 'Fcl_BRW_Angry', weight: 1.0 },
    { shapeKey: 'Fcl_EYE_Angry', weight: 1.0 },
    // 口は小さく閉じる（正面では漫画のむくれた口の絵を上に貼る。元の口の端が絵の外にはみ出さないよう小さくする）
    { shapeKey: 'Fcl_MTH_Small', weight: 1.0 },
    { shapeKey: 'Fcl_MTH_Close', weight: 1.0 },
  ],
  // 両頬をつまんで横へ引っぱられる（むにー）。つまむ手は別に用意する（自分の手でつまむときの半分強の引き）
  cheekPinch: [
    { shapeKey: 'Cheek_Pinch_L', weight: 0.6 },
    { shapeKey: 'Cheek_Pinch_R', weight: 0.6 },
    { shapeKey: 'Fcl_BRW_Sorrow', weight: 1.0 },
    { shapeKey: 'Fcl_MTH_I', weight: 0.3 },
  ],
  cheekPinchLeft: [
    { shapeKey: 'Cheek_Pinch_L', weight: 0.6 },
    { shapeKey: 'Fcl_BRW_Sorrow', weight: 0.4 },
  ],
  cheekPinchRight: [
    { shapeKey: 'Cheek_Pinch_R', weight: 0.6 },
    { shapeKey: 'Fcl_BRW_Sorrow', weight: 0.4 },
  ],
  // 自分の手でつまむとき（cheekPinch.ts）に、手の動きに合わせて頬だけを引く。表情の一覧には出さない
  [PINCH_SHAPE_EXPRESSIONS.left]: [{ shapeKey: 'Cheek_Pinch_L', weight: 1.0 }],
  [PINCH_SHAPE_EXPRESSIONS.right]: [{ shapeKey: 'Cheek_Pinch_R', weight: 1.0 }],
};

/** 顔の幅に対する割合で決める大きさ */
const PUFF = { radius: 0.3, depth: 0.09 };
const PINCH = { radius: 0.2, pull: 0.28 };

interface FaceFrame {
  /** 頬の中心（左右）。ワールド座標 */
  puffCenter: Record<'L' | 'R', THREE.Vector3>;
  pinchCenter: Record<'L' | 'R', THREE.Vector3>;
  /** 下まぶたの高さ（これより上は動かさない） */
  eyeY: number;
  mouthY: number;
  /** 口角（左右）。ワールド座標 */
  mouthCorner: Record<'L' | 'R', THREE.Vector3>;
  width: number;
}

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();

function faceMeshes(vrm: VRM): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  vrm.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && mesh.morphTargetDictionary?.Fcl_MTH_A !== undefined) meshes.push(mesh);
  });
  return meshes;
}

/** 頂点をワールド座標で（読み込み時の姿勢） */
function worldPosition(mesh: THREE.Mesh, i: number, out: THREE.Vector3): THREE.Vector3 {
  return out.fromBufferAttribute(mesh.geometry.attributes.position as THREE.BufferAttribute, i).applyMatrix4(mesh.matrixWorld);
}

/** 目の骨と、口の形状キーで動く頂点（唇）から、頬の位置を決める */
function measureFace(vrm: VRM, meshes: THREE.Mesh[]): FaceFrame | null {
  const leftEye = vrm.humanoid.getRawBoneNode('leftEye')?.getWorldPosition(new THREE.Vector3());
  const rightEye = vrm.humanoid.getRawBoneNode('rightEye')?.getWorldPosition(new THREE.Vector3());
  if (!leftEye || !rightEye) return null;

  // 唇：Fcl_MTH_A で大きく動く頂点
  const lips: THREE.Vector3[] = [];
  const skin: THREE.Vector3[] = [];
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const delta = geometry.morphAttributes.position?.[mesh.morphTargetDictionary!.Fcl_MTH_A];
    const count = geometry.attributes.position.count;
    for (let i = 0; i < count; i++) {
      const p = worldPosition(mesh, i, new THREE.Vector3());
      skin.push(p);
      if (delta && _n.fromBufferAttribute(delta as THREE.BufferAttribute, i).length() > 0.003) lips.push(p);
    }
  }
  if (lips.length < 10) return null;

  const eyeY = (leftEye.y + rightEye.y) / 2;
  const eyeZ = (leftEye.z + rightEye.z) / 2;
  const centerX = (leftEye.x + rightEye.x) / 2;
  const mouthY = lips.reduce((s, p) => s + p.y, 0) / lips.length;
  const mouthHalf = Math.max(...lips.map((p) => Math.abs(p.x - centerX)));
  const eyeHalf = Math.abs(leftEye.x - rightEye.x) / 2;
  // 顔の輪郭：その高さで、目より大きく後ろにない頂点の横の端（耳・髪は顔のメッシュにない）
  const contour = (y: number, sign: number) => {
    const band = skin.filter((p) => Math.abs(p.y - y) < 0.008 && p.z > eyeZ - 0.035 && (p.x - centerX) * sign > 0);
    return band.length > 0 ? Math.max(...band.map((p) => (p.x - centerX) * sign)) : eyeHalf * 1.8;
  };
  // 顔の幅は頬の高さで測る（目の高さでは耳まで入る）
  const cheekY = mouthY + (eyeY - mouthY) * 0.25;
  const width = contour(cheekY, 1) + contour(cheekY, -1);

  // 頬の中心：横は口の端と顔の輪郭の間、高さは口と目の間。その位置の顔の表面（いちばん前の点）
  const surface = (x: number, y: number) => {
    const near = skin.filter((p) => Math.abs(p.x - x) < 0.012 && Math.abs(p.y - y) < 0.012);
    const z = near.length > 0 ? Math.max(...near.map((p) => p.z)) : eyeZ;
    return new THREE.Vector3(x, y, z);
  };
  const side = (sign: number, across: number, up: number) => {
    const y = mouthY + (eyeY - mouthY) * up;
    const x = centerX + sign * (mouthHalf + (contour(y, sign) - mouthHalf) * across);
    return surface(x, y);
  };
  // つまむ所は顔の頂点に合わせる（頂点の間だと、粗い顔ではそこまで引かれず、指が頬から浮く）
  const snap = (p: THREE.Vector3) => skin.reduce((best, q) => (q.distanceToSquared(p) < best.distanceToSquared(p) ? q : best)).clone();
  // 左は +X 側（VRM はモデルの左が +X）
  return {
    puffCenter: { L: side(1, 0.5, 0.1), R: side(-1, 0.5, 0.1) },
    pinchCenter: { L: snap(side(1, 0.4, 0.1)), R: snap(side(-1, 0.4, 0.1)) },
    eyeY: eyeY - (eyeY - mouthY) * 0.25,
    mouthY,
    mouthCorner: { L: new THREE.Vector3(centerX + mouthHalf, mouthY, 0), R: new THREE.Vector3(centerX - mouthHalf, mouthY, 0) },
    width,
  };
}

/** 頂点（ワールド座標）と法線から、形状キーごとの動き（ワールド座標）を返す */
function displacement(shape: CheekShape, p: THREE.Vector3, n: THREE.Vector3, face: FaceFrame, out: THREE.Vector3): THREE.Vector3 {
  out.set(0, 0, 0);
  const sideName = shape.endsWith('_L') ? 'L' : 'R';
  const sign = sideName === 'L' ? 1 : -1;
  // 正面より後ろ・反対側の頬は動かさない
  if (n.z < -0.2) return out;
  // 下まぶたより上へは届かせない
  const lid = THREE.MathUtils.smoothstep(face.eyeY - p.y, 0, face.width * 0.08);

  if (shape.startsWith('Cheek_Puff')) {
    const c = face.puffCenter[sideName];
    const r = face.width * PUFF.radius;
    // 縦に少しつぶした楕円の範囲
    const dx = (p.x - c.x) / r;
    const dy = (p.y - c.y) / (r * 0.85);
    const dz = (p.z - c.z) / r;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > 4) return out;
    // 口角の手前で止める（口角まで押すと、口の端が押し出されてくぼむ）
    const corner = face.mouthCorner[sideName];
    const nearMouth = Math.hypot(p.x - corner.x, p.y - corner.y) / (face.width * 0.12);
    const fall = Math.exp(-2.2 * d2) * lid * THREE.MathUtils.smoothstep(nearMouth, 0.4, 1);
    // 押し出す向き：法線と、横（外）と前の間
    out.set(sign * 0.6, 0, 0.5).normalize().multiplyScalar(0.5).addScaledVector(n, 0.5).normalize();
    return out.multiplyScalar(face.width * PUFF.depth * fall);
  }

  const c = face.pinchCenter[sideName];
  const r = face.width * PINCH.radius;
  const d2 = p.distanceToSquared(c) / (r * r);
  if (d2 > 6) return out;
  // つまんだ点はとがって、周りはなだらかに引かれる
  const fall = (0.75 * Math.exp(-6 * d2) + 0.25 * Math.exp(-1.2 * d2)) * lid;
  out.set(sign * 0.85, -0.05, 0.5).normalize();
  return out.multiplyScalar(face.width * PINCH.pull * fall);
}

/**
 * 顔のメッシュに頬の形状キーを足し、表情（puku・cheekPinch・cheekPinchLeft・cheekPinchRight）として登録する。
 * 表情を読み込み時の姿勢（モーションを当てる前）で作るので、ほかの形を測る処理と同じく読み込み直後に呼ぶ
 */
export function registerCheekShapes(vrm: VRM): CheekPinchPoints | null {
  const manager = vrm.expressionManager;
  const meshes = faceMeshes(vrm);
  if (!manager || meshes.length === 0) return null;
  vrm.scene.updateMatrixWorld(true);
  const face = measureFace(vrm, meshes);
  if (!face) return null;

  // 部品が同じ頂点の置き場を共有していれば、作った形状キーも共有する
  const groups = new Map<THREE.BufferAttribute | THREE.InterleavedBufferAttribute, THREE.Mesh[]>();
  for (const mesh of meshes) {
    const positions = mesh.geometry.attributes.position;
    groups.set(positions, [...(groups.get(positions) ?? []), mesh]);
  }
  const made = new Map<THREE.BufferAttribute | THREE.InterleavedBufferAttribute, { position: THREE.BufferAttribute; normal: THREE.BufferAttribute }[]>();
  for (const [positions, group] of groups) made.set(positions, buildTargets(group, face));
  const patched = new Set<THREE.BufferGeometry>();
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const targets = made.get(geometry.attributes.position)!;
    const morphs = (geometry.morphAttributes.position ??= []);
    if (!patched.has(geometry)) {
      patched.add(geometry);
      // 法線の形状キーがないモデルは、元の形状キーの分を 0 で作る（足した形状キーの法線だけを効かせる）
      if (!geometry.morphAttributes.normal) {
        const zero = new THREE.BufferAttribute(new Float32Array(geometry.attributes.position.count * 3), 3);
        geometry.morphAttributes.normal = morphs.map(() => zero);
      }
      morphs.push(...targets.map((t) => t.position));
      geometry.morphAttributes.normal.push(...targets.map((t) => t.normal));
    }
    const base = morphs.length - SHAPES.length;
    const dictionary = mesh.morphTargetDictionary!;
    SHAPES.forEach((name, i) => (dictionary[name] = base + i));
    mesh.morphTargetInfluences!.push(...SHAPES.map(() => 0));
  }

  for (const [name, keys] of Object.entries(CHEEK_EXPRESSIONS)) {
    if (manager.getExpression(name)) continue;
    const expression = new VRMExpression(name);
    for (const { shapeKey, weight } of keys) {
      const primitives = meshes.filter((m) => m.morphTargetDictionary![shapeKey] !== undefined);
      if (primitives.length === 0) continue;
      expression.addBind(new VRMExpressionMorphTargetBind({ primitives, index: primitives[0].morphTargetDictionary![shapeKey], weight }));
    }
    vrm.scene.add(expression);
    manager.registerExpression(expression);
  }
  const pinch = (side: 'L' | 'R') => {
    const point = face.pinchCenter[side];
    return { point: point.clone(), pull: displacement(side === 'L' ? 'Cheek_Pinch_L' : 'Cheek_Pinch_R', point, new THREE.Vector3(0, 0, 1), face, new THREE.Vector3()) };
  };
  return { left: pinch('L'), right: pinch('R') };
}

function buildTargets(group: THREE.Mesh[], face: FaceFrame): { position: THREE.BufferAttribute; normal: THREE.BufferAttribute }[] {
  const mesh = group[0];
  const geometry = mesh.geometry;
  // 法線は、置き場を共有する部品すべての三角形で計算する
  const triangles: number[] = [];
  for (const part of group) {
    const index = part.geometry.index;
    if (index) for (let i = 0; i < index.count; i++) triangles.push(index.getX(i));
  }
  const count = geometry.attributes.position.count;
  const normals = geometry.attributes.normal as THREE.BufferAttribute | undefined;
  const toLocal = new THREE.Matrix3().setFromMatrix4(mesh.matrixWorld).invert();
  const normalToWorld = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const moved = new THREE.Vector3();

  return SHAPES.map((shape) => {
    const delta = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      worldPosition(mesh, i, _p);
      if (normals) _n.fromBufferAttribute(normals, i).applyMatrix3(normalToWorld).normalize();
      else _n.set(0, 0, 1);
      displacement(shape, _p, _n, face, moved).applyMatrix3(toLocal);
      delta[i * 3] = moved.x;
      delta[i * 3 + 1] = moved.y;
      delta[i * 3 + 2] = moved.z;
    }
    const position = new THREE.BufferAttribute(delta, 3);
    position.name = shape;
    return { position, normal: normalDelta(geometry, triangles, delta, shape) };
  });
}

/** 動かした形の法線と元の形の法線の差（同じ計算どうしの差を、元の法線に足す） */
function normalDelta(geometry: THREE.BufferGeometry, triangles: number[], delta: Float32Array, name: string): THREE.BufferAttribute {
  const source = geometry.attributes.position;
  const count = source.count;
  const before = new THREE.BufferGeometry();
  const after = new THREE.BufferGeometry();
  const a = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    a[i * 3] = source.getX(i);
    a[i * 3 + 1] = source.getY(i);
    a[i * 3 + 2] = source.getZ(i);
  }
  const b = a.map((v, i) => v + delta[i]);
  before.setAttribute('position', new THREE.BufferAttribute(a, 3));
  after.setAttribute('position', new THREE.BufferAttribute(b, 3));
  if (triangles.length > 0) {
    before.setIndex(triangles);
    after.setIndex(triangles);
  }
  before.computeVertexNormals();
  after.computeVertexNormals();
  const n0 = before.attributes.normal.array;
  const n1 = after.attributes.normal.array;
  const out = new Float32Array(count * 3);
  for (let i = 0; i < out.length; i++) out[i] = n1[i] - n0[i];
  const attribute = new THREE.BufferAttribute(out, 3);
  attribute.name = name;
  return attribute;
}
