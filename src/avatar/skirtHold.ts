import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { measureHand, skinPart, type HandSegment } from './handShape';
import { reach } from './handClearance';

/**
 * 風で裾がめくれたら、手で押さえる。
 *
 * 人は裾が浮いたのを感じてから手を出す（風の予報で先回りはしない）。布の裾の持ち上がり（SkinnedCloth.hemLift）が
 * LIFT_ON を超えたら気づき、反応の遅れ（REACTION、視覚・触覚の単純反応時間 0.2 秒前後）の後、手を裾へ下ろす。
 * 手の移動は最小躍度の軌道（Flash & Hogan 1985：人の腕の到達運動の速さの形）で REACH_TIME かけて寄せる。
 * 手を離すかは風だけで決める（押さえた手は触れた布を留めるので、裾の浮きは手を離すまで残る）。風が弱まって RELEASE_AFTER 秒
 * たったら戻す。
 *
 * 押さえる所は、裾の前と後ろのうち大きく上がった側（両手で）。前と後ろに片手ずつ分けると、長い裾では手より下の裾が
 * 前の手の上へ翻って手が隠れた。手のひらは裾のすぐ上（腕が届かない長い裾は、届くいちばん低い所）に、指を下へ向けて
 * 当てる。置く所はスカートの作った時の表面（setSkirt）から決め、布と体の隙間の分だけ押し込む。手は今の布（風で
 * 膨らんでいる）の外側に着けてから撫で下ろす。布は手をよけ、手のひらに触れた所は手と一緒に動く（cloth/solver.ts の
 * setCapsules）ので、浮いた裾は手で引き下ろされて体へ寄せられる。
 * 腕は2ボーン IK（handClearance.ts の reach）。押さえている間は、上体を少し前へ（後ろを押さえるときは少し起こす）傾け、
 * 顔を裾へ向ける。
 *
 * モーションの姿勢（正規化ボーン）に重みで混ぜる。モーションを当てた後、手が肌に入るのを止める処理
 * （handClearance.apply）の前に呼ぶ。
 */

/**
 * 押さえる芝居の設定。どれもモデルによらない量（m・秒・m/s・ラジアン）。既定値は人の反応の研究値（reaction・reachTime）
 * と、試し場（studio/src/playground）で絵を見て決めた値。作品ごとに変えてよい
 */
export interface SkirtHoldOptions {
  /** 裾がこれだけ上がったら気づく（m） */
  liftOn: number;
  /** 風がこれより弱いときの裾の動きには反応しない（m/s。そよ風 2m/s、強風 10m/s） */
  minWind: number;
  /** 気づいてから手が動き出すまで（秒）と、そのばらつき（±秒） */
  reaction: number;
  reactionJitter: number;
  /** 手を裾まで運ぶ時間（秒）、戻す時間（秒）、押さえている最低の時間（秒） */
  reachTime: number;
  returnTime: number;
  minHold: number;
  /** 風が押さえている間の最大のこの割合より弱まり、それが releaseAfter 秒続いたら離す */
  releaseWind: number;
  releaseAfter: number;
  /** 手のひらを、スカートの作った時の表面からどれだけ体へ押し込むか（m、最大。布と体の隙間までに抑える） */
  press: number;
  /** 手を体の正面（真後ろ）から、その手の側へ振る量（向きの横の成分）。右手は右の前を押さえる */
  sideways: number;
  /** 手のひらの中ほどを裾からどれだけ上に置くか（m）。指は裾の下へ伸びる */
  palmAboveHem: number;
  /** 手を寄せる弧のふくらみ（体の外へ、m） */
  arcOut: number;
  /** 押さえる所のどれだけ上に手を着けて撫で下ろすか（m）と、着けるまでに使う時間の割合 */
  stroke: number;
  landAt: number;
  /** 腕の長さのどこまで伸ばすか */
  reach: number;
  /** 後ろを押さえるのは、後ろの裾の浮きが前のこの倍を超えたときだけ（同じくらいなら、目に入る前を押さえる） */
  backOver: number;
  /** 押さえている間の上体の傾き（ラジアン。前を押さえるとき・後ろを押さえるとき）と、顔を下へ向ける角度 */
  leanFront: number;
  leanBack: number;
  headDown: number;
}

export const SKIRT_HOLD_DEFAULTS: SkirtHoldOptions = {
  liftOn: 0.035, minWind: 4,
  // 単純反応時間 0.2 秒前後
  reaction: 0.2, reactionJitter: 0.08,
  reachTime: 0.34, returnTime: 0.55, minHold: 0.8,
  releaseWind: 0.55, releaseAfter: 0.6,
  press: 0.025, sideways: 0.45, palmAboveHem: 0.03,
  arcOut: 0.08, stroke: 0.08, landAt: 0.6, reach: 0.97, backOver: 1.5,
  leanFront: 0.1, leanBack: -0.04, headDown: 0.22,
};

type Side = 'front' | 'back';
type Phase = 'free' | 'noticed' | 'reaching' | 'holding' | 'returning';

interface Arm {
  side: 'left' | 'right';
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  hand: THREE.Object3D;
  thigh: THREE.Object3D;
  knee: THREE.Object3D;
  /** 手のひらの厚みの半分（m） */
  palmRadius: number;
  /** 手首から手のひらの中ほどまで（m） */
  palmHalf: number;
  /** 手首から中指の先まで（m） */
  handLength: number;
  /** 読み込み時の姿勢での、指の向き・手のひらの向き（正規化ボーンの根のローカル） */
  fingerRest: THREE.Vector3;
  palmRest: THREE.Vector3;
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _left = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** 最小躍度の軌道の進み（0〜1） */
const minimumJerk = (t: number) => {
  const s = THREE.MathUtils.clamp(t, 0, 1);
  return s * s * s * (10 - 15 * s + 6 * s * s);
};

export class SkirtHold {
  private o: SkirtHoldOptions = { ...SKIRT_HOLD_DEFAULTS };
  /** 布の余白（m）：布が体から離れて止まる距離と、手の外に残る距離（setSkirt で布から受け取る） */
  private margins = { clothMargin: 0.01, handMargin: 0.003 };
  private phase: Phase = 'free';
  private time = 0;
  /** 今の段階に入った時刻 */
  private since = 0;
  /** 段階に入ったときの重み（戻し始め・押さえ直しを途中から始める） */
  private from = 0;
  private weight = 0;
  private sides: Record<'left' | 'right', Side> = { left: 'front', right: 'front' };
  private holdWind = 0;
  /** 気づいてからの裾の浮きの最大（前・後ろ） */
  private seen = { front: 0, back: 0 };
  private calmSince = -1;
  private reaction = this.o.reaction;
  private enabled = false;
  /** スカートの作った時の形（腰の正規化ボーンのローカル座標、x y z の並び）と、その裾の高さ */
  private skirt: Float32Array | null = null;
  private hemLocal = 0;
  /** 今の布の点（ワールド。setSkirt の live）と、それを腰のローカルにしたもの（毎フレーム） */
  private live: ArrayLike<number> | null = null;
  private liveLocal = new Float32Array(0);
  /** 点ごとの、作った時の形での体との隙間（m） */
  private gaps: Float32Array | null = null;
  private readonly hipsInverse = new THREE.Matrix4();
  private readonly saved = new Map<THREE.Object3D, THREE.Quaternion>();

  private constructor(
    private readonly vrm: VRM,
    private readonly arms: Arm[],
    private readonly spine: THREE.Object3D | null,
    private readonly chest: THREE.Object3D | null,
    private readonly head: THREE.Object3D | null
  ) {}

  /** 読み込み直後（モーションを当てる前の姿勢）に呼ぶ */
  static create(vrm: VRM): SkirtHold | null {
    const humanoid = vrm.humanoid;
    if (!humanoid) return null;
    vrm.scene.updateMatrixWorld(true);
    const skin = skinPart(vrm);
    const root = humanoid.normalizedHumanBonesRoot;
    root.updateWorldMatrix(true, true);
    const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const arms: Arm[] = [];
    for (const side of ['left', 'right'] as const) {
      const bone = (name: string) => humanoid.getNormalizedBoneNode(`${side}${name}` as VRMHumanBoneName);
      const upper = bone('UpperArm'), lower = bone('LowerArm'), hand = bone('Hand'), thigh = bone('UpperLeg'), knee = bone('LowerLeg');
      const segments = measureHand(vrm, side, skin);
      if (!upper || !lower || !hand || !thigh || !knee || !segments) return null;
      const palms = segments.filter((s: HandSegment) => s.kind === 'palm');
      const wrist = hand.getWorldPosition(new THREE.Vector3());
      const knuckles = palms.map((s) => s.end);
      const middle = knuckles.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / Math.max(1, knuckles.length));
      const finger = middle.clone().sub(wrist);
      const palmHalf = finger.length() / 2;
      finger.normalize();
      // 手のひらの向き：指の向きと、親指のある側から。右手は (指 × 親指側) の逆、左手はそのまま（どちらも手のひらの側）。
      // 読み込み時の手の向き（T ポーズで手のひらが下か前か）によらない
      const thumb = segments.find((s) => s.kind === 'finger' && String(s.bone).includes('Thumb'));
      const thumbSide = (thumb ? thumb.end.clone() : middle.clone()).sub(wrist);
      thumbSide.addScaledVector(finger, -thumbSide.dot(finger));
      const palm = thumbSide.lengthSq() > 1e-8
        ? new THREE.Vector3().crossVectors(finger, thumbSide.normalize()).multiplyScalar(side === 'left' ? 1 : -1)
        : new THREE.Vector3(0, -1, 0);
      const fingerRest = finger.clone().transformDirection(rootInverse);
      const palmRest = palm.transformDirection(rootInverse);
      palmRest.addScaledVector(fingerRest, -palmRest.dot(fingerRest)).normalize();
      arms.push({
        side, upper, lower, hand, thigh, knee,
        palmRadius: palms[0]?.radius ?? 0.015,
        palmHalf,
        handLength: Math.max(palmHalf * 3.2, ...segments.filter((s) => s.kind === 'finger' && String(s.bone).includes('Middle')).map((s) => s.end.distanceTo(wrist))),
        fingerRest, palmRest,
      });
    }
    const n = (name: VRMHumanBoneName) => humanoid.getNormalizedBoneNode(name);
    return new SkirtHold(vrm, arms, n('spine'), n('chest') ?? n('upperChest'), n('head'));
  }

  /** 設定を変える（書いた項目だけ） */
  setOptions(options: Partial<SkirtHoldOptions>): void {
    this.o = { ...this.o, ...options };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) { this.phase = 'free'; this.weight = 0; }
  }

  get holding(): number { return this.weight; }
  get state(): { phase: Phase; weight: number; sides: Record<'left' | 'right', Side> } {
    return { phase: this.phase, weight: this.weight, sides: { ...this.sides } };
  }

  /** モーションを当てる前に呼ぶ。前のフレームで変えた骨を戻す */
  restore(): void {
    for (const [bone, quaternion] of this.saved) bone.quaternion.copy(quaternion);
    this.saved.clear();
  }

  /**
   * 時間を進めて、押さえるかを決める。lift は裾の持ち上がり（前・後ろ、m。布がなければ null）、
   * windSpeed は体に当たる風の速さ（m/s）
   */
  update(delta: number, lift: { front: number; back: number } | null, windSpeed: number): void {
    this.time += delta;
    if (!this.enabled || !lift) {
      if (this.phase !== 'free' && this.phase !== 'returning') this.enter('returning');
      this.advanceWeight();
      return;
    }
    const lifted = Math.max(lift.front, lift.back);
    const t = this.time - this.since;
    switch (this.phase) {
      case 'free':
        // 風でめくれたときだけ（読み込み直後に布が落ち着く間や、回って裾が広がったときは押さえない）
        if (lifted > this.o.liftOn && windSpeed > this.o.minWind) {
          this.reaction = this.o.reaction + (Math.random() * 2 - 1) * this.o.reactionJitter;
          this.seen = { front: lift.front, back: lift.back };
          this.enter('noticed');
        }
        break;
      case 'noticed':
        // 押さえる側は、気づいてから手を出すまでに大きく上がったほう（手を出す瞬間の浮きだけで決めると、前と後ろが
        // 近いときに選び方がぶれ、前が大きくめくれているのに後ろを押さえた）
        this.seen.front = Math.max(this.seen.front, lift.front);
        this.seen.back = Math.max(this.seen.back, lift.back);
        if (t >= this.reaction) {
          this.chooseSides(this.seen);
          this.holdWind = windSpeed;
          this.calmSince = -1;
          this.enter('reaching');
        }
        break;
      case 'reaching':
        if (t >= this.o.reachTime) this.enter('holding');
        break;
      case 'holding': {
        this.holdWind = Math.max(this.holdWind, windSpeed);
        // 離すかは風だけで決める（押さえている手が布を留めているので、裾の浮きは手を離すまで下がらない）
        const calm = windSpeed < this.holdWind * this.o.releaseWind;
        if (!calm) this.calmSince = -1;
        else if (this.calmSince < 0) this.calmSince = this.time;
        if (t >= this.o.minHold && calm && this.time - this.calmSince >= this.o.releaseAfter) this.enter('returning');
        break;
      }
      case 'returning':
        // 戻している途中でまためくれたら、すぐ押さえ直す（もう気づいているので反応の遅れは短い）
        if (lifted > this.o.liftOn && windSpeed > this.o.minWind) {
          this.chooseSides(lift);
          this.holdWind = windSpeed;
          this.enter('reaching');
        } else if (t >= this.o.returnTime) this.enter('free');
        break;
    }
    this.advanceWeight();
  }

  private enter(phase: Phase): void {
    this.from = this.weight;
    this.phase = phase;
    this.since = this.time;
  }

  private advanceWeight(): void {
    const t = this.time - this.since;
    if (this.phase === 'reaching') this.weight = this.from + (1 - this.from) * minimumJerk(t / (this.o.reachTime * Math.max(0.3, 1 - this.from)));
    else if (this.phase === 'holding') this.weight = 1;
    else if (this.phase === 'returning') this.weight = this.from * (1 - minimumJerk(t / this.o.returnTime));
    else if (this.phase === 'free') this.weight = 0;
  }

  private chooseSides(lift: { front: number; back: number }): void {
    if (lift.back > lift.front * this.o.backOver) this.sides = { right: 'back', left: 'back' };
    else this.sides = { right: 'front', left: 'front' };
  }

  /** モーション・顔の向きを当てた後、handClearance.apply の前に呼ぶ */
  apply(): void {
    const w = this.weight;
    if (w <= 1e-4 || !this.skirt) return;
    const root = this.vrm.humanoid.normalizedHumanBonesRoot;
    root.updateWorldMatrix(true, true);
    // 体の前（太ももの付け根の左右と、上から）
    const left = this.arms.find((a) => a.side === 'left')!, right = this.arms.find((a) => a.side === 'right')!;
    left.thigh.getWorldPosition(_a); right.thigh.getWorldPosition(_b);
    _left.subVectors(_a, _b); _left.y = 0; _left.normalize();
    _forward.crossVectors(_left, _up).normalize();
    const backs = Object.values(this.sides).filter((s) => s === 'back').length;

    // 上体：前を押さえるなら少し前かがみに、後ろなら少し起こす。顔は裾へ
    const lean = (backs ? this.o.leanBack : this.o.leanFront) * w;
    const axis = _left.clone();   // 体の左向きの軸まわりに正に回すと前へ倒れる
    this.turn(this.spine, axis, lean * 0.6);
    this.turn(this.chest, axis, lean * 0.4);
    this.turn(this.head, axis, this.o.headDown * w * (backs ? 0.4 : 1));
    root.updateWorldMatrix(true, true);

    const hips = this.vrm.humanoid.getNormalizedBoneNode('hips')!;
    this.hipsInverse.copy(hips.matrixWorld).invert();
    if (this.live) {
      const L = this.live, out = this.liveLocal;
      for (let i = 0; i < out.length; i += 3) {
        _v.set(L[i], L[i + 1], L[i + 2]).applyMatrix4(this.hipsInverse);
        out[i] = _v.x; out[i + 1] = _v.y; out[i + 2] = _v.z;
      }
    }
    for (const arm of this.arms) {
      const side = this.sides[arm.side];
      const facing = side === 'front' ? 1 : -1;
      // 腿の外側→内側の向き（体の中心へ）
      const inward = _left.clone().multiplyScalar(arm.side === 'left' ? -1 : 1);
      const out = new THREE.Vector3().copy(_forward).multiplyScalar(facing);
      // 指は下へ、少し体の中心へ
      const finger = new THREE.Vector3(0, -1, 0).addScaledVector(inward, 0.15).normalize();
      // 手のひらの中ほどを置く所（腰のローカル）：裾のすぐ上の高さで、スカートの作った時の表面から、手のひらの厚みだけ外へ
      // 出して押し込んだ所。手のひらで裾を押さえ、指は裾の下の太ももに沿う（人が押さえるときの手。腕はほぼ伸びて、前腕が
      // 腰から離れる。指先を裾の上に収めようとすると手首が腰の高さまで上がり、曲げた前腕が腰の横でスカートに食い込んだ）
      const outLocal = out.clone().addScaledVector(inward, -this.o.sideways).transformDirection(this.hipsInverse).setY(0).normalize();
      // 腕が届かない長い裾は、届くいちばん低い所を押さえる（裾から上へ 1cm ずつ探す）
      const shoulder = arm.upper.getWorldPosition(new THREE.Vector3());
      const armLength = shoulder.distanceTo(arm.lower.getWorldPosition(_v)) + _v.distanceTo(arm.hand.getWorldPosition(_b));
      const centre = new THREE.Vector3(), gap = { value: 0 }, palmAt = new THREE.Vector3(), goal = new THREE.Vector3();
      let palmY = this.hemLocal + this.o.palmAboveHem;
      for (; ; palmY += 0.01) {
        const radius = this.skirtSurface(palmY, outLocal, centre, gap);
        // 押し込むのは、布と体の間に空いている分まで（布は体から clothMargin 離れたところで止まる）
        const press = THREE.MathUtils.clamp(gap.value - this.margins.clothMargin, 0, this.o.press);
        palmAt.copy(centre).addScaledVector(outLocal, radius + arm.palmRadius + this.margins.handMargin - press).applyMatrix4(hips.matrixWorld);
        goal.copy(palmAt).addScaledVector(finger, -arm.palmHalf);
        if (goal.distanceTo(shoulder) <= armLength * this.o.reach || palmY > 0) break;
      }

      for (const bone of [arm.upper, arm.lower, arm.hand]) if (!this.saved.has(bone)) this.saved.set(bone, bone.quaternion.clone());
      // モーションの手首から、体の外側へふくらむ弧で、押さえる所の少し上（landing）へ手を着け、そこから撫で下ろす。
      // 手のひらに触れた布は手と一緒に動くので、浮いた裾も手で引き下ろされる（上から当てずに横から当てると、浮いたまま止まる）
      const start = arm.hand.getWorldPosition(new THREE.Vector3());
      const startQ = arm.hand.getWorldQuaternion(new THREE.Quaternion());
      // 手を着ける所は、今の布（風で膨らんでいる）の外側。そこから押さえる所へ撫で下ろしながら押し込む（作った時の形から
      // 着ける所を決めると、膨らんだ布の内側に手が着いて、布は手の外でめくれたままになった）
      const landing = goal.clone().addScaledVector(_up, this.o.stroke);
      if (this.live) {
        const landY = palmY + this.o.stroke, restCentre = new THREE.Vector3(), liveCentre = new THREE.Vector3(), none = { value: 0 };
        const restR = this.skirtSurface(landY, outLocal, restCentre, none);
        const liveR = this.skirtSurface(landY, outLocal, liveCentre, none, this.liveLocal);
        if (liveR > restR) {
          landing.copy(liveCentre).addScaledVector(outLocal, liveR + arm.palmRadius + this.margins.handMargin).applyMatrix4(hips.matrixWorld)
            .addScaledVector(finger, -arm.palmHalf);
        }
      }
      const wrist = new THREE.Vector3();
      if (w < this.o.landAt) {
        const u = w / this.o.landAt;
        wrist.copy(start).lerp(landing, u).addScaledVector(out, this.o.arcOut * Math.sin(Math.PI * u));
      } else {
        wrist.copy(landing).lerp(goal, (w - this.o.landAt) / (1 - this.o.landAt));
      }
      reach(arm.upper, arm.lower, arm.hand, wrist);
      // 手の向き：指を下へ、手のひらを太ももへ
      const rootQ = root.getWorldQuaternion(_q);
      const fRest = _a.copy(arm.fingerRest).applyQuaternion(rootQ);
      const nRest = _b.copy(arm.palmRest).applyQuaternion(rootQ);
      const nWant = out.clone().negate().addScaledVector(finger, -out.clone().negate().dot(finger)).normalize();
      _m.makeBasis(fRest, nRest, new THREE.Vector3().crossVectors(fRest, nRest));
      _m2.makeBasis(finger, nWant, new THREE.Vector3().crossVectors(finger, nWant));
      const want = new THREE.Quaternion().setFromRotationMatrix(_m2.multiply(_m.transpose())).multiply(rootQ);
      startQ.slerp(want, w);
      arm.hand.quaternion.copy(arm.hand.parent!.getWorldQuaternion(_q2).invert().multiply(startQ));
      arm.upper.updateMatrixWorld(true);
    }
  }

  /**
   * スカートの作った時の形（布の点のワールド座標。モデルを読み込んだときの姿勢で）。手は、この表面に手のひらを当てる。
   * 読み込み時の姿勢のまま呼ぶこと（腰の骨から見た位置にして持つ）
   */
  setSkirt(points: ArrayLike<number>, gaps: ArrayLike<number>, count: number, live: ArrayLike<number> | null = null, margins: { cloth: number; hand: number } | null = null): void {
    this.live = live;
    if (margins) this.margins = { clothMargin: margins.cloth, handMargin: margins.hand };
    this.liveLocal = new Float32Array(count * 3);
    const hips = this.vrm.humanoid.getNormalizedBoneNode('hips');
    if (!hips) return;
    this.vrm.humanoid.normalizedHumanBonesRoot.updateWorldMatrix(true, true);
    const inverse = new THREE.Matrix4().copy(hips.matrixWorld).invert();
    const local = new Float32Array(count * 3);
    let low = Infinity;
    for (let i = 0; i < count; i++) {
      _v.set(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]).applyMatrix4(inverse);
      local[i * 3] = _v.x; local[i * 3 + 1] = _v.y; local[i * 3 + 2] = _v.z;
      low = Math.min(low, _v.y);
    }
    this.skirt = local;
    this.gaps = Float32Array.from({ length: count }, (_, i) => Math.min(1, gaps[i]));
    this.hemLocal = low;
  }

  /**
   * 腰のローカル座標で、高さ y の、水平の向き dir（長さ 1）にあるスカートの表面までの、その高さの中心からの距離と中心。
   * 高さの近い点のうち、その向きにいちばん出ている点で測る。gap にはその点と体の隙間を入れる
   */
  private skirtSurface(y: number, dir: THREE.Vector3, centre: THREE.Vector3, gap: { value: number }, s: Float32Array = this.skirt!): number {
    let cx = 0, cz = 0, cnt = 0;
    for (let band = 0.015; cnt < 8 && band < 0.2; band *= 2) {
      cx = 0; cz = 0; cnt = 0;
      for (let i = 0; i < s.length; i += 3) if (Math.abs(s[i + 1] - y) < band) { cx += s[i]; cz += s[i + 2]; cnt++; }
    }
    if (!cnt) return 0.15;
    cx /= cnt; cz /= cnt;
    centre.set(cx, y, cz);
    let best = 0;
    for (let band = 0.015; best === 0 && band < 0.2; band *= 2) {
      for (let i = 0; i < s.length; i += 3) {
        if (Math.abs(s[i + 1] - y) >= band) continue;
        const dx = s[i] - cx, dz = s[i + 2] - cz, along = dx * dir.x + dz * dir.z;
        // その向きの線の近く（横に 3cm 以内）の点だけ
        if (along > best && Math.abs(dx * dir.z - dz * dir.x) < 0.03) { best = along; gap.value = this.gaps?.[i / 3] ?? 0; }
      }
    }
    return best || 0.15;
  }

  /** 骨をワールドの軸まわりに回す（モーションの姿勢に足す） */
  private turn(bone: THREE.Object3D | null, axis: THREE.Vector3, angle: number): void {
    if (!bone || Math.abs(angle) < 1e-5) return;
    if (!this.saved.has(bone)) this.saved.set(bone, bone.quaternion.clone());
    const parent = bone.parent!.getWorldQuaternion(_q2);
    const local = axis.clone().applyQuaternion(parent.clone().invert());
    bone.quaternion.premultiply(_q.setFromAxisAngle(local, angle)).normalize();
    bone.updateMatrixWorld(true);
  }
}
