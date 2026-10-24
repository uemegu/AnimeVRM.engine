import * as THREE from 'three';
import { DataUtils } from 'three';

/** 写し取る絵の高さ（ピクセル）。粒の数はこれと MAX_PARTICLES で決まる */
const CAPTURE_HEIGHT = 360;
const MAX_PARTICLES = 40000;
/** 写し取った絵で、粒にする不透明度のしきい値 */
const ALPHA_THRESHOLD = 0.25;
/** 粒が崩れ始める時刻の幅（進み 0〜1 のうち）。上から下へ、ばらつきを持って崩れていく */
const START_SPREAD = 0.35;

const vertexShader = /* glsl */ `
  attribute vec4 aColor;
  attribute vec4 aSeed;
  attribute float aStart;
  uniform float uProgress;
  uniform float uSize;
  uniform float uRise;
  uniform float uScreenScale;
  uniform vec3 uTarget;
  uniform float uHasTarget;
  uniform float uArc;
  varying vec4 vColor;
  varying float vQ;

  void main() {
    float q = clamp((uProgress - aStart) / (1.0 - ${START_SPREAD.toFixed(2)}), 0.0, 1.0);
    vQ = q;
    vec3 jitter = aSeed.xyz - 0.5;
    vec3 p;
    float alpha;
    if (uHasTarget > 0.5) {
      // 移動先へ、ふくらんだ弧を描いて流れていく。途中は粒ごとに広がり、着く頃に一点へ集まる
      float e = q * q * (3.0 - 2.0 * q);
      float bulge = sin(3.14159 * e);
      vec3 swirl = vec3(sin(e * 9.0 + aSeed.w * 6.2832), cos(e * 7.0 + aSeed.x * 6.2832), sin(e * 8.0 + aSeed.y * 6.2832));
      p = mix(position, uTarget + jitter * 0.25, e);
      p += vec3(0.0, uArc * bulge, 0.0) + (jitter * 1.1 + swirl * 0.25) * bulge * (0.4 + uArc * 0.3);
      alpha = 1.0 - smoothstep(0.8, 1.0, q);
    } else {
      // 上へ舞い上がりながら、粒ごとの向きへ広がって消える
      float lift = pow(q, 1.4);
      float angle = aSeed.x * 6.2832;
      float swirl = sin(q * (4.0 + aSeed.z * 5.0) + aSeed.w * 6.2832);
      p = position;
      p.y += lift * uRise * (0.5 + aSeed.y);
      p.x += lift * (cos(angle) * 0.7 * aSeed.z + swirl * 0.2);
      p.z += lift * (sin(angle) * 0.7 * aSeed.z + cos(q * 5.0 + aSeed.x * 6.2832) * 0.2);
      alpha = 1.0 - smoothstep(0.35, 1.0, q);
    }
    // 色はキャラのまま。飛んでいる間だけ少し光らせる
    vColor = vec4(aColor.rgb * (1.0 + 0.35 * sin(3.14159 * q)), aColor.a * alpha);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float grow = (1.0 + 1.3 * sin(3.14159 * q)) * (1.0 - 0.6 * smoothstep(0.7, 1.0, q));
    gl_PointSize = uSize * grow * uScreenScale / max(-mv.z, 0.05);
  }
`;

const fragmentShader = /* glsl */ `
  varying vec4 vColor;
  varying float vQ;

  void main() {
    // 崩れる前は隙間が出ないよう四角のまま、舞うほど丸くぼかす
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float soft = smoothstep(0.0, 0.25, vQ);
    float shape = mix(1.0, 1.0 - smoothstep(0.2, 1.0, d), soft);
    float alpha = vColor.a * shape;
    if (alpha < 0.003) discard;
    gl_FragColor = vec4(vColor.rgb, alpha);
  }
`;

/**
 * キャラを霧のように崩して消す。今のカメラからキャラだけを絵に写し取り、そのピクセルを粒にして、
 * キャラのいた奥行きに並べる。粒は進み（0〜1）だけで位置が決まるので、途中から再生しても同じ絵になる。
 * 描き込みはシーンの本描画と同じ（トーンマップ前の線形）なので、後段のポストプロセスも同じように掛かる
 */
export class MistDissolve {
  private readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;

  private constructor(points: THREE.Points, material: THREE.ShaderMaterial) {
    this.points = points;
    this.material = material;
  }

  /**
   * target（キャラのルート）だけを camera から写し取って粒にする。写せる画素がなければ null。
   * depthPoint はキャラの奥行きの基準（胸のあたり）。destination があれば粒はそこへ流れ、なければ舞い上がる
   */
  static capture(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, target: THREE.Object3D, depthPoint: THREE.Vector3, destination: THREE.Vector3 | null = null): MistDissolve | null {
    const height = CAPTURE_HEIGHT;
    const width = Math.max(1, Math.round(height * camera.aspect));
    const rt = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, samples: 4 });
    const pixels = new Uint16Array(width * height * 4);

    // キャラとライトだけを残して描く
    const hidden: THREE.Object3D[] = [];
    for (const child of scene.children) {
      if (child === target || (child as THREE.Light).isLight || !child.visible) continue;
      child.visible = false;
      hidden.push(child);
    }
    const background = scene.background;
    const wasVisible = target.visible;
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    scene.background = null;
    target.visible = true;
    try {
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(rt, 0, 0, width, height, pixels);
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClear, prevAlpha);
      scene.background = background;
      target.visible = wasVisible;
      for (const child of hidden) child.visible = true;
      rt.dispose();
    }

    let opaque = 0;
    for (let i = 3; i < pixels.length; i += 4) if (DataUtils.fromHalfFloat(pixels[i]) > ALPHA_THRESHOLD) opaque++;
    if (opaque === 0) return null;
    const stride = Math.max(1, Math.ceil(Math.sqrt(opaque / MAX_PARTICLES)));

    // 写した画素を、カメラから depth の距離にある、カメラに正対する面へ戻す
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    const depth = Math.max(0.1, -depthPoint.clone().applyMatrix4(camera.matrixWorldInverse).z);
    const halfH = depth * Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2);
    const halfW = halfH * camera.aspect;
    const pixelWorld = (2 * halfH) / height;

    const positions: number[] = [];
    const colors: number[] = [];
    const seeds: number[] = [];
    const starts: number[] = [];
    let minRow = height;
    let maxRow = 0;
    for (let y = 0; y < height; y += stride) {
      for (let x = 0; x < width; x += stride) {
        if (DataUtils.fromHalfFloat(pixels[(y * width + x) * 4 + 3]) > ALPHA_THRESHOLD) {
          minRow = Math.min(minRow, y);
          maxRow = Math.max(maxRow, y);
        }
      }
    }
    const v = new THREE.Vector3();
    for (let y = 0; y < height; y += stride) {
      for (let x = 0; x < width; x += stride) {
        const i = (y * width + x) * 4;
        const a = DataUtils.fromHalfFloat(pixels[i + 3]);
        if (a <= ALPHA_THRESHOLD) continue;
        const ndcX = ((x + stride / 2) / width) * 2 - 1;
        const ndcY = ((y + stride / 2) / height) * 2 - 1;
        v.set(ndcX * halfW, ndcY * halfH, -depth).applyMatrix4(camera.matrixWorld);
        positions.push(v.x, v.y, v.z);
        // 描き込みはアルファを掛けた色なので戻す
        const inv = 1 / a;
        colors.push(DataUtils.fromHalfFloat(pixels[i]) * inv, DataUtils.fromHalfFloat(pixels[i + 1]) * inv, DataUtils.fromHalfFloat(pixels[i + 2]) * inv, Math.min(1, a));
        seeds.push(Math.random(), Math.random(), Math.random(), Math.random());
        const fromTop = maxRow > minRow ? (maxRow - y) / (maxRow - minRow) : 0;
        starts.push(START_SPREAD * (0.6 * fromTop + 0.4 * Math.random()));
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 4));
    geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 4));
    geometry.setAttribute('aStart', new THREE.Float32BufferAttribute(starts, 1));
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uProgress: { value: 0 },
        uSize: { value: pixelWorld * stride * 1.15 },
        uRise: { value: 2.2 },
        uScreenScale: { value: 1 },
        uTarget: { value: destination?.clone() ?? new THREE.Vector3() },
        uHasTarget: { value: destination ? 1 : 0 },
        uArc: { value: destination ? THREE.MathUtils.clamp(destination.distanceTo(depthPoint) * 0.18, 0.3, 2.5) : 0 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    const points = new THREE.Points(geometry, material);
    points.name = 'MistDissolve';
    points.frustumCulled = false;
    points.renderOrder = 3;
    scene.add(points);
    return new MistDissolve(points, material);
  }

  /** 進み（0〜1）と、描画先の高さ（ピクセル）・カメラの画角から粒の大きさを決める */
  update(progress: number, camera: THREE.PerspectiveCamera, drawingHeight: number): void {
    this.material.uniforms.uProgress.value = progress;
    this.material.uniforms.uScreenScale.value = drawingHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2));
    this.points.visible = progress < 1;
  }

  dispose(): void {
    this.points.removeFromParent();
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
