/**
 * 布のシミュレーション（src/cloth）だけを使う例。engine のほかの部分（StageManager など）は使わない。
 * キャラに作り物の動き（歩く・走る・しゃがむ…）をさせ、スカートを布にする。スカートはマウスで摘める。
 *
 * - 既定：VRM として読み、createVrmSkirt(vrm) に任せる
 * - ?api=generic：VRM の仕組みを使わず、ふつうの glTF として読み、布にするメッシュ・骨・当たる体を
 *   この例の中で骨の名前から選んで SkinnedCloth.create に渡す（VRM でない骨つきモデルで使うときの形）
 * - ?api=mesh：骨のない、部品に分かれたモデル（3D 生成のモデルなど）を読み、createMeshSkirt(root) に任せる。
 *   モデル全体を揺らす・回す・跳ねさせて、スカートを動かす。?model= でモデルを渡す（例：/local/plaid-skirt.glb）
 * - ?model=<URL>：読み込むモデル（省くと basic の例の aoi-school.vrm）
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, type VRM } from '@pixiv/three-vrm';
import { MeshCloth, SkinnedCloth, createMeshSkirt, createVrmSkirt } from '../../src/cloth';

const params = new URLSearchParams(location.search);
const api = params.get('api') === 'generic' ? 'generic' : params.get('api') === 'mesh' ? 'mesh' : 'vrm';
const generic = api !== 'vrm';   // VRM の仕組みを使わない
const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const status = document.querySelector<HTMLElement>('#status')!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#2a2c30');
scene.add(new THREE.HemisphereLight('#ffffff', '#b9a9a0', 1.2));
const sun = new THREE.DirectionalLight('#fff4e8', 2);
sun.position.set(-1, 2.6, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -1.2, right: 1.2, top: 2, bottom: -0.2, near: 0.5, far: 8 });
scene.add(sun);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.3 }));
floor.receiveShadow = true;
scene.add(floor);
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 40);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
const resize = () => {
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  camera.aspect = canvas.clientWidth / canvas.clientHeight;
  camera.updateProjectionMatrix();
};
new ResizeObserver(resize).observe(canvas);
resize();

// ---- モデル ----
const loader = new GLTFLoader();
if (!generic) loader.register((parser) => new VRMLoaderPlugin(parser));
const gltf = await loader.loadAsync(params.get('model') ?? '/models/aoi-school.vrm');
const vrm: VRM | null = generic ? null : gltf.userData.vrm;
const model = vrm ? vrm.scene : gltf.scene;
model.traverse((object) => {
  if ((object as THREE.Mesh).isMesh) { object.castShadow = true; object.frustumCulled = false; }
});
scene.add(model);
// モデル全体が入るようにカメラを置く（大きさの単位はモデルによる）
{
  const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
  const span = Math.max(size.y, size.x * 0.8);
  controls.target.copy(centre);
  camera.position.set(centre.x + span * 0.35, centre.y + span * 0.15, centre.z + span * 2.8);
  camera.near = span * 0.02; camera.far = span * 40; camera.updateProjectionMatrix();
  floor.position.y = box.min.y; floor.scale.setScalar(span);
  sun.position.multiplyScalar(span); sun.shadow.camera.far = span * 8; sun.shadow.camera.near = span * 0.3;
  Object.assign(sun.shadow.camera, { left: -span * 1.2, right: span * 1.2, top: span * 1.6, bottom: -span * 0.6 });
  sun.target.position.copy(centre); scene.add(sun.target);
  sun.shadow.camera.updateProjectionMatrix();
}

/** 骨を名前で探す（?api=generic 用。VRoid の骨の名前） */
const bonesNamed = (pattern: RegExp): THREE.Object3D[] => {
  const found: THREE.Object3D[] = [];
  model.traverse((object) => { if ((object as THREE.Bone).isBone && pattern.test(object.name)) found.push(object); });
  return found;
};
/** 動かす骨。VRM なら正規化された骨（T ポーズからの回転）、そうでなければ名前で探した骨。骨のないモデルでは使わない */
const BONES = {
  hips: 'C_Hips', spine: 'C_Spine', leftUpperLeg: 'L_UpperLeg', rightUpperLeg: 'R_UpperLeg', leftLowerLeg: 'L_LowerLeg', rightLowerLeg: 'R_LowerLeg',
  leftUpperArm: 'L_UpperArm', rightUpperArm: 'R_UpperArm',
} as const;
type BoneName = keyof typeof BONES;
const bone = (name: BoneName): THREE.Object3D => {
  const found = vrm ? vrm.humanoid.getNormalizedBoneNode(name) : bonesNamed(new RegExp(`^J_Bip_${BONES[name]}$`))[0];
  if (!found) throw new Error(`骨が見つからない：${name}`);
  return found;
};
const B = api === 'mesh' ? null : Object.fromEntries((Object.keys(BONES) as BoneName[]).map((name) => [name, bone(name)])) as Record<BoneName, THREE.Object3D>;
const hipsRest = B ? B.hips.position.clone() : new THREE.Vector3();
const modelRest = model.position.clone();
const modelHeight = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3()).y;

// ---- 作り物の動き ----
/** ボタンに出す動き。骨のあるモデルは骨を動かし、骨のないモデルは全体を動かす */
const MOTIONS: [string, string][] = api === 'mesh'
  ? [['stand', '止まる'], ['sway', '左右に揺らす'], ['spin', '回る'], ['jump', '跳ぶ']]
  : [['stand', '立つ'], ['walk', '歩く'], ['run', '走る'], ['squat', 'しゃがむ'], ['kick', '脚を上げる'], ['spin', '回る']];
let motion = params.get('motion') ?? 'stand';
let motionTime = 0;
/** 骨のないモデル：モデル全体を動かす */
function poseModel(t: number): void {
  model.position.copy(modelRest);
  model.rotation.y = 0;
  if (motion === 'sway') {
    model.position.x += 0.06 * modelHeight * Math.sin(t * 7);
    model.rotation.y = 0.25 * Math.sin(t * 7 + 0.9);
  } else if (motion === 'spin') {
    const u = (t % 2.4) / 1.3;
    model.rotation.y = (u < 1 ? u * u * (3 - 2 * u) : 1) * Math.PI * 2;
  } else if (motion === 'jump') {
    const u = (t % 1.6) / 0.5;
    if (u < 1) model.position.y += 0.3 * modelHeight * 4 * u * (1 - u);
  }
}
function pose(t: number): void {
  if (!B) { poseModel(t); return; }
  for (const b of Object.values(B)) b.rotation.set(0, 0, 0);
  B.hips.position.copy(hipsRest);
  B.leftUpperArm.rotation.z = -1.2;
  B.rightUpperArm.rotation.z = 1.2;
  /** hip > 0 で太ももを前へ上げる、knee > 0 でひざを曲げる */
  const leg = (side: 'left' | 'right', hip: number, knee: number) => {
    B[`${side}UpperLeg`].rotation.x = -hip;
    B[`${side}LowerLeg`].rotation.x = knee;
  };
  if (motion === 'walk' || motion === 'run') {
    const run = motion === 'run', f = (run ? 2.7 : 1.7) * Math.PI * 2 * t, swing = run ? 0.9 : 0.5;
    leg('left', swing * Math.sin(f) + (run ? 0.25 : 0), (run ? 1.3 : 0.7) * Math.max(0, Math.sin(f - 1.2)));
    leg('right', -swing * Math.sin(f) + (run ? 0.25 : 0), (run ? 1.3 : 0.7) * Math.max(0, Math.sin(f - 1.2 + Math.PI)));
    B.hips.position.y += (run ? 0.045 : 0.018) * Math.cos(2 * f);
    B.hips.rotation.y = (run ? 0.16 : 0.09) * Math.sin(f);
  } else if (motion === 'squat') {
    const k = 0.5 - 0.5 * Math.cos(t * 2.2);
    leg('left', 1.5 * k, 2.3 * k);
    leg('right', 1.5 * k, 2.3 * k);
    B.hips.position.y -= 0.36 * k * hipsRest.y / 0.9;
    B.spine.rotation.x = 0.35 * k;
  } else if (motion === 'kick') {
    leg('left', 1.5 * Math.max(0, Math.sin(t * 2.4)) ** 2, 0);
  } else if (motion === 'spin') {
    const u = (t % 2.4) / 1.3;
    B.hips.rotation.y = (u < 1 ? u * u * (3 - 2 * u) : 1) * Math.PI * 2;
  }
}
const motionBox = document.querySelector<HTMLElement>('#motions')!;
motionBox.replaceChildren(...MOTIONS.map(([name, label]) => Object.assign(document.createElement('button'), { textContent: label, id: `motion-${name}` })));
const motionButtons = [...motionBox.querySelectorAll<HTMLButtonElement>('button')];
function setMotion(name: string): void {
  motion = name;
  motionTime = 0;
  for (const button of motionButtons) button.classList.toggle('on', button.id === `motion-${name}`);
}
for (const button of motionButtons) button.onclick = () => setMotion(button.id.replace('motion-', ''));
setMotion(motion);

// ---- 布。基準の姿勢（脚をそろえて立った姿勢）のうちに作る ----
{
  const chosen = motion;
  motion = 'stand';
  pose(0);
  vrm?.update(0);
  motion = chosen;
}
let skirt: SkinnedCloth | MeshCloth | null;
if (vrm) {
  skirt = createVrmSkirt(vrm);
} else if (api === 'mesh') {
  // 骨のないモデル。布にするメッシュ・当たる体・大きさの単位は形から選ばれる（?skirt= ?scale= で指定もできる）
  skirt = createMeshSkirt(model, {
    skirt: params.get('skirt') ?? undefined,
    metresPerUnit: params.has('scale') ? Number(params.get('scale')) : 'auto',
  });
} else {
  // VRM の仕組みを使わない指定。この例では VRoid の骨・材質の名前で選ぶ
  let mesh: THREE.SkinnedMesh | null = null;
  const bodies: THREE.SkinnedMesh[] = [];
  model.traverse((object) => {
    const o = object as THREE.SkinnedMesh;
    if (!o.isSkinnedMesh) return;
    const name = (Array.isArray(o.material) ? o.material[0] : o.material).name;
    if (/Bottoms/.test(name)) mesh = o;
    if (/Body_00_SKIN/.test(name)) bodies.push(o);
  });
  if (!mesh) throw new Error('スカートのメッシュ（材質名に Bottoms）が見つからない');
  skirt = SkinnedCloth.create({
    mesh,
    // スカートの揺れ骨と、脚の骨に付いた頂点が布
    clothBones: [...bonesNamed(/Skirt/), ...bonesNamed(/^J_Bip_[LR]_(UpperLeg|LowerLeg|Foot|ToeBase)$/)],
    reference: B!.hips,
    colliders: {
      meshes: bodies,
      bones: bonesNamed(/^J_Bip_(C_Hips|C_Spine|[LR]_UpperLeg|[LR]_LowerLeg)$/),
      // 胸より上・腕・足先は当たり判定に入れない
      stopBones: bonesNamed(/^J_Bip_(C_Chest|C_UpperChest|[LR]_Shoulder|[LR]_Foot)$/),
    },
  });
}
if (!skirt) status.textContent = `布にできなかった：${SkinnedCloth.skipped || MeshCloth.skipped}`;

let clothOn = true;
const toggle = document.querySelector<HTMLButtonElement>('#toggle')!;
toggle.onclick = () => {
  clothOn = !clothOn;
  toggle.textContent = clothOn ? '布：入' : '布：切（元の形のまま）';
  skirt?.setEnabled(clothOn);
};
const windInput = document.querySelector<HTMLInputElement>('#wind')!;
const windValue = document.querySelector<HTMLElement>('#windValue')!;
let windSpeed = Number(params.get('wind') ?? 0);
windInput.value = String(windSpeed);
const readWind = () => { windSpeed = Number(windInput.value); windValue.textContent = windSpeed.toFixed(1); };
windInput.oninput = readWind;
readWind();

// ---- 摘む ----
const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2(), plane = new THREE.Plane(), hit = new THREE.Vector3();
let dragging = false;
const aim = (event: PointerEvent) => {
  const rect = canvas.getBoundingClientRect();
  pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
};
const release = () => {
  if (!dragging) return;
  skirt?.endGrab();
  dragging = false;
  controls.enabled = true;
  canvas.classList.remove('pinch');
};
canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !skirt || !clothOn) return;
  release();
  aim(event);
  const found = skirt.raycast(raycaster.ray);
  if (!found || !skirt.startGrab(found.point)) return;
  plane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()).negate(), found.point);
  dragging = true;
  controls.enabled = false;
  canvas.classList.add('pinch');
}, true);
canvas.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  aim(event);
  if (raycaster.ray.intersectPlane(plane, hit)) skirt?.moveGrab(hit);
});
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);

// ---- 毎フレーム：姿勢を決めてから布を進める ----
const clock = new THREE.Clock();
let frames = 0;
function frame(): void {
  const delta = Math.min(clock.getDelta(), 1 / 30);
  motionTime += delta;
  pose(motionTime);
  vrm?.update(delta);
  skirt?.update(delta, windSpeed > 0 ? { velocity: { x: windSpeed, y: 0, z: windSpeed * 0.3 } } : null);
  controls.update();
  renderer.render(scene, camera);
  if (skirt && ++frames % 30 === 0) {
    const m = skirt.cloth.measure();
    const how = api === 'vrm' ? '指定：VRM に任せる' : api === 'generic' ? '指定：骨の名前で直接' : `指定：形から自動（1 ユニット＝${(skirt as MeshCloth).info.metresPerUnit.toFixed(2)}m）`;
    const bodies = 'pieces' in skirt.info ? skirt.info.pieces.length : skirt.info.colliders.length;
    status.textContent = `${how}\n布 ${skirt.info.cloth} 点・留めた点 ${skirt.info.held}・体の部品 ${bodies}\n計算 ${m.ms.toFixed(1)} ms／フレーム\n食い込み：体 ${(m.depth * 1000).toFixed(1)} mm・布どうし ${m.through} 組`;
  }
  requestAnimationFrame(frame);
}
if (import.meta.env.DEV) Object.assign(window, { skirt, setMotion });
requestAnimationFrame(frame);
