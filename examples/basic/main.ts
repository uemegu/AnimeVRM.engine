/**
 * 何もない空間にアバターを1人立たせるだけの例。
 * モデルと待機モーションはこのリポジトリに含まないので、vite.config.ts の publicDir（AnimeVRM の assets/）から読む
 */
import { StageManager } from '../../src/stage/StageManager';
import type { LocationVisualPreset, TimeOfDayPreset } from '../../src/schema/visual';
import day from './day.json';

/** 背景の絵も3Dのセットもない場所（時間帯の空だけが映る） */
const empty: LocationVisualPreset = {
  id: 'empty',
  name: 'Empty',
  layers: { background: {} },
};

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const stage = new StageManager({
  canvas,
  presets: { timeOfDay: { day: day as TimeOfDayPreset }, locations: { empty } },
  initialTimeOfDay: 'day',
  initialLocationId: 'empty',
});

const resize = () => stage.resize(canvas.clientWidth, canvas.clientHeight);
new ResizeObserver(resize).observe(canvas);
resize();

// モーションを指定しないので、待機モーション（Standing Idle）で立つ
await stage.setCast([
  {
    id: 'aoi',
    modelUrl: '/models/aoi/aoi-school.vrm',
    slot: 'center',
    expression: 'happy',
    expressionWeight: 1,
    motionLoop: true,
  },
]);
stage.setCameraShot('wide', 'aoi');
