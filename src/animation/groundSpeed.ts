import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';

/**
 * その場で足を動かすモーション（Mixamo の Walking・Jogging など、腰が前に進まないもの）が、
 * 本来どれだけの速さで地面を進む動きなのかを、接地している足の速さから求める（再生速度 1 のときの m/秒）。
 *
 * 接地している足は、体が進む速さと同じ速さで体に対して後ろへ動く。体（モデルの原点）をこの速さで
 * 進めれば、接地した足は地面の同じ所に止まり、床を滑らない（Unreal の Speed Planting と同じ考え方）。
 *
 * 足の位置は、そのモデルの脚の長さで計算する（変換後のモーションを、正規化ボーンの基準姿勢で順にたどる）。
 * 脚の長さが違えば歩幅も変わるので、FBX の数値ではなくモデルごとに測る。
 * 足をほとんど滑らせない（地面を進まない）モーションは 0。
 */
const SAMPLE_FPS = 60;
/** 接地とみなす高さ（その足の点のいちばん低い所からの差） */
const CONTACT_MARGIN = 0.025;
/** これより遅いものは歩きではない（立ち・足踏み） */
const MIN_GROUND_SPEED = 0.15;

const LEG_CHAINS: VRMHumanBoneName[][] = [
  ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes'],
  ['rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes'],
];

const speedCache = new WeakMap<THREE.AnimationClip, number>();

export function measureGroundSpeed(clip: THREE.AnimationClip, vrm: VRM): number {
  const cached = speedCache.get(clip);
  if (cached !== undefined) return cached;
  const speed = measure(clip, vrm);
  speedCache.set(clip, speed);
  return speed;
}

function measure(clip: THREE.AnimationClip, vrm: VRM): number {
  const humanoid = vrm.humanoid;
  if (!humanoid || clip.duration <= 0) return 0;
  const rest = humanoid.normalizedRestPose;

  const sampler = (bone: VRMHumanBoneName, property: 'quaternion' | 'position') => {
    const name = humanoid.getNormalizedBoneNode(bone)?.name;
    const track = name ? clip.tracks.find((t) => t.name === `${name}.${property}`) : undefined;
    if (!track) return null;
    const size = property === 'quaternion' ? 4 : 3;
    const result = new Float32Array(size);
    const interpolant =
      property === 'quaternion'
        ? new THREE.QuaternionLinearInterpolant(track.times, track.values, size, result)
        : new THREE.LinearInterpolant(track.times, track.values, size, result);
    return (time: number) => interpolant.evaluate(time) as Float32Array;
  };

  const hipsPosition = sampler('hips', 'position');
  const hipsRotation = sampler('hips', 'quaternion');
  const restHips = rest.hips?.position;
  if (!restHips) return 0;
  const chains = LEG_CHAINS.map((chain) =>
    chain.map((bone) => ({ offset: rest[bone]?.position, rotation: sampler(bone, 'quaternion') }))
  );
  if (chains.some((chain) => chain.slice(0, 3).some((link) => !link.offset))) return 0;

  // 各時刻の、両足の足首とつま先の位置（モデルの原点から見た位置）
  const q = new THREE.Quaternion();
  const local = new THREE.Quaternion();
  const point = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const pointsAt = (time: number): THREE.Vector3[] => {
    const base = new THREE.Vector3().fromArray(hipsPosition ? hipsPosition(time) : restHips);
    q.identity();
    if (hipsRotation) q.fromArray(hipsRotation(time));
    const points: THREE.Vector3[] = [];
    for (const chain of chains) {
      const rotation = q.clone();
      point.copy(base);
      chain.forEach((link, index) => {
        if (!link.offset) return;
        point.add(offset.fromArray(link.offset).applyQuaternion(rotation));
        if (index >= 2) points.push(point.clone());
        if (link.rotation) rotation.multiply(local.fromArray(link.rotation(time)));
      });
    }
    return points;
  };

  const count = Math.max(2, Math.round(clip.duration * SAMPLE_FPS));
  const frames = Array.from({ length: count + 1 }, (_, i) => pointsAt((clip.duration * i) / count));
  const floor = Math.min(...frames.flatMap((points) => points.map((p) => p.y)));

  // 接地している点（いちばん低い点）の、次の時刻までの水平の動き。走りでは、着地の直前（まだ足を前へ振っている）や
  // 蹴り出しの所も低い点に入るので、平均ではなく進む向きの速さの中央値を取る（接地の真ん中の、地面に止まっている所の速さ）
  const dt = clip.duration / count;
  const steps: THREE.Vector2[] = [];
  const sum = new THREE.Vector2();
  for (let i = 0; i < count; i++) {
    const points = frames[i];
    let lowest = 0;
    for (let k = 1; k < points.length; k++) if (points[k].y < points[lowest].y) lowest = k;
    const now = points[lowest];
    const next = frames[i + 1][lowest];
    if (now.y > floor + CONTACT_MARGIN || next.y > floor + CONTACT_MARGIN) continue;
    const step = new THREE.Vector2(next.x - now.x, next.z - now.z).divideScalar(dt);
    steps.push(step);
    sum.add(step);
  }
  if (steps.length * dt < clip.duration * 0.3 || sum.lengthSq() < 1e-12) return 0;
  const direction = sum.normalize();
  const along = steps.map((step) => step.dot(direction)).sort((a, b) => a - b);
  const speed = along[Math.floor(along.length / 2)];
  return speed >= MIN_GROUND_SPEED ? speed : 0;
}
