import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import type { LocationTransmittedLight } from '../schema/visual';

const fullscreenVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/** 広がりの既定（画面の高さに対する比） */
const DEFAULT_RADIUS = 0.07;
/** フレアのぼかしを重ねる回数（1回ごとに歩幅を倍にして、芯の際から裾までを作る） */
const BLUR_ROUNDS = 4;

/**
 * 透過光（アニメの撮影処理）。
 *
 * 撮影では、光らせたい所だけを抜いた白黒のマスクを用意し、そのマスクに光（フレア）を付けて絵に重ねる。
 * 明るさで自動的に拾うのではなく「ここが光源」と決めた所だけが光るのが、ブルームとの違い。
 * 光は中心色（白っぽい芯）と周辺色（色の付いたフレア）に分ける。
 *
 * ここでは、場所に登録した光源（窓・街灯・画面などの位置と大きさ）を板として描いてマスクにする。
 * 板は本描画の深度で切り抜くので、手前の壁・窓枠・人物に隠れた所は光源にならない（窓の外に板を置けば、窓の形に抜ける）。
 * フレアは隠れた所にもあふれ、人物の縁まで光が回る。リニア空間で行う（OutputPass より前に置く）。
 */
export class TransmittedLightPass extends Pass {
  private strength = 0;
  private radius = DEFAULT_RADIUS;
  private readonly lightScene = new THREE.Scene();
  private readonly plane = new THREE.PlaneGeometry(1, 1);
  private readonly shared = {
    tDepth: { value: null as THREE.Texture | null },
    uTargetSize: { value: new THREE.Vector2(1, 1) },
    uNearFar: { value: new THREE.Vector2(0.1, 100) },
    /** 0 = 周辺色（フレアの元）、1 = 中心色（芯） */
    uCore: { value: 0 },
  };
  private readonly flareA = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private readonly flareB = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private readonly coreA = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private readonly coreB = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private readonly blurMaterial: THREE.ShaderMaterial;
  private readonly compositeMaterial: THREE.ShaderMaterial;
  private readonly quad = new FullScreenQuad();
  private readonly clearColor = new THREE.Color();

  constructor(private readonly camera: THREE.PerspectiveCamera, sceneDepth: THREE.Texture) {
    super();
    this.enabled = false;
    this.shared.tDepth.value = sceneDepth;

    // 9タップのガウスぼかし（縦横に分けて使う）
    this.blurMaterial = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: { tDiffuse: { value: null }, uStep: { value: new THREE.Vector2() } },
      vertexShader: fullscreenVertex,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform vec2 uStep;
        varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tDiffuse, vUv).rgb * 0.2270;
          c += (texture2D(tDiffuse, vUv + uStep * 1.3846).rgb + texture2D(tDiffuse, vUv - uStep * 1.3846).rgb) * 0.3162;
          c += (texture2D(tDiffuse, vUv + uStep * 3.2308).rgb + texture2D(tDiffuse, vUv - uStep * 3.2308).rgb) * 0.0703;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    });

    this.compositeMaterial = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: null },
        tFlare: { value: this.flareB.texture },
        tCore: { value: this.coreA.texture },
        uStrength: { value: 0 },
      },
      vertexShader: fullscreenVertex,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform sampler2D tFlare;
        uniform sampler2D tCore;
        uniform float uStrength;
        varying vec2 vUv;
        void main() {
          vec4 base = texture2D(tDiffuse, vUv);
          vec3 flare = texture2D(tFlare, vUv).rgb * uStrength;
          vec3 core = texture2D(tCore, vUv).rgb * uStrength;
          // フレアは下の絵を残して重ねる（スクリーン合成に近い足し方）。芯はそのまま足して白く飛ばす
          vec3 lit = clamp(base.rgb, 0.0, 1.0);
          gl_FragColor = vec4(base.rgb + flare * (1.0 - lit * 0.5) + core, base.a);
        }
      `,
    });
  }

  /**
   * 場所の光源を置き直す。timeOfDay は今の時間帯（時間帯を限った光源を出し分ける）、multiplier はカット単位の強さの倍率。
   * 光源がない・強さが 0 のときはパスごと切る
   */
  setLights(config: LocationTransmittedLight | undefined, timeOfDay: string, multiplier = 1): void {
    for (const child of [...this.lightScene.children]) {
      this.lightScene.remove(child);
      ((child as THREE.Mesh).material as THREE.Material).dispose();
    }
    const lights = (config?.lights ?? []).filter((light) => !light.timeOfDay || (light.timeOfDay as string[]).includes(timeOfDay));
    this.strength = lights.length > 0 ? (config?.strength ?? 1) * multiplier : 0;
    this.radius = config?.radius ?? DEFAULT_RADIUS;
    this.enabled = this.strength > 0;
    if (!this.enabled) return;

    for (const light of lights) {
      const material = new THREE.ShaderMaterial({
        depthTest: false,
        depthWrite: false,
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
          ...this.shared,
          uCenterColor: { value: new THREE.Color(light.centerColor ?? '#ffffff') },
          uEdgeColor: { value: new THREE.Color(light.edgeColor) },
          uLevel: { value: light.strength ?? 1 },
          uEllipse: { value: light.shape === 'ellipse' ? 1 : 0 },
          uFeather: { value: light.feather ?? 0.1 },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          varying float vViewZ;
          void main() {
            vUv = uv;
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            vViewZ = -mvPosition.z;
            gl_Position = projectionMatrix * mvPosition;
          }`,
        fragmentShader: /* glsl */ `
          #include <packing>
          uniform sampler2D tDepth;
          uniform vec2 uTargetSize;
          uniform vec2 uNearFar;
          uniform float uCore;
          uniform vec3 uCenterColor;
          uniform vec3 uEdgeColor;
          uniform float uLevel;
          uniform float uEllipse;
          uniform float uFeather;
          varying vec2 vUv;
          varying float vViewZ;
          void main() {
            // 手前に物（壁・窓枠・人物）がある所は光源にしない
            float sceneZ = -perspectiveDepthToViewZ(texture2D(tDepth, gl_FragCoord.xy / uTargetSize).r, uNearFar.x, uNearFar.y);
            if (vViewZ > sceneZ + 0.03) discard;
            // 形（四角・楕円）。縁は feather の幅でぼかす
            vec2 p = abs(vUv - 0.5) * 2.0;
            float d = mix(max(p.x, p.y), length(p), uEllipse);
            float shape = 1.0 - smoothstep(1.0 - max(uFeather, 0.001), 1.0, d);
            gl_FragColor = vec4(mix(uEdgeColor, uCenterColor, uCore) * shape * uLevel, shape);
          }`,
      });
      const mesh = new THREE.Mesh(this.plane, material);
      mesh.position.fromArray(light.position);
      mesh.scale.set(light.size[0], light.size[1], 1);
      // 向きの指定がなければ、毎フレーム カメラへ向ける（街灯・提灯など）
      if (light.rotationY === undefined) mesh.userData.billboard = true;
      else mesh.rotation.y = THREE.MathUtils.degToRad(light.rotationY);
      mesh.frustumCulled = false;
      this.lightScene.add(mesh);
    }
  }

  setSize(width: number, height: number): void {
    const half = [Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2))] as const;
    const quarter = [Math.max(1, Math.round(width / 4)), Math.max(1, Math.round(height / 4))] as const;
    this.coreA.setSize(...half);
    this.coreB.setSize(...half);
    this.flareA.setSize(...quarter);
    this.flareB.setSize(...quarter);
  }

  render(renderer: THREE.WebGLRenderer, write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget): void {
    for (const mesh of this.lightScene.children) if (mesh.userData.billboard) mesh.quaternion.copy(this.camera.quaternion);
    this.shared.uNearFar.value.set(this.camera.near, this.camera.far);

    // 1. 光源のマスクを描く（芯は 1/2、フレアの元は 1/4 の解像度）
    renderer.getClearColor(this.clearColor);
    const clearAlpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    const drawLights = (target: THREE.WebGLRenderTarget, core: number) => {
      this.shared.uCore.value = core;
      this.shared.uTargetSize.value.set(target.width, target.height);
      renderer.setRenderTarget(target);
      renderer.render(this.lightScene, this.camera);
    };
    drawLights(this.coreA, 1);
    drawLights(this.flareB, 0);
    renderer.setClearColor(this.clearColor, clearAlpha);
    renderer.autoClear = autoClear;

    const blur = (source: THREE.WebGLRenderTarget, temp: THREE.WebGLRenderTarget, out: THREE.WebGLRenderTarget, stepPx: number) => {
      this.quad.material = this.blurMaterial;
      this.blurMaterial.uniforms.tDiffuse.value = source.texture;
      this.blurMaterial.uniforms.uStep.value.set(stepPx / temp.width, 0);
      renderer.setRenderTarget(temp);
      this.quad.render(renderer);
      this.blurMaterial.uniforms.tDiffuse.value = temp.texture;
      this.blurMaterial.uniforms.uStep.value.set(0, stepPx / out.height);
      renderer.setRenderTarget(out);
      this.quad.render(renderer);
    };

    // 2. 芯は縁を少しだけ和らげる
    blur(this.coreA, this.coreB, this.coreA, 1);
    blur(this.coreA, this.coreB, this.coreA, 2);

    // 3. フレアは歩幅を倍々にして大きくぼかす。合計の広がりが radius（画面の高さ比）になるように最初の歩幅を決める
    let stepPx = Math.max(0.5, (this.radius * this.flareA.height) / (3.2308 * (2 ** BLUR_ROUNDS - 1)));
    for (let i = 0; i < BLUR_ROUNDS; i++) {
      blur(this.flareB, this.flareA, this.flareB, stepPx);
      stepPx *= 2;
    }

    // 4. 元の絵に重ねる
    this.compositeMaterial.uniforms.tDiffuse.value = read.texture;
    this.compositeMaterial.uniforms.uStrength.value = this.strength;
    this.quad.material = this.compositeMaterial;
    renderer.setRenderTarget(this.renderToScreen ? null : write);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.setLights(undefined, '');
    this.plane.dispose();
    this.flareA.dispose();
    this.flareB.dispose();
    this.coreA.dispose();
    this.coreB.dispose();
    this.blurMaterial.dispose();
    this.compositeMaterial.dispose();
    this.quad.dispose();
  }
}
