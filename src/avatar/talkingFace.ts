import * as THREE from 'three';
import { VRM, VRMExpression, VRMExpressionMorphTargetBind } from '@pixiv/three-vrm';
import type { SpeechTone } from '../schema/stage';

/** 話している間だけ動かす、眉・目のシェイプキー（VRoid）。ないモデルではその部分は動かさない */
const SHAPE_KEYS = {
  talkBrowUp: 'Fcl_BRW_Surprised',
  talkEyeWide: 'Fcl_EYE_Surprised',
  talkEyeSmile: 'Fcl_EYE_Joy',
  talkEyeDown: 'Fcl_EYE_Sorrow',
} as const;
type FaceShape = keyof typeof SHAPE_KEYS;
const VOWELS = new Set(['aa', 'ee', 'ih', 'oh', 'ou']);
const deg = THREE.MathUtils.degToRad;

/** 音が途切れてこれだけ経ったら文の区切り、さらに経ったら話し終えたとみなす（秒） */
const PHRASE_GAP = 0.3;
const REST_GAP = 1.5;
/** うなずきの間隔の下限（秒） */
const NOD_INTERVAL = 0.6;
/** 声の大きさが分からないとき、音節の頭でうなずく確率 */
const NOD_CHANCE = 0.45;
/** 声の山がこれだけ下がったら山を越えたとみなし、次の山はこれだけ上がってから数える */
const PEAK_DROP = 0.8;
const PEAK_RISE = 1.12;
/** 最近の山の平均よりこれだけ大きい山を強めた音節とみなす。平均は山ごとにこの割合で寄せる */
const ACCENT_RATIO = 1.1;
const PEAK_AVERAGE_RATE = 0.35;
/** うなずきの強さ（首を下へ振る初速 rad/秒）。文の終わりは少し深い */
const NOD_SPEED = 0.35;
const END_NOD_SPEED = 0.5;
/** 文ごとに変える首の傾き（左右へかしげる・振る）の幅 */
const TILT_RANGE = deg(3.5);
const TURN_RANGE = deg(3);
/** 首の動きのばね（固さ 1/秒² と減衰比） */
const SPRING_STIFFNESS = 22;
const SPRING_DAMPING = 2 * Math.sqrt(SPRING_STIFFNESS) * 0.85;
/** 眉・目が文の頭から戻る速さと、目標へ追う速さ（1/秒） */
const PULSE_DECAY = 1.3;
const FACE_FOLLOW = 20;
const BROW_PHRASE = 0.55;

/**
 * 調子ごとの芝居。うなずきの強さ・文の終わりの仕草・首の高さと、目の形（文の頭で一瞬か、話している間ずっとか）
 */
interface ToneStyle {
  nod: number;
  /** 文の終わりのうなずきの倍率（0 でうなずかない） */
  endNod: number;
  /** 文の終わりで首をかしげて止める角度 */
  endTilt: number;
  /** 話している間の首の上下（+ で下を向く） */
  pitch: number;
  /** 文の頭で眉を上げるか */
  brow: boolean;
  eye?: { shape: 'talkEyeWide' | 'talkEyeSmile' | 'talkEyeDown'; amount: number; hold: boolean };
  /** 強めた音節（うなずき）ごとに目を見開く量（0 で見開かない） */
  accent: number;
}
const TONE_STYLES: Record<SpeechTone, ToneStyle> = {
  calm: { nod: 1, endNod: 1, endTilt: 0, pitch: 0, brow: true, eye: { shape: 'talkEyeWide', amount: 0.3, hold: false }, accent: 0.3 },
  excited: { nod: 1.4, endNod: 1.2, endTilt: 0, pitch: deg(-1), brow: true, eye: { shape: 'talkEyeWide', amount: 0.6, hold: false }, accent: 0.45 },
  question: { nod: 0.7, endNod: 0, endTilt: deg(6), pitch: 0, brow: true, eye: { shape: 'talkEyeWide', amount: 0.45, hold: false }, accent: 0.3 },
  hesitant: { nod: 0.5, endNod: 0.6, endTilt: 0, pitch: deg(3), brow: false, eye: { shape: 'talkEyeDown', amount: 0.45, hold: true }, accent: 0 },
  surprised: { nod: 0.8, endNod: 0.5, endTilt: 0, pitch: deg(-2.5), brow: true, eye: { shape: 'talkEyeWide', amount: 0.85, hold: false }, accent: 0.4 },
  shy: { nod: 0.7, endNod: 0.8, endTilt: 0, pitch: deg(2), brow: false, eye: { shape: 'talkEyeSmile', amount: 0.2, hold: true }, accent: 0 },
};

/** 話者に渡す声の手がかり。loudness は録音の声の大きさ（0〜1。分からなければ undefined） */
export interface SpeechInput {
  phoneme: string | undefined;
  loudness?: number;
  tone?: SpeechTone;
}

/** 1つの軸の、目標へ向かうばね（突いて揺らせる） */
class Spring {
  value = 0;
  velocity = 0;
  target = 0;

  update(delta: number): void {
    const step = Math.min(delta, 1 / 30);
    this.velocity += (SPRING_STIFFNESS * (this.target - this.value) - SPRING_DAMPING * this.velocity) * step;
    this.value += this.velocity * step;
  }

  get resting(): boolean {
    return this.target === 0 && Math.abs(this.value) < 1e-4 && Math.abs(this.velocity) < 1e-3;
  }
}

/**
 * 話している間の首・眉・目の芝居。
 * - セリフの調子（文字から決める）：目の形、うなずきの強さ、問いかけの首かしげ、首の上下
 * - 声の大きさ：強めた音節（声の山が文の平均より大きい所）でうなずく。山が大きいほど深い
 * - 乱数：首を傾ける向きと、大きさの揺らぎだけ（毎回同じだと機械的に見える）
 */
export class TalkingFace {
  private readonly pitch = new Spring();
  private readonly roll = new Spring();
  private readonly yaw = new Spring();
  private readonly shapes: Set<FaceShape>;
  private readonly weights = new Map<FaceShape, number>();
  private readonly pulses = new Map<FaceShape, number>();
  private style: ToneStyle = TONE_STYLES.calm;
  private voiced = false;
  /** 音が途切れてからの秒数（話していなければ大きいまま） */
  private silence = Infinity;
  private sinceNod = Infinity;
  private phraseEnded = true;
  private resting = true;
  /** 声の山の検出（今の山・谷と、山を越えたか）と、最近の山の高さの平均（0 はまだ山がない） */
  private peak = 0;
  private trough = 0;
  private falling = false;
  private peakAverage = 0;

  private constructor(private readonly vrm: VRM, shapes: Set<FaceShape>) {
    this.shapes = shapes;
  }

  static create(vrm: VRM): TalkingFace {
    return new TalkingFace(vrm, registerShapes(vrm));
  }

  /**
   * 1フレーム進め、首・頭に回転を足す（足した回転を返す。次のフレームで戻す）。
   * emotion は今の感情の強さ（0〜1）、blink はまばたきの閉じ具合。感情の表情が顔を決めているときと、
   * まばたきの間は目・眉を動かさない
   */
  update(delta: number, speech: SpeechInput, emotion: number, blink: number): Array<{ bone: THREE.Object3D; rotation: THREE.Quaternion }> {
    const voiced = speech.phoneme !== undefined && VOWELS.has(speech.phoneme);
    this.sinceNod += delta;
    if (voiced) {
      if (!this.voiced) this.onVoiceStart(speech.tone ?? 'calm', speech.loudness === undefined);
      if (speech.loudness !== undefined) this.trackLoudness(speech.loudness);
      this.silence = 0;
    } else {
      this.silence += delta;
      this.falling = false;
      this.peak = this.trough = 0;
      if (!this.phraseEnded && this.silence >= PHRASE_GAP) this.onPhraseEnd();
      if (!this.resting && this.silence >= REST_GAP) this.rest();
    }
    this.voiced = voiced;

    this.pitch.update(delta);
    this.roll.update(delta);
    this.yaw.update(delta);
    this.updateShapes(delta, emotion, blink);
    if (this.pitch.resting && this.roll.resting && this.yaw.resting) return [];

    // 首に4割、頭に6割（うなずきは X 軸まわりの正の回転で下を向く）
    const humanoid = this.vrm.humanoid;
    const applied: Array<{ bone: THREE.Object3D; rotation: THREE.Quaternion }> = [];
    const turn = (bone: THREE.Object3D | null | undefined, share: number) => {
      if (!bone) return;
      const rotation = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(this.pitch.value * share, this.yaw.value * share, this.roll.value * share, 'YXZ'),
      );
      bone.quaternion.multiply(rotation);
      applied.push({ bone, rotation });
    };
    const neck = humanoid?.getNormalizedBoneNode('neck');
    turn(neck, 0.4);
    turn(humanoid?.getNormalizedBoneNode('head'), neck ? 0.6 : 1);
    return applied;
  }

  /** 声が出始めた。文の頭なら調子を決めて首の傾きを変え、眉・目を動かす。声の大きさが分からなければ乱数でうなずく */
  private onVoiceStart(tone: SpeechTone, noLoudness: boolean): void {
    if (this.phraseEnded) {
      const firstPhrase = this.resting;
      this.phraseEnded = false;
      this.resting = false;
      this.style = TONE_STYLES[tone];
      this.roll.target = (Math.random() * 2 - 1) * TILT_RANGE;
      this.yaw.target = (Math.random() * 2 - 1) * TURN_RANGE;
      this.pitch.target = this.style.pitch;
      if (this.style.brow) this.pulse('talkBrowUp', BROW_PHRASE);
      const eye = this.style.eye;
      // 驚きは言い出しの1回だけ大きく見開く
      if (eye && !eye.hold) this.pulse(eye.shape, tone === 'surprised' && !firstPhrase ? eye.amount * 0.4 : eye.amount);
      return;
    }
    if (noLoudness && Math.random() < NOD_CHANCE) this.nod(1);
  }

  /** 声の山を拾い、最近の山より大きい山（強めた音節）でうなずく。山が大きいほど深い */
  private trackLoudness(loudness: number): void {
    if (!this.falling) {
      this.peak = Math.max(this.peak, loudness);
      if (this.peak > 0.05 && loudness < this.peak * PEAK_DROP) {
        this.falling = true;
        this.trough = loudness;
        const ratio = this.peakAverage > 0 ? this.peak / this.peakAverage : 1;
        if (ratio > ACCENT_RATIO) this.nod(THREE.MathUtils.clamp((ratio - 1) * 2, 0.6, 1.6));
        this.peakAverage = this.peakAverage > 0 ? this.peakAverage + (this.peak - this.peakAverage) * PEAK_AVERAGE_RATE : this.peak;
      }
    } else {
      this.trough = Math.min(this.trough, loudness);
      if (loudness > this.trough * PEAK_RISE + 0.02) {
        this.falling = false;
        this.peak = loudness;
      }
    }
  }

  private nod(strength: number): void {
    if (this.sinceNod < NOD_INTERVAL) return;
    this.pitch.velocity += NOD_SPEED * this.style.nod * strength * (0.85 + Math.random() * 0.3);
    this.sinceNod = 0;
    // 強めた音節では目を見開き、眉も少し上げる
    if (this.style.accent > 0) {
      this.pulse('talkEyeWide', this.style.accent * Math.min(strength, 1.2));
      if (this.style.brow) this.pulse('talkBrowUp', BROW_PHRASE * 0.6);
    }
  }

  /** 文の終わり。調子に合わせてうなずくか、首をかしげて止める。傾きは半分戻す */
  private onPhraseEnd(): void {
    this.phraseEnded = true;
    const { endNod, endTilt } = this.style;
    if (endNod > 0) {
      this.pitch.velocity += END_NOD_SPEED * endNod;
      this.sinceNod = 0;
    }
    if (endTilt > 0) {
      this.roll.target = (Math.sign(this.roll.target) || 1) * endTilt;
    } else {
      this.roll.target *= 0.5;
    }
    this.yaw.target *= 0.5;
  }

  /** 話し終えた。首と目を戻す */
  private rest(): void {
    this.resting = true;
    this.roll.target = 0;
    this.yaw.target = 0;
    this.pitch.target = 0;
    this.style = TONE_STYLES.calm;
  }

  private pulse(shape: FaceShape, amount: number): void {
    this.pulses.set(shape, Math.max(this.pulses.get(shape) ?? 0, amount));
  }

  private updateShapes(delta: number, emotion: number, blink: number): void {
    const free = (1 - THREE.MathUtils.clamp(emotion, 0, 1)) * (1 - THREE.MathUtils.clamp(blink, 0, 1));
    const held = !this.resting ? this.style.eye : undefined;
    const manager = this.vrm.expressionManager;
    for (const shape of this.shapes) {
      const pulse = (this.pulses.get(shape) ?? 0) * Math.exp(-PULSE_DECAY * delta);
      this.pulses.set(shape, pulse < 1e-3 ? 0 : pulse);
      const hold = held?.hold && held.shape === shape ? held.amount : 0;
      // 眉は感情の表情に任せる。目はまばたきの間も閉じるのを邪魔しない
      const target = Math.max(pulse, hold) * (shape === 'talkBrowUp' ? 1 - THREE.MathUtils.clamp(emotion, 0, 1) : free);
      const current = this.weights.get(shape) ?? 0;
      let next = current + (target - current) * (1 - Math.exp(-FACE_FOLLOW * delta));
      if (next < 1e-3 && target === 0) next = 0;
      this.weights.set(shape, next);
      manager?.setValue(shape, next);
    }
  }
}

/** 眉・目のシェイプキーを表情として登録する（見つかったものを返す） */
function registerShapes(vrm: VRM): Set<FaceShape> {
  const found = new Set<FaceShape>();
  const manager = vrm.expressionManager;
  if (!manager) return found;
  for (const [name, shapeKey] of Object.entries(SHAPE_KEYS) as Array<[FaceShape, string]>) {
    if (manager.getExpression(name)) {
      found.add(name);
      continue;
    }
    const primitives: THREE.Mesh[] = [];
    let index = -1;
    vrm.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      const hit = mesh.isMesh ? mesh.morphTargetDictionary?.[shapeKey] : undefined;
      if (hit === undefined) return;
      index = hit;
      primitives.push(mesh);
    });
    if (primitives.length === 0) continue;
    const expression = new VRMExpression(name);
    expression.addBind(new VRMExpressionMorphTargetBind({ primitives, index, weight: 1.0 }));
    vrm.scene.add(expression);
    manager.registerExpression(expression);
    found.add(name);
  }
  return found;
}
