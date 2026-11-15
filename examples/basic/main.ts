/**
 * グレーの床だけの空間にアバターを1人立たせ、マウスでカメラを回せる例。VRM ファイルをドロップすると差し替える。
 * 必要な素材はモデル（public/models/aoi-school.vrm）だけで、待機モーションの FBX は使わない（腕を下ろした姿勢で立つ）
 *
 * URL で切り替えられるもの：
 * - ?cloth=1        既定のモデルのスカートを布として動かす（src/cloth。布にする服はモデルごとに指定する：下の DEFAULT_CLOTH）
 * - ?cloth={...}    布にする服を JSON で指定する（材質名かメッシュ名 → { fabric, kind?, over? }。src/cloth/vrm.ts の GarmentSpec）
 * - ?motion=<名前>  public/animations/<名前>.fbx のモーションを繰り返す（FBX は自分で置く）
 * - ?model=<URL>    読み込む VRM（省くと public/models/aoi-school.vrm）
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { StageManager } from '../../src/stage/StageManager';
import { StageAvatar } from '../../src/stage/StageAvatar';
import type { GarmentSpec } from '../../src/cloth/vrm';
import { registerEnvironment } from '../../src/stage/environments';
import { configureAssets } from '../../src/utils/path';
import type { LocationVisualPreset, TimeOfDayPreset } from '../../src/schema/visual';
import day from './day.json';

// 待機モーションを読まない
configureAssets({ idleMotion: null });

// グレーの床だけの3D背景（builtin:floor）
registerEnvironment('floor', {
  load: async () => {
    const group = new THREE.Group();
    const floor = new THREE.Mesh(new THREE.CircleGeometry(20, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#8c9097' }));
    group.add(floor);
    return group;
  },
  dispose: (group) => group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      child.material.dispose();
    }
  }),
});

/** 床と時間帯の空だけの場所。キャラの影を床に落とす */
const floor: LocationVisualPreset = {
  id: 'floor',
  name: 'Floor',
  layers: { background: {} },
  environment: { model: 'builtin:floor', position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 },
  light: { direction: { x: 1, y: 3, z: 2 }, shadow: { color: '#3c4150', opacity: 0.4, softness: 4 } },
};

const params = new URLSearchParams(location.search);
const motion = params.get('motion') ?? undefined;

// ?knitopts={...}：上着の布（src/cloth/knit.ts）の設定を試す
StageAvatar.knitOptions = JSON.parse(params.get('knitopts') ?? '{}');

// 既定のモデル（aoi-school.vrm）で布にする服：スカートをスーツ地で
const DEFAULT_CLOTH: Record<string, GarmentSpec> = { N00_001_03_Bottoms_01_CLOTH: { fabric: 'suiting' } };
const clothParam = params.get('cloth');
const cloth: Record<string, GarmentSpec> | null = clothParam === '1' ? DEFAULT_CLOTH : clothParam ? JSON.parse(clothParam) : null;

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const stage = new StageManager({
  canvas,
  quality: cloth ? { skirtCloth: true } : undefined,
  garments: () => cloth ?? undefined,
  presets: { timeOfDay: { day: day as TimeOfDayPreset }, locations: { floor } },
  initialTimeOfDay: 'day',
  initialLocationId: 'floor',
});

const resize = () => stage.resize(canvas.clientWidth, canvas.clientHeight);
new ResizeObserver(resize).observe(canvas);
resize();

/** キャラを1人立たせる。同じ id で modelUrl を変えると、前のモデルを破棄して読み直す */
function showAvatar(modelUrl: string): Promise<void> {
  return stage.setCast([{ id: 'avatar', modelUrl, slot: 'center', expression: 'neutral', expressionWeight: 1, motion, motionLoop: true }]);
}

// 開発中にコンソールから状態を見る用
if (import.meta.env.DEV) (window as unknown as { stage: StageManager }).stage = stage;

await showAvatar(params.get('model') ?? '/models/aoi-school.vrm');
stage.setCameraShot('wide', 'avatar');

// VRM ファイルのドロップで差し替える
const container = document.querySelector<HTMLElement>('#stage')!;
const hint = document.querySelector<HTMLElement>('#hint')!;
let droppedUrl: string | null = null;
container.addEventListener('dragover', (event) => {
  event.preventDefault();
  container.classList.add('dragging');
});
container.addEventListener('dragleave', () => container.classList.remove('dragging'));
container.addEventListener('drop', async (event) => {
  event.preventDefault();
  container.classList.remove('dragging');
  const file = [...(event.dataTransfer?.files ?? [])].find((f) => f.name.toLowerCase().endsWith('.vrm'));
  if (!file) {
    hint.textContent = 'VRM ファイル（.vrm）をドロップしてください';
    return;
  }
  hint.textContent = `${file.name} を読み込み中`;
  const url = URL.createObjectURL(file);
  await showAvatar(url);
  if (droppedUrl) URL.revokeObjectURL(droppedUrl);
  droppedUrl = url;
  hint.textContent = `${file.name}（VRM ファイルをドロップすると差し替えます）`;
});

// 構図が決まってから、カメラを手で動かせるようにする（構図の自動決定は止める）
setTimeout(() => {
  const controls = new OrbitControls(stage.viewCamera, canvas);
  controls.target.copy(stage.viewTarget);
  controls.enableDamping = true;
  if (import.meta.env.DEV) (window as unknown as { controls: OrbitControls }).controls = controls;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.addEventListener('change', () => stage.setFreeCameraTarget(controls.target));
  stage.setFreeCamera(true);
  const tick = () => {
    controls.update();
    requestAnimationFrame(tick);
  };
  tick();
}, 1500);
