/**
 * 生地の硬さと重さ。布の曲げにくさは、生地の実測値（単位つき）で持つ。
 *
 * ほかの布シミュレーション（Maya nCloth・Houdini Vellum・Marvelous Designer・Blender）と同じく、生地ごとに
 * 「曲げ剛性」と「面積あたりの重さ」を持つ。単位のない値は、メッシュの細かさやモデルの大きさで効き方が変わるので使わない。
 *
 * - bending：曲げ剛性 B（N·m。幅 1m の布を曲率 1/m に曲げるのに要る曲げモーメント）。Kawabata の測定器（KES-FB2）の
 *   値（gf·cm²/cm）は × 9.80665e-5 で N·m になる
 * - weight：面積あたりの重さ（kg/m²）。KES の値（mg/cm²）は × 0.01 で kg/m² になる
 *
 * 2 つの比から、曲げ長さ c = (B / (weight × 9.8))^(1/3) が決まる（Peirce 1930。布の帯を水平に突き出したとき、どこまで
 * 垂れずに保てるかの目安。ASTM D1388 の曲げ硬さ試験と同じ考え方）。
 *
 * - tensile：引っ張り。Kawabata の引っ張り試験（KES-FB1。最大荷重 Fm = 500 gf/cm = 490 N/m まで引く）の
 *   LT（荷重と伸びの曲線の直線性）と WT（引っ張りの仕事、gf·cm/cm²）。伸びの上限 EMT（最大荷重での伸び）は
 *   EMT = 2 WT / (LT Fm) で決まる（WT = LT × Fm × EMT / 2 が LT の定義）。上着の布（knit.ts）が使う
 *
 * 使い方：`fabricOf('suiting')` か、値を直接 `{ bending, weight, tensile }` で渡す。
 */

export interface FabricTensile {
  /** 荷重と伸びの曲線の直線性（KES の LT。1 = 直線、小さいほど伸び始めが柔らかい） */
  linearity: number;
  /** 最大荷重まで引く仕事（KES の WT、gf·cm/cm²） */
  energy: number;
}

export interface Fabric {
  /** 曲げ剛性（N·m） */
  bending: number;
  /** 面積あたりの重さ（kg/m²） */
  weight: number;
  /** 引っ張りの実測値（上着の布に要る。吊る布は伸びない布として解く） */
  tensile?: FabricTensile;
}

export interface FabricPreset extends Fabric {
  /** 表示名 */
  label: string;
  /** 値の出どころ */
  source: string;
}

/** KES の曲げ剛性（gf·cm²/cm）→ N·m */
export const kesBending = (gfCm2PerCm: number): number => gfCm2PerCm * 9.80665e-5;
/** KES の重さ（mg/cm²）→ kg/m² */
export const kesWeight = (mgPerCm2: number): number => mgPerCm2 * 0.01;

const RAMAIAH = 'Ramaiah, Radhalakshmi, Nachane「Comparative Analysis of Low-Stress Mechanical Properties of Woven and Knitted Apparel Fabrics」（fibre2fashion）表 3。綿 100%（B はポリウレタン 5%）、染色のみで仕上げ加工なし';

/**
 * 実測値のある生地。いまの出どころは綿の 4 種だけ。
 * ブレザー・コートは前身ごろや襟に芯地を貼るので、スーツ地そのものより硬い（芯地の値はまだ入れていない）
 */
export const FABRICS = {
  /** 天竺ニット（肌着） */
  jersey: { label: '天竺ニット（肌着）', bending: kesBending(0.0066), weight: kesWeight(12.55), tensile: { linearity: 0.632, energy: 32.78 }, source: RAMAIAH },
  /** 天竺ニット（外衣。ポリウレタン 5%） */
  jerseyOuter: { label: '天竺ニット（外衣）', bending: kesBending(0.0162), weight: kesWeight(15.86), tensile: { linearity: 0.849, energy: 6.72 }, source: RAMAIAH },
  /** 平織りのシャツ地 */
  shirting: { label: 'シャツ地（平織り）', bending: kesBending(0.027), weight: kesWeight(12.52), tensile: { linearity: 0.597, energy: 9.91 }, source: RAMAIAH },
  /** 平織りのスーツ地（ボトム用） */
  suiting: { label: 'スーツ地（平織り）', bending: kesBending(0.1249), weight: kesWeight(24.6), tensile: { linearity: 0.667, energy: 10.5 }, source: RAMAIAH },
} satisfies Record<string, FabricPreset>;

export type FabricName = keyof typeof FABRICS;

/** 生地の指定：名前か、値そのもの */
export type FabricSpec = FabricName | Fabric;

export function fabricOf(spec: FabricSpec): Fabric {
  if (typeof spec !== 'string') return spec;
  const preset = FABRICS[spec];
  if (!preset) throw new Error(`知らない生地: ${spec}（${Object.keys(FABRICS).join(' / ')}）`);
  return preset;
}

/** KES の引っ張り試験の最大荷重（500 gf/cm、N/m） */
export const KES_MAX_LOAD = 500 * 9.80665e-3 / 0.01;

/**
 * 引っ張りの曲線：幅 1m あたりの張力（N/m）が伸び ε に対して Fm (ε / EMT)^p。p は曲線の下の面積が LT × Fm × EMT / 2
 * になる指数（p = 2 / LT - 1。LT = 1 で直線、LT が小さいほど伸び始めが柔らかい）。
 * 返すのは EMT（最大荷重での伸び、比）と p。引っ張りの値がない生地は null
 */
export function tensileCurve(fabric: Fabric): { emt: number; power: number } | null {
  const t = fabric.tensile;
  if (!t) return null;
  // WT（gf·cm/cm²）÷ Fm（gf/cm）は伸び（比）の単位になる
  return { emt: (2 * t.energy) / (t.linearity * 500), power: 2 / t.linearity - 1 };
}

/** 曲げ長さ（m） */
export const bendingLength = (fabric: Fabric): number => Math.cbrt(fabric.bending / (fabric.weight * 9.80665));
