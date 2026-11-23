import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { PINCH_SHAPE_EXPRESSIONS, type CheekPinchPoints } from './cheekShapes';
import { forEachVertex, mainBone, skinPart } from './handShape';

/**
 * 自分の手で頬をつまんで引っぱる（「夢じゃない？」と頬をつねる芝居など）。
 *
 * 手は親指と人差し指の腹を合わせた形（残りの指は握る）にし、その指先の間を頬のつまむ所（cheekShapes.ts）へ運ぶ。
 * 指を合わせる形は、読み込み時の姿勢で人差し指を曲げてから、親指を CCD（関節を1つずつ指先の方へ回す IK）で
 * 人差し指の先へ寄せて決める（指の長さや向きがモデルごとに違っても合う）。
 * 腕は2ボーン IK で、肘は下・外へ向ける。指は頬の横から後ろ・内へ向け、手のひらを顔の中心の側へ向ける（親指が下、
 * 人差し指が上に来て、頬を上下からはさむ）。
 * 手が着いてから頬を引く（形状キー Cheek_Pinch_*）。指先の間は、引いた頬と一緒に外へ動く。
 * 手の動きは最小躍度の軌道（skirtHold.ts と同じ、人の腕の到達運動の速さの形）。
 *
 * モーションの姿勢（正規化ボーン）に重みで混ぜる。モーションを当てた後、手が肌に入るのを止める処理の後に呼ぶ
 * （つまむ指は頬に触れているので、肌から外へ押し出させない）。
 */

export type CheekPinchSide = 'left' | 'right' | 'both';

/** 手を頬へ運ぶ時間・戻す時間（秒）。手を口元へ運ぶ動作の移送は 1 秒前後（飲む・食べる動作の計測）。頬は口より近いので少し短く */
const REACH_TIME = 0.7;
const RETURN_TIME = 0.6;
/** 指をつまむ形にするのは、手を運ぶ途中のこの割合から（手が顔に近づいてから指を合わせる） */
const FINGER_FROM = 0.45;
/** 手首の向きを合わせ始める割合 */
const HAND_FROM = 0.3;
/** 手首のひねりのうち前腕へ移す割合 */
const TWIST_TO_FOREARM = 1;
/** 頬をつまむときの指の向き（上・後ろ・内の割合） */
const FINGER_UP = 0.75;
const FINGER_BACK = 0.35;
const FINGER_IN = 0.15;
/** 手首を運ぶ経由点：頬に着く位置から下・前・内へずらす量（m） */
const VIA_BELOW = 0.12;
const VIA_FORWARD = 0.1;
const VIA_IN = 0.03;
/** 頬に着いたときの肘の向き（下を 1 とした前・外の割合） */
const ELBOW_FORWARD = 1.2;
const ELBOW_OUT = 0.1;
/** 指が頬に着いてから引ききるまでの時間と、離して頬が戻るまでの時間（秒） */
const PULL_TIME = 0.35;
const RELEASE_TIME = 0.15;
/** 人差し指の曲げ（付け根・中・先、度）と、握る指の曲げ */
const INDEX_CURL = [30, 45, 25];
const FIST_CURL = [75, 95, 60];
/** 親指を寄せる CCD の回数と、指先の間に残す隙間（つまんだ皮膚の厚み、m） */
const CCD_ITERATIONS = 24;
const PINCH_GAP = 0.004;

const FINGERS = ['Index', 'Middle', 'Ring', 'Little'] as const;
const JOINTS = ['Proximal', 'Intermediate', 'Distal'] as const;
const THUMB = ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal'] as const;

interface Hand {
  side: 'left' | 'right';
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  hand: THREE.Object3D;
  /** つまむ形の指の回転（正規化ボーンのローカル） */
  fingers: { bone: THREE.Object3D; pose: THREE.Quaternion }[];
  /** つまむ形のときの指先の間（手の骨のローカル） */
  pinchLocal: THREE.Vector3;
  /** 読み込み時の姿勢での指の向き・手のひらの向き（正規化ボーンの根のローカル） */
  fingerRest: THREE.Vector3;
  palmRest: THREE.Vector3;
  /** つまむ所と引く量（頭の骨のローカル） */
  pointLocal: THREE.Vector3;
  pullLocal: THREE.Vector3;
  /**
   * 手の重み（0 = モーションのまま、1 = 頬に着いている）と頬を引く量（0〜1）。つまむときは手が着いてから引き、
   * 離すときは頬を放してから手を戻す。from は切り替えたときの値、since はその時刻
   */
  reach: number;
  pull: number;
  fromReach: number;
  fromPull: number;
  target: number;
  since: number;
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

const minimumJerk = (t: number) => {
  const s = THREE.MathUtils.clamp(t, 0, 1);
  return s * s * s * (10 - 15 * s + 6 * s * s);
};

export class CheekPinch {
  private time = 0;
  /** 頬を引いている量（両手のうち大きい方。0〜1） */
  pull = 0;
  private readonly saved = new Map<THREE.Object3D, THREE.Quaternion>();

  private constructor(
    private readonly vrm: VRM,
    private readonly hands: Hand[],
    private readonly head: THREE.Object3D,
    /** 体の左・上・前（正規化ボーンの根のローカル。読み込み時の姿勢でモデルは +Z を向き、左が +X） */
    private readonly frame: { left: THREE.Vector3; up: THREE.Vector3; forward: THREE.Vector3 }
  ) {}

  /** 読み込み直後（モーションを当てる前の姿勢）に呼ぶ。points は registerCheekShapes の返り値 */
  static create(vrm: VRM, points: CheekPinchPoints | null): CheekPinch | null {
    const humanoid = vrm.humanoid;
    if (!humanoid || !points) return null;
    const bone = (name: string) => humanoid.getNormalizedBoneNode(name as VRMHumanBoneName);
    const head = bone('head');
    if (!head) return null;
    const root = humanoid.normalizedHumanBonesRoot;
    root.updateWorldMatrix(true, true);
    const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const headInverse = new THREE.Matrix4().copy(head.matrixWorld).invert();
    const headRotation = head.getWorldQuaternion(new THREE.Quaternion()).invert();

    // 指先は手の肌の頂点で測る（骨の先から推すと、指の太さ・爪の分だけ頬から浮く）
    const skin = skinPart(vrm);
    if (!skin) return null;
    const sync = () => {
      humanoid.update();
      vrm.scene.updateMatrixWorld(true);
    };
    sync();
    /** 骨で動く頂点のうち、指の先の向きにいちばん出ている頂点 */
    const tipVertex = (rawName: string, rawParentName: string): number => {
      const raw = humanoid.getRawBoneNode(rawName as VRMHumanBoneName);
      const parent = humanoid.getRawBoneNode(rawParentName as VRMHumanBoneName);
      if (!raw || !parent) return -1;
      const base = raw.getWorldPosition(new THREE.Vector3());
      const along = base.clone().sub(parent.getWorldPosition(new THREE.Vector3())).normalize();
      let best = -1, far = -Infinity;
      forEachVertex(vrm, (mesh, vertex) => {
        if (mainBone(mesh, vertex) !== raw) return;
        const d = mesh.getVertexPosition(vertex, _a).applyMatrix4(mesh.matrixWorld).sub(base).dot(along);
        if (d > far) { far = d; best = vertex; }
      }, (mesh) => mesh === skin);
      return best;
    };
    const vertexWorld = (vertex: number, out: THREE.Vector3) => skin.getVertexPosition(vertex, out).applyMatrix4(skin.matrixWorld);

    const hands: Hand[] = [];
    for (const side of ['left', 'right'] as const) {
      const b = (name: string) => bone(`${side}${name}`);
      const upper = b('UpperArm'), lower = b('LowerArm'), hand = b('Hand');
      const index = JOINTS.map((j) => b(`Index${j}`));
      const thumb = THUMB.map((j) => b(j));
      if (!upper || !lower || !hand || index.some((x) => !x) || thumb.some((x) => !x)) return null;
      const indexTipVertex = tipVertex(`${side}IndexDistal`, `${side}IndexIntermediate`);
      const thumbTipVertex = tipVertex(`${side}ThumbDistal`, `${side}ThumbProximal`);
      if (indexTipVertex < 0 || thumbTipVertex < 0) return null;

      const saved = new Map<THREE.Object3D, THREE.Quaternion>();
      const keep = (o: THREE.Object3D) => { if (!saved.has(o)) saved.set(o, o.quaternion.clone()); };
      // 指を曲げる軸：読み込み時の姿勢で、手のひらの向き × 指の向き（指を手のひらの側へ回す）
      const wrist = hand.getWorldPosition(new THREE.Vector3());
      const knuckle = index[0]!.getWorldPosition(new THREE.Vector3());
      const finger = knuckle.clone().sub(wrist).normalize();
      const thumbBase = thumb[0]!.getWorldPosition(new THREE.Vector3()).sub(wrist);
      thumbBase.addScaledVector(finger, -thumbBase.dot(finger));
      // 手のひらの向き：右手は (指 × 親指側) の逆、左手はそのまま（skirtHold.ts と同じ）
      const palm = new THREE.Vector3().crossVectors(finger, thumbBase.normalize()).multiplyScalar(side === 'left' ? 1 : -1).normalize();
      const curlAxis = new THREE.Vector3().crossVectors(finger, palm).normalize();
      const curl = (o: THREE.Object3D, degrees: number) => {
        keep(o);
        const parent = o.parent!.getWorldQuaternion(_q2);
        const local = curlAxis.clone().applyQuaternion(parent.clone().invert());
        o.quaternion.premultiply(_q.setFromAxisAngle(local, THREE.MathUtils.degToRad(degrees))).normalize();
        o.updateMatrixWorld(true);
      };
      for (const name of FINGERS) {
        const curls = name === 'Index' ? INDEX_CURL : FIST_CURL;
        JOINTS.forEach((j, i) => {
          const o = b(`${name}${j}`);
          if (o) curl(o, curls[i]);
        });
      }
      // 親指の先を、人差し指の先（手のひらの側へ少し寄せた所）へ寄せる
      sync();
      const goal = vertexWorld(indexTipVertex, new THREE.Vector3()).addScaledVector(palm, PINCH_GAP);
      for (let it = 0; it < CCD_ITERATIONS; it++) {
        for (let k = 1; k >= 0; k--) {
          const joint = thumb[k]!;
          keep(joint);
          sync();
          const tip = vertexWorld(thumbTipVertex, new THREE.Vector3());
          const origin = joint.getWorldPosition(new THREE.Vector3());
          const from = tip.sub(origin).normalize();
          const to = goal.clone().sub(origin).normalize();
          const parent = joint.parent!.getWorldQuaternion(_q2);
          const delta = parent.clone().invert().multiply(_q.setFromUnitVectors(from, to)).multiply(parent);
          joint.quaternion.premultiply(delta).normalize();
          joint.updateMatrixWorld(true);
        }
      }
      sync();
      const between = vertexWorld(thumbTipVertex, new THREE.Vector3()).add(vertexWorld(indexTipVertex, new THREE.Vector3())).multiplyScalar(0.5);
      const pinchLocal = between.applyMatrix4(new THREE.Matrix4().copy(hand.matrixWorld).invert());
      const fingers = [...saved.keys()].map((o) => ({ bone: o, pose: o.quaternion.clone() }));
      for (const [o, q] of saved) o.quaternion.copy(q);
      sync();

      const fingerRest = finger.clone().transformDirection(rootInverse);
      const palmRest = palm.clone().transformDirection(rootInverse);
      palmRest.addScaledVector(fingerRest, -palmRest.dot(fingerRest)).normalize();
      const p = points[side];
      hands.push({
        side, upper, lower, hand, fingers, pinchLocal, fingerRest, palmRest,
        pointLocal: p.point.clone().applyMatrix4(headInverse),
        pullLocal: p.pull.clone().applyQuaternion(headRotation),
        reach: 0, pull: 0, fromReach: 0, fromPull: 0, target: 0, since: 0,
      });
    }
    const frame = {
      left: new THREE.Vector3(1, 0, 0).transformDirection(rootInverse),
      up: new THREE.Vector3(0, 1, 0).transformDirection(rootInverse),
      forward: new THREE.Vector3(0, 0, 1).transformDirection(rootInverse),
    };
    return new CheekPinch(vrm, hands, head, frame);
  }

  /** つまむ頬（false で手を戻す）。immediate なら運ぶ動きを飛ばす（カットの頭出しなど） */
  set(side: CheekPinchSide | false, immediate = false): void {
    for (const hand of this.hands) {
      const target = side === 'both' || side === hand.side ? 1 : 0;
      if (immediate) {
        hand.reach = hand.pull = hand.fromReach = hand.fromPull = hand.target = target;
        continue;
      }
      if (target === hand.target) continue;
      hand.fromReach = hand.reach;
      hand.fromPull = hand.pull;
      hand.target = target;
      hand.since = this.time;
    }
  }

  /** モーションを当てる前に呼ぶ。前のフレームで変えた骨を戻す */
  restore(): void {
    for (const [bone, quaternion] of this.saved) bone.quaternion.copy(quaternion);
    this.saved.clear();
  }

  /** 時間を進めて、手を頬へ運ぶ。頬を引く量は表情として当てる（表情の更新の後、vrm.update の前に呼ぶ） */
  apply(delta: number): void {
    this.time += delta;
    const root = this.vrm.humanoid.normalizedHumanBonesRoot;
    const manager = this.vrm.expressionManager;
    this.pull = 0;
    for (const hand of this.hands) {
      const t = this.time - hand.since;
      if (hand.target === 1) {
        // 手を運び（残りの距離の分だけの時間で）、着いてから頬を引く
        const reachTime = REACH_TIME * (1 - hand.fromReach);
        hand.reach = reachTime > 0 ? hand.fromReach + (1 - hand.fromReach) * minimumJerk(t / reachTime) : 1;
        hand.pull = hand.fromPull + (1 - hand.fromPull) * minimumJerk((t - reachTime) / PULL_TIME);
      } else {
        // 頬を放してから手を戻す
        const releaseTime = RELEASE_TIME * hand.fromPull;
        hand.pull = releaseTime > 0 ? hand.fromPull * (1 - minimumJerk(t / releaseTime)) : 0;
        hand.reach = hand.fromReach * (1 - minimumJerk((t - releaseTime) / RETURN_TIME));
      }
      const w = hand.reach;
      const pull = hand.pull;
      manager?.setValue(PINCH_SHAPE_EXPRESSIONS[hand.side], pull);
      this.pull = Math.max(this.pull, pull);
      if (w <= 1e-4) continue;

      root.updateWorldMatrix(true, true);
      // 指の形（手が顔に近づいてから合わせる）
      const fingerWeight = THREE.MathUtils.smoothstep(w, FINGER_FROM, 1);
      for (const { bone, pose } of hand.fingers) {
        this.keep(bone);
        bone.quaternion.slerp(pose, fingerWeight);
      }
      // 手の向き（正規化ボーンの根のローカルで決める）
      const rootQ = root.getWorldQuaternion(_q);
      const sign = hand.side === 'left' ? 1 : -1;
      const { left, up, forward } = this.frame;
      const outward = _a.copy(left).multiplyScalar(sign);
      // 指は前腕の延長で上・少し後ろ・内へ、手のひらは顔の方（内側）へ。手首をほぼまっすぐのまま、
      // 親指と人差し指で頬を前後からはさむ（手のひらを前へ向けると、手首を大きく反らせて指を後ろへ曲げる形になる）
      const finger = new THREE.Vector3().addScaledVector(up, FINGER_UP).addScaledVector(forward, -FINGER_BACK).addScaledVector(outward, -FINGER_IN).normalize();
      const palm = outward.clone().negate();
      palm.addScaledVector(finger, -palm.dot(finger)).normalize();
      _m.makeBasis(hand.fingerRest, hand.palmRest, _b.crossVectors(hand.fingerRest, hand.palmRest));
      _m2.makeBasis(finger, palm, _c.crossVectors(finger, palm));
      const want = new THREE.Quaternion().setFromRotationMatrix(_m2.multiply(_m.transpose()));
      const wantWorld = rootQ.clone().multiply(want);

      // 指先の間を、引いた頬の所へ
      this.head.updateWorldMatrix(true, false);
      const goal = hand.pointLocal.clone().addScaledVector(hand.pullLocal, pull).applyMatrix4(this.head.matrixWorld);
      const offset = hand.pinchLocal.clone().multiply(hand.hand.getWorldScale(_b)).applyQuaternion(wantWorld);
      const wristGoal = goal.clone().sub(offset);
      const arm = [hand.upper, hand.lower, hand.hand];
      arm.forEach((bone) => this.keep(bone));
      // 手首は「今の位置 → 胸の前・頬の少し下 → 頬」の曲線で運ぶ（体の前を上がり、頬へは下から寄せる）。
      // 直線で運ぶと前腕が胴に埋まり、関節の回転を混ぜると肩の回転の経路で手が顔より上へ行き過ぎる
      const start = hand.hand.getWorldPosition(new THREE.Vector3());
      // 経由点：頬に着く位置から下・前・内へずらした所（ずらす向きは体の根の向きで）
      const via = new THREE.Vector3()
        .addScaledVector(up, -VIA_BELOW)
        .addScaledVector(forward, VIA_FORWARD)
        .addScaledVector(outward, -VIA_IN)
        .applyQuaternion(rootQ)
        .add(wristGoal);
      const u = w;
      const wrist = start.clone().multiplyScalar((1 - u) * (1 - u)).addScaledVector(via, 2 * (1 - u) * u).addScaledVector(wristGoal, u * u);
      // 肘の向き：モーションの肘の向きから、頬に着いたときの向き（下・前）へ
      const shoulderPos = hand.upper.getWorldPosition(new THREE.Vector3());
      const elbowPos = hand.lower.getWorldPosition(new THREE.Vector3());
      const startBend = elbowPos.sub(shoulderPos).normalize();
      const endBend = new THREE.Vector3().addScaledVector(up, -1).addScaledVector(forward, ELBOW_FORWARD).addScaledVector(outward, ELBOW_OUT).applyQuaternion(rootQ).normalize();
      const pole = startBend.lerp(endBend, THREE.MathUtils.smoothstep(w, 0, 0.8)).normalize();
      const handFrom = hand.hand.getWorldQuaternion(new THREE.Quaternion());
      reachWithPole(hand.upper, hand.lower, hand.hand, wrist, pole);
      // 手首の向き：運ぶ途中はモーションの向きのまま（前腕に連れて動く）、顔に近づいてから頬をつまむ向きへ
      const handWorld = handFrom.slerp(wantWorld, THREE.MathUtils.smoothstep(w, HAND_FROM, 1));
      hand.hand.quaternion.copy(hand.hand.parent!.getWorldQuaternion(_q2).invert().multiply(handWorld));
      // 前腕の長さ方向まわりのひねり（回内・回外）は、手首ではなく前腕で受ける（手首の骨で受けると肌が絞られる）
      moveTwistToForearm(hand.lower, hand.hand, TWIST_TO_FOREARM);
      hand.upper.updateMatrixWorld(true);
    }
  }

  private keep(bone: THREE.Object3D): void {
    if (!this.saved.has(bone)) this.saved.set(bone, bone.quaternion.clone());
  }
}

/**
 * 手の骨のローカル回転のうち、前腕の長さ方向まわりのひねりを、fraction の割合だけ前腕の骨へ移す。
 * 前腕の骨を自分の長さ方向に回しても手首の位置は動かず、手の向き（ワールド）も変わらない
 */
function moveTwistToForearm(lower: THREE.Object3D, hand: THREE.Object3D, fraction: number): void {
  const axis = hand.position.clone().normalize();
  const q = hand.quaternion;
  const along = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  const twist = new THREE.Quaternion(axis.x * along, axis.y * along, axis.z * along, q.w);
  if (twist.lengthSq() < 1e-12) return;
  twist.normalize();
  const moved = new THREE.Quaternion().slerp(twist, fraction);
  lower.quaternion.multiply(moved);
  hand.quaternion.premultiply(moved.invert());
  lower.updateMatrixWorld(true);
}

/** 2ボーン IK（肘の向きを pole で決める） */
export function reachWithPole(upper: THREE.Object3D, lower: THREE.Object3D, hand: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3): void {
  const shoulder = upper.getWorldPosition(new THREE.Vector3());
  const elbow = lower.getWorldPosition(new THREE.Vector3());
  const wrist = hand.getWorldPosition(new THREE.Vector3());
  const upperLength = shoulder.distanceTo(elbow);
  const lowerLength = elbow.distanceTo(wrist);
  const toTarget = target.clone().sub(shoulder);
  const distance = THREE.MathUtils.clamp(toTarget.length(), Math.abs(upperLength - lowerLength) + 1e-4, upperLength + lowerLength - 1e-4);
  const aim = toTarget.normalize();
  const bend = pole.clone().addScaledVector(aim, -pole.dot(aim));
  if (bend.lengthSq() < 1e-10) bend.set(0, -1, 0).addScaledVector(aim, aim.y);
  bend.normalize();
  const along = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance);
  const height = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
  turnToward(upper, lower, shoulder.clone().addScaledVector(aim, along).addScaledVector(bend, height));
  turnToward(lower, hand, shoulder.addScaledVector(aim, distance));
}

function turnToward(joint: THREE.Object3D, child: THREE.Object3D, destination: THREE.Vector3): void {
  const origin = joint.getWorldPosition(new THREE.Vector3());
  const from = child.getWorldPosition(new THREE.Vector3()).sub(origin).normalize();
  const to = destination.clone().sub(origin).normalize();
  const parentWorld = joint.parent!.getWorldQuaternion(new THREE.Quaternion());
  const delta = parentWorld.clone().invert().multiply(new THREE.Quaternion().setFromUnitVectors(from, to)).multiply(parentWorld);
  joint.quaternion.premultiply(delta).normalize();
  joint.updateMatrixWorld(true);
}
