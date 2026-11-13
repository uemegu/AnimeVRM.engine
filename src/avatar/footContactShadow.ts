import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';

let sharedTexture: THREE.CanvasTexture | null = null;
let sharedGeometry: THREE.PlaneGeometry | null = null;

function getSharedTexture(): THREE.CanvasTexture {
  if (sharedTexture) return sharedTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const half = size / 2;
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0.0, 'rgba(0, 0, 0, 1.0)');
  grad.addColorStop(0.55, 'rgba(0, 0, 0, 0.45)');
  grad.addColorStop(1.0, 'rgba(0, 0, 0, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  sharedTexture = new THREE.CanvasTexture(canvas);
  sharedTexture.colorSpace = THREE.SRGBColorSpace;
  return sharedTexture;
}

function getSharedGeometry(): THREE.PlaneGeometry {
  if (sharedGeometry) return sharedGeometry;
  sharedGeometry = new THREE.PlaneGeometry(0.32, 0.32);
  sharedGeometry.rotateX(-Math.PI / 2);
  return sharedGeometry;
}

/**
 * キャラの左右の足元に置く薄い接地影（コンタクトシャドウ）。
 * 平行光のシャドウマップを補い、足が地面から浮いて見えるのを防ぐ。
 * 足が床から離れる（歩き・ジャンプ・着席）と自動で薄くなり消える。
 */
export class FootContactShadow {
  private readonly leftMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly rightMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly footPos = new THREE.Vector3();

  constructor(private readonly scene: THREE.Scene) {
    const tex = getSharedTexture();
    const geom = getSharedGeometry();
    const makeMat = () =>
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      });

    this.leftMesh = new THREE.Mesh(geom, makeMat());
    this.rightMesh = new THREE.Mesh(geom, makeMat());
    this.leftMesh.name = 'FootContactShadowL';
    this.rightMesh.name = 'FootContactShadowR';
    this.leftMesh.renderOrder = 1;
    this.rightMesh.renderOrder = 1;
    this.scene.add(this.leftMesh, this.rightMesh);
  }

  public update(vrm: VRM, visible: boolean, floorY: number, isRaining: boolean): void {
    if (!visible) {
      this.leftMesh.visible = false;
      this.rightMesh.visible = false;
      return;
    }

    const maxOpacity = isRaining ? 0.1 : 0.2;
    const shadowY = floorY + 0.026;
    this.updateFoot(vrm.humanoid?.getNormalizedBoneNode('leftFoot') ?? null, this.leftMesh, floorY, shadowY, maxOpacity);
    this.updateFoot(vrm.humanoid?.getNormalizedBoneNode('rightFoot') ?? null, this.rightMesh, floorY, shadowY, maxOpacity);
  }

  private updateFoot(
    bone: THREE.Object3D | null,
    mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>,
    floorY: number,
    shadowY: number,
    maxOpacity: number
  ): void {
    if (!bone) {
      mesh.visible = false;
      return;
    }
    bone.getWorldPosition(this.footPos);
    const height = this.footPos.y - floorY;
    // 接地時（足首ボーン高さ ~0.08m）は濃く、0.14m〜0.32m で消える
    const factor = 1 - THREE.MathUtils.smoothstep(height, 0.14, 0.32);
    if (factor <= 0.01) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    mesh.position.set(this.footPos.x, shadowY, this.footPos.z);
    mesh.material.opacity = maxOpacity * factor;
  }

  public dispose(): void {
    this.scene.remove(this.leftMesh, this.rightMesh);
    this.leftMesh.material.dispose();
    this.rightMesh.material.dispose();
  }
}
