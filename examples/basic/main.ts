/**
 * 白い床だけの空間にアバターを1人立たせ、マウスでカメラを回せる例。
 * 必要な素材はモデル（public/models/aoi-school.vrm）だけで、待機モーションの FBX は使わない（腕を下ろした姿勢で立つ）
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { StageManager } from '../../src/stage/StageManager';
import { registerEnvironment } from '../../src/stage/environments';
import { configureAssets } from '../../src/utils/path';
import type { LocationVisualPreset, TimeOfDayPreset } from '../../src/schema/visual';
import day from './day.json';

// 待機モーションを読まない
configureAssets({ idleMotion: null });

// 白い床だけの3D背景（builtin:white-floor）
registerEnvironment('white-floor', {
  load: async () => {
    const group = new THREE.Group();
    const floor = new THREE.Mesh(new THREE.CircleGeometry(20, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
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

/** 白い床と時間帯の空だけの場所。キャラの影を床に落とす */
const floor: LocationVisualPreset = {
  id: 'floor',
  name: 'White floor',
  layers: { background: {} },
  environment: { model: 'builtin:white-floor', position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: 1 },
  light: { direction: { x: 1, y: 3, z: 2 }, shadow: { color: '#8a93a6', opacity: 0.4, softness: 4 } },
};

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const stage = new StageManager({
  canvas,
  presets: { timeOfDay: { day: day as TimeOfDayPreset }, locations: { floor } },
  initialTimeOfDay: 'day',
  initialLocationId: 'floor',
});

const resize = () => stage.resize(canvas.clientWidth, canvas.clientHeight);
new ResizeObserver(resize).observe(canvas);
resize();

await stage.setCast([
  {
    id: 'aoi',
    modelUrl: '/models/aoi-school.vrm',
    slot: 'center',
    expression: 'happy',
    expressionWeight: 1,
    motionLoop: true,
  },
]);
stage.setCameraShot('wide', 'aoi');

// 構図が決まってから、カメラを手で動かせるようにする（構図の自動決定は止める）
setTimeout(() => {
  const controls = new OrbitControls(stage.viewCamera, canvas);
  controls.target.copy(stage.viewTarget);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.addEventListener('change', () => stage.setFreeCameraTarget(controls.target));
  stage.setFreeCamera(true);
  const tick = () => {
    controls.update();
    requestAnimationFrame(tick);
  };
  tick();
}, 1500);
