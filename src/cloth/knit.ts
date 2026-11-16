// @ts-nocheck
// The knit top as cloth: 360toAvator's examples/vrm-face-viewer/knit/vrm-knit.js (2026-11-14) brought over as it is, with
// only its imports, the way the mesh is named and the attributes the engine's passes read changed. Not typed yet.
// A knit top of a VRM as cloth that stays on the body (2026-11-13, w8's V-neck knit). Unlike the skirt (skirt/vrm-skirt.js),
// which is held at the waist and hangs, a top rests on the shoulders and arms, so nothing is pinned. Every point has
//   a target   where the bones (and MHR's correctives) put it now, the fitted shape, and
//   a leash    how far it may be from that target.
// Inside the leash it is free: gravity, stretch and bend against its neighbours, the body pushing it out, the skirt under
// the hem. The leash is short where the knit lies on skin that faces up (shoulders, the top of the arms) and at the cuffs,
// and grows with the distance along the fabric from there (the neckline, the chest, the underside of the sleeves, the
// hem): leaning forward lets the front of the neck hang away from the chest, while the shoulders stay fitted. It cannot
// fall off or blow up; it also cannot be taken off.
// Pulling: the pinched points follow the pointer, the fabric around them stretches (the edges give: a knit) and, while
// held, the leash around the pinch is lengthened; let go, it comes back over a moment.
//
// Only some of the knit's points are simulated (2026-11-13, 「軽くして」): samples about `spacing` apart along the fabric, joined
// to the samples of the neighbouring patches. Every vertex of the mesh is then its own target plus the offsets of the few
// samples nearest to it along the fabric, blended. (All 4,800 points: 14.5 ms a frame, half in the edges, half in the body.)
//
//   const knit = createVrmKnit(vrm, { part: 'knit', bodyFilter, corr });   in the rest pose
//   each frame, after the pose is final and after the skirt's update:   knit.update(dt, skirt)   (or knit.settle())
import * as THREE from 'three';
import { describeParts } from './parts';
import { weld, capRims, buildSDF } from './sdf';
import { fabricHinges, solveHinges } from './solver';
import { fabricOf } from './fabric';

const PIECE_BONES = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm',
  'leftLowerArm', 'rightLowerArm', 'leftUpperLeg', 'rightUpperLeg'];
function to12(m4, out) {
  const e = m4.elements;
  out[0] = e[0]; out[1] = e[4]; out[2] = e[8]; out[3] = e[12];
  out[4] = e[1]; out[5] = e[5]; out[6] = e[9]; out[7] = e[13];
  out[8] = e[2]; out[9] = e[6]; out[10] = e[10]; out[11] = e[14];
  return out;
}
function inv12(m, out) {
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, q = 1 / (a * A + b * B + c * C);
  const r0 = A * q, r1 = (c * h - b * i) * q, r2 = (b * f - c * e) * q, r3 = B * q, r4 = (a * i - c * g) * q, r5 = (c * d - a * f) * q;
  const r6 = C * q, r7 = (b * g - a * h) * q, r8 = (a * e - b * d) * q;
  out[0] = r0; out[1] = r1; out[2] = r2; out[3] = -(r0 * m[3] + r1 * m[7] + r2 * m[11]);
  out[4] = r3; out[5] = r4; out[6] = r5; out[7] = -(r3 * m[3] + r4 * m[7] + r5 * m[11]);
  out[8] = r6; out[9] = r7; out[10] = r8; out[11] = -(r6 * m[3] + r7 * m[7] + r8 * m[11]);
}
// shortest distance along the edges from the points in `from` (stops at `limit`)
function geodesic(n, adj, adjLen, from, limit = Infinity) {
  const dist = new Float64Array(n).fill(Infinity), src = new Int32Array(n).fill(-1), heap = [];
  const push = (d, i) => { heap.push([d, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } }
    return top;
  };
  for (const i of from) { dist[i] = 0; src[i] = i; push(0, i); }
  while (heap.length) {
    const [d, i] = pop();
    if (d > dist[i] || d > limit) continue;
    for (let e = 0; e < adj[i].length; e++) { const j = adj[i][e], nd = d + adjLen[i][e]; if (nd < dist[j]) { dist[j] = nd; src[j] = src[i]; push(nd, j); } }
  }
  dist.src = src;
  return dist;
}

// part: the mesh (or its mesh or material name) to make cloth; bodyFilter(part): whether a part of the model is the body the
// knit lies on. Both have to be given (no default names: they were MHR's 'knit' and 'Human.body'). createVrmGarments
// (vrm.ts) gives the mesh and the parts of the model that are not cloth and not carried by spring bones.
export function createVrmKnit(vrm, { part, bodyFilter, corr = null, opts = {} } = {}) {
  if (!part || !bodyFilter) throw new Error('createVrmKnit: part と bodyFilter を指定する');
  const o = {
    substeps: 8, gravity: -9.8,
    sleeveSide: true, sleeveReach: 0.2, sleeveTurn: -0.2, sleeveOut: 0.05, sleeveSound: 0.6,   // see "a sleeve stays around its arm"
    headFriction: 0,     // against the head and the neck the fabric slides freely: with the body's friction the front of a top turned over
                         // stayed on the chin, and only its back hung down behind the head
    tubeTurn: 0.5,       // a trunk point stays within 60 degrees of its own side: at 100 (the sleeves' limit) the whole ring could lie behind
                         // the head with its front points just past the sides, and did
    riseKeep: 0.05, riseBack: 0.8, riseUpright: 0.5, riseFrom: 0.45,   // see "back down once the body is upright again"
    armsInward: true,    // The trunk's fabric is pushed off an arm toward the body's middle, never to the arm's far side. With the arms
                         // raised a ring of the trunk can only go on toward the head around both arms (as a T-shirt comes off), and
                         // it is too short: solved truly, the top jams at the shoulders with its edges at their limit. What the user
                         // asked for (「スカートみたいな感じで捲れ上がらないと変」, and of a run where it hung over the head between the
                         // arms: 「これで顔と腕の貫通がなければ完璧」) is the tube between the arms; the fabric then crosses the arm only
                         // in the armpit, out of sight.
    tubeGuide: 0,        // the round post's radius (m). Off: at 0.115 it shook the top in the handstand's hold (95% point 4-6 mm against 1.3) and the front fell without it once the trunk went between the arms
    tubeSide: true, tubePast: 0.22, tubeOut: 0.09, tubeBack: true,   // tubeBack: a point that crossed goes back to its own side (false: only to the limit)
    tube: true, tubeStep: 0.05, tubeAround: 12, tubeKeep: 0.55, tubeStiff: 0.5, tubeBelowArms: 0.03,   // see "the body of the top keeps its tube"
    edgeSoft: 0.35,      // the share of the way out a middle is moved in one pass against the trunk, neck and head (all of it: shaking)
    edgeNear: 0.08, edgeMoved: 0.03, edgeEvery: 2,   // every 2nd substep (the last one included)
    edgeAll: false,      // true: the middles of the edges and faces are kept outside every piece of the body, not only the arms. Upside
                         // down the top's faces cut across the chest and the sides (「体を貫通するのをどうにかできない？」), and with this the
                         // trunk's vertices with fabric under them go from 2-16% to 0.1-1% (standing: 0.4%). Off, because in 3 runs of 4
                         // the top then shook 9-12 mm (95% point) in the handstand's hold against 4; softer pushes (edgeSoft) and
                         // pushes without speed did not cure it. Not used while the chest is upright either way.
    edgeFull: false,
    edgeLimbs: true,     // the middle of every edge and of every face is kept outside the arms, not only the points: a sleeve drawn
                         // with faces wider than the arm is thick went through it with a point on either side (upside down both arms
                         // were outside their sleeves). Keeping the points further from the arms by what such a face needs was
                         // tried first and changed nothing: a sleeve lies on its arm as fitted, and that distance is the limit.
    piecesForAll: true,  // every point is tested against every piece of the body: upside down the hem travels to the chest and the
                         // arms, which it is nowhere near as fitted (the arms came through the top in a handstand). With this the top
                         // catches on the shoulders and the head by itself. A wall at the shoulders' height was tried for 「肩で止める」
                         // and taken out: it held the fabric back against the sleeves, which go with the raised arms (34-41% of the
                         // edges at their limit, the top shaking 4-7 mm in the handstand's hold against 0.7)
    armsForAll: true,    // every point is tested against the arms too (the body of a top that falls over them upside down)
    headForAll: true,    // every point is tested against the head and neck, not only the ones near them as fitted
    viscosity: 300,      // 1/s: how fast a point's speed goes to its neighbours' mean
    rigStretch: 1.25,    // how much longer than fitted (with ease) the bones may make an edge
    inertia: 1,
    noSkin: false, noPieces: false,   // for finding causes: the skin planes / the rigid pieces off
    contactIters: 3,     // with stretchIters 1: one pass of the edges, then hang and skin, three times
    skinReach: 0.05,     // a point that has moved this far along the skin from where it lay over its body vertex as fitted stops using
                         // that vertex's plane (fading out over the next 3 cm: switched off at once, the loose shoulders of a wide top
                         // crossed the line back and forth standing still)
    stretch: 0,          // compliance of the edges (with 3e-7 and two passes a step the knit hung 5% longer than it is)
    ease: 1.2,           // edges running around the body may be this much longer than in the fitted mesh: the knit's looseness
                         // (how far it gives; it is pushed back out only when shorter than fitted: see LSc).
                         // What gravity can do is set by this: the fitted knit is a snug tube, and at 1.08 on every edge the front
                         // could hang 7 cm at the hem bent forward 80 degrees (2.7 cm standing) however the other limits were set
    neckBoth: true,      // true: only edges with both ends that near the rim are taut (the rim's own line), not the ones leading away from it
    neckTaut: 0.011,
    sit: 0.006,          // where the knit is carried (a short leash, skin facing up under it) it lies this far over the skin
    sitReach: -1,        // ...fading out as the leash grows by this much. Off (-1) by default: tried at 0.03, the collar's gap from the
                         // drawn skin did not shrink (median 8.4 -> 7.2 mm, 90% point 21 mm both) and skin showed at the armpits
                         // and shoulders. The floating collar was the fit's doing (fit_knit.py NECK_UP_MM) and is put right there.
    easeAlong: 1.03,     // ...for edges along the trunk or a sleeve; `ease` is for edges around them
    armFrom: 0.17,       // |x| beyond which an edge is on a sleeve (rest pose)
    spacing: 0.022,      // metres between the simulated samples along the fabric (rims: 0.6 of it)
    fabric: 'jerseyOuter',   // the fabric (fabric.ts): its bending rigidity and weight set how the knit bends
    // the air, as on the skirt (solver.ts computeAero): per triangle of samples, pressure drag growing with the square of
    // the speed through the air along its normal, 0.5 * 1.2 kg/m3 * Cd 1.2 / the fabric's weight per area (drag: null takes
    // that), capped at maxAero m/s2. (Until 2026-11-16 the knit had no air at all: walking along, the front of a loose
    // T-shirt kept the shape it was modelled in, standing out from the belly, where the air presses it back.)
    drag: null, maxAero: 80,
    // a face on the body's lee (downstream of the air as the body meets it: the back of a top walking forward) sits in the
    // body's wake: of the air going past the body only this share reaches it, the rest moves along with the body. (The
    // skirt's `shield`, 0.3. Without it, walking forward blew the back of a T-shirt out behind as hard as it pressed the front.)
    shield: 0.3,
    minEdge: 0,     // points closer than this along an edge are merged (Tripo leaves sub-millimetre triangles: strain 400%, never at rest)
    maxStrain: 1.06,     // an edge never gets longer than this times its rest length...
    pullStrain: 1.4,     // ...except around a pinch while it is held: a knit gives
    stretchIters: 4,     // passes over the edges in each of the contactIters rounds. With one, the edges lost to the leash, the hang and
                         // the pieces, all kept exactly after them: in a breakdance the neck's rim, whose edges have no ease, was
                         // pulled out to twice its length (36 -> 70 cm, 105 cm at most) and stayed so, and the top hung off one
                         // shoulder with the skin and the strap under it showing. With four: 54 cm at most, back at once
                         // (2/3 passes: 80/70 cm). 1 ms more a step (2.4 -> 3.4 ms). `compress` is shared out over the passes.
    compress: 0.1,       // how much of an edge's shortening is undone (1: an edge keeps its length both ways, and the knit holds
                         // its fitted shape like a shell; from Codex's review, 2026-11-14)
    pieceLeash: 0,       // only points with a leash longer than this are tested against the rigid pieces (the others have their skin plane)
    piecesEvery: 1,      // the rigid pieces are tested every this many substeps (2: 10 ms a frame instead of 14, but points
                         // pushed out on one substep fall back on the next: fastest point 5-10 m/s standing still)
    seam: 0.004,         // rim points this close across a cut are stitched
    hang: 1.04,          // no point gets further from the support it hangs from than this times the way there along the fabric
                         // (edges alone, solved a few times a step, let the whole knit sag 8 cm: mean strain 6%)
    skinNear: 1,         // points with a leash shorter than this stay outside the real skin under them (see skin planes): all of them.
                         // (Only the fitted ones, 0.02: the rigid pieces let the armpits and the edge of the shoulders through.)
    margin: 0.004, friction: 0.6, damping: 8, maxSpeed: 5,
    leashMin: 0.003,     // on the shoulders and at the cuffs
    leashSlope: 2,       // metres of leash per metre along the fabric from there. 2 = as far as the fabric itself lets a point
                         // go from its place (hung from the carried point, swung right over), so away from the carried
                         // points the leash no longer decides anything: the hang, the edges and the body do.
    leashMax: 1,         // (0.5 and at most 0.2 until 2026-11-14: upside down the hem stopped at exactly 0.2 m)
    leashIn: 0.25,       // metres a second a leash shortens when its point comes to be carried again
    supportBelow: 0.035, // carried points are no lower than this under the upper arm joint in the rest pose (-1: anywhere)
    supportUp: 0.6,      // skin facing up at least this much (the normal's y) in the fitted mesh carries the knit
    supportOff: -0.3,    // ...until the piece of the body under it has turned so far that its up (the y of its rest pose) points this
                         // much down under the gravity of the moment: bent forward more than about 107 degrees, or upside down
    supportOut: 0.085,   // and at least this far from the middle: the shoulders and arms, not the chest under the neck
    hangOut: 0.085,      // the supports the knit hangs from are at least this far from the middle
    supportNear: 0.025,  // and the knit within this of it
    grabRadius: 0.035,   // what the fingers hold
    grabReach: 0.22,     // how far along the fabric a pinch lengthens the leash
    grabBoost: 0.16,     // by this much at the pinch
    grabReturn: 0.3,     // seconds for the lengthened leash to shorten again once let go (eased)
    calm: 80,            // extra damping (1/s) on the fabric around a pinch from the moment it is let go, fading over calmTime:
    calmTime: 0.6,       // a knit comes back without swinging (before: 5 swings of +-10 mm in 0.45 s, 「プルンプルンしすぎ」; now back to
                         // 4 mm in 0.28 s with one swing of 1 mm. calm 25: 3 swings, the first 6 mm; 60 with a 0.5 s return: 1 s to come back)
    rest: 0.03,         // a point slower than this (m/s) over a frame, against where the bones put it, stays where it was
                         // against the bones. (Standing still, 14% of the points turned back on themselves every other
                         // frame by up to 0.4 mm: gravity added and taken out again each substep. The white knit shimmered.)
    skirtGap: 0.006,     // the knit stays this far outside the skirt
    cell: 0.006,
    // sleep: with nothing moving the knit from outside it is brought to rest and then not simulated (as the skirt's
    // solver.ts does). Quiet: the targets the bones give do not change speed (quietAccel), no pinch, and the skirt under it
    // (when it sleeps at all) asleep too. After calmAfter seconds the damping grows by up to calmDamping, and the knit falls
    // asleep once its points are slower than sleepSpeed against their targets, or sleepAfter seconds after the quiet began
    // whatever they do. Asleep, every point keeps its offset from its target (breathing and the idle sway carry it). It
    // wakes when the targets change speed, a piece of the body has turned so far that the offsets of the points on it
    // would be wakeDist out (offsets are kept as they were in the world: a point hanging 1 cm off its target is 0.5 mm out
    // after its piece turned 3 degrees), or it is pinched. (Woken whenever any piece turned 3 degrees, the forearms and
    // shoulders of an idle motion woke it every 1-2 s: asleep 45-70% of the time.) The skirt waking does not wake it: the
    // skirt then mostly settles again after a slow shift of the weight, a few millimetres under the knit's hem.
    // Off (sleep: false) when it must keep moving with nothing driving it.
    quietAir: 0.3,      // m/s: the body carries the knit through the air no faster than this to be quiet (and no wind)
    sleep: true, quietAccel: 2, calmAfter: 0.3, sleepAfter: 1.2, sleepSpeed: 0.03, calmDamping: 12, wakeDist: 0.004,
    // With the body about still, the offsets from the targets die out at this rate (1/s; 0: not at all), so a knit at rest
    // comes to the fitted shape the bones give, as the model was made. The user: 「静止してなら揺れるな」. Standing still
    // with the arms down, the simulated blazer had drifted 29 mm on average from its targets (its lapels 0.1-1 m), and lay
    // there crumpled and open while the targets themselves were the blazer as modelled. At full rate below fitStill (m/s,
    // how fast the body carries the knit through the air), none from quietAir up, eased in and out over fitEase seconds.
    // It works on the knit awake, against everything else on it, and the knit falls asleep in the shape that comes to;
    // asleep the offsets are kept. (Asleep only, until 2026-11-16, they died out to nothing asleep, but awake the knit
    // came to rest a few millimetres off, or 15 mm held by `rest` after walking: each small turn of an arm woke it and it
    // swung back out. Standing still, the T-shirt swelled and shrank like breathing.)
    restToFit: 3, fitStill: 0.1, fitEase: 0.3,
    ...opts,
  };
  vrm.scene.updateMatrixWorld(true);
  let mesh = part?.isSkinnedMesh ? part : null;
  const matName = (m) => (Array.isArray(m.material) ? m.material[0] : m.material)?.name || '';
  vrm.scene.traverse((m) => { if (!mesh && m.isSkinnedMesh && (m.name === part || m.parent?.name === part || matName(m) === part)) mesh = m; });
  if (!mesh) throw new Error(`no skinned mesh named ${part}`);
  const skeleton = mesh.skeleton; skeleton.update();
  // Only the vertices this part's triangles use: a VRoid model's parts share one vertex buffer (body, hair, shoes, top), and
  // every vertex of it became a point of the knit (7,695 for a top of 1,226 triangles).
  const g0 = (() => {
    const src = mesh.geometry, I = src.index.array, remap = new Int32Array(src.attributes.position.count).fill(-1), used = [];
    for (let k = 0; k < I.length; k++) if (remap[I[k]] < 0) { remap[I[k]] = used.length; used.push(I[k]); }
    if (used.length === remap.length) return src;
    const g = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv', 'uv1', 'color', 'skinIndex', 'skinWeight']) {
      const a = src.attributes[name]; if (!a) continue;
      const arr = new a.array.constructor(used.length * a.itemSize);
      for (let q = 0; q < used.length; q++) for (let c = 0; c < a.itemSize; c++) arr[q * a.itemSize + c] = a.getComponent(used[q], c);
      g.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
    }
    g.setIndex(new THREE.BufferAttribute(Uint32Array.from(I, (v) => remap[v]), 1));
    return g;
  })();
  const nR = g0.attributes.position.count, index = g0.index.array;
  const bindPos = new Float64Array(nR * 3), skin = [];
  {
    const v = new THREE.Vector3(), P = g0.attributes.position;
    for (let i = 0; i < nR; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(mesh.bindMatrix); bindPos[i * 3] = v.x; bindPos[i * 3 + 1] = v.y; bindPos[i * 3 + 2] = v.z;
      const list = [];
      for (let k = 0; k < 4; k++) { const wt = g0.attributes.skinWeight.getComponent(i, k); if (wt > 0) list.push(g0.attributes.skinIndex.getComponent(i, k), wt); }
      skin.push(list);
    }
  }
  // where the rig puts render vertex r now (bones as they are). `corr(geometry)`: MHR's offsets for the fitted geometry's
  // vertices now (bind space, mhr-correctives.js's mhrCorr), or null
  let corrNow = null;
  function pose(r, out, k) {
    const bm = skeleton.boneMatrices, list = skin[r];
    let bx = bindPos[r * 3], by = bindPos[r * 3 + 1], bz = bindPos[r * 3 + 2];
    if (corrNow) { bx += corrNow[r * 3]; by += corrNow[r * 3 + 1]; bz += corrNow[r * 3 + 2]; }
    let x = 0, y = 0, z = 0;
    for (let q = 0; q < list.length; q += 2) {
      const e = list[q] * 16, wt = list[q + 1];
      x += wt * (bm[e] * bx + bm[e + 4] * by + bm[e + 8] * bz + bm[e + 12]);
      y += wt * (bm[e + 1] * bx + bm[e + 5] * by + bm[e + 9] * bz + bm[e + 13]);
      z += wt * (bm[e + 2] * bx + bm[e + 6] * by + bm[e + 10] * bz + bm[e + 14]);
    }
    out[k] = x; out[k + 1] = y; out[k + 2] = z;
  }

  // ---- points: the render vertices welded across UV seams, in the pose of the moment (the rest pose) ----
  const mapR = new Uint32Array(nR), repF = [];
  {
    const ids = new Map(), p = [0, 0, 0];
    for (let r = 0; r < nR; r++) {
      pose(r, p, 0);
      const key = `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)},${Math.round(p[2] * 1e5)}`;
      let id = ids.get(key);
      if (id === undefined) { id = repF.length; ids.set(key, id); repF.push(r); }
      mapR[r] = id;
    }
  }
  {   // merge points joined by an edge shorter than minEdge (the first of each group stands for it)
    const m = repF.length, P = new Float64Array(m * 3), par = Int32Array.from({ length: m }, (_, i) => i);
    for (let i = 0; i < m; i++) pose(repF[i], P, i * 3);
    const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
    for (let f = 0; f < index.length; f += 3) for (let k = 0; k < 3; k++) {
      // by the groups' first points, not the edge's ends: a chain of short edges must not fold a whole patch into one point
      // (it did, on the shoulders, where the fit packs the mesh: holes with the skin showing)
      const ra = find(mapR[index[f + k]]), rb = find(mapR[index[f + (k + 1) % 3]]);
      if (ra !== rb && Math.hypot(P[ra * 3] - P[rb * 3], P[ra * 3 + 1] - P[rb * 3 + 1], P[ra * 3 + 2] - P[rb * 3 + 2]) < o.minEdge) par[Math.max(ra, rb)] = Math.min(ra, rb);
    }
    const id = new Int32Array(m).fill(-1), rep2 = [];
    for (let i = 0; i < m; i++) { const r = find(i); if (id[r] < 0) { id[r] = rep2.length; rep2.push(repF[r]); } }
    for (let r = 0; r < nR; r++) mapR[r] = id[find(mapR[r])];
    repF.length = 0; repF.push(...rep2);
  }
  let nf, Xf0, Ff, nFf, d0, rimF, adjF, adjLenF, st;
  function buildMesh() {
    nf = repF.length;
    Xf0 = new Float64Array(nf * 3);
  for (let i = 0; i < nf; i++) pose(repF[i], Xf0, i * 3);
  const faces = [];
  for (let f = 0; f < index.length; f += 3) { const a = mapR[index[f]], b = mapR[index[f + 1]], c = mapR[index[f + 2]]; if (a !== b && b !== c && a !== c) faces.push(a, b, c); }
    Ff = new Uint32Array(faces); nFf = Ff.length / 3;
  const edge = new Map();
  for (let f = 0; f < nFf; f++) for (let k = 0; k < 3; k++) {
    const a = Ff[f * 3 + k], b = Ff[f * 3 + (k + 1) % 3], c = Ff[f * 3 + (k + 2) % 3], key = a < b ? a * 1e7 + b : b * 1e7 + a, e = edge.get(key);
    if (e) e[3] = c; else edge.set(key, [a, b, c, -1]);
  }
    d0 = (i, j) => Math.hypot(Xf0[i * 3] - Xf0[j * 3], Xf0[i * 3 + 1] - Xf0[j * 3 + 1], Xf0[i * 3 + 2] - Xf0[j * 3 + 2]);
    const cs = [], cb = []; rimF = new Uint8Array(nf); adjF = Array.from({ length: nf }, () => []); adjLenF = Array.from({ length: nf }, () => []);
  for (const [a, b, c, d] of edge.values()) {
    cs.push(a, b);
    const l = d0(a, b); adjF[a].push(b); adjLenF[a].push(l); adjF[b].push(a); adjLenF[b].push(l);
    if (d >= 0) cb.push(c, d); else { rimF[a] = 1; rimF[b] = 1; }
  }
  // ---- seams: Tripo's knit is cut open along its seams (sides, shoulders, armholes: one open rimF 4.6 m long, its two
  // sides 0.6 mm apart). As cloth the cuts opened (an L-shaped tear on each shoulder, the sides apart under the arms).
  // Every rimF point is stitched to the nearest rimF point across the cut (not one next to it along the rimF): a distance
  // kept at what it is at rest. The stitches also carry the distances along the fabric (leash, hang).
    st = [];
  {
    const rimPts = []; for (let i = 0; i < nf; i++) if (rimF[i]) rimPts.push(i);
    const seen = new Set();
    for (const a of rimPts) {
      const near = new Set([a]); let fr = [a];
      for (let hop = 0; hop < 4; hop++) { const nx = []; for (const b of fr) for (const c of adjF[b]) if (!near.has(c)) { near.add(c); nx.push(c); } fr = nx; }
      let best = -1, bd = o.seam;
      for (const b of rimPts) { if (near.has(b)) continue; const d = d0(a, b); if (d < bd) { bd = d; best = b; } }
      if (best < 0) continue;
      const key = a < best ? a * 1e7 + best : best * 1e7 + a;
      if (seen.has(key)) continue;
      seen.add(key); st.push(a, best);
    }
    for (let k = 0; k < st.length; k += 2) { const a = st[k], b = st[k + 1], l = d0(a, b); adjF[a].push(b); adjLenF[a].push(l); adjF[b].push(a); adjLenF[b].push(l); }
  }
  }
  buildMesh();
  // The seams are cuts in Tripo's mesh (see above): the points on the two sides of a cut become one point, and the mesh is
  // built again, in one piece. (Stitching them with constraints held while every point was simulated; with samples the
  // vertices on the two sides follow different samples and the cut opened a little.)
  if (st.length) {
    const par = Int32Array.from({ length: nf }, (_, i) => i);
    const find = (q) => { while (par[q] !== q) { par[q] = par[par[q]]; q = par[q]; } return q; };
    for (let k = 0; k < st.length; k += 2) { const ra = find(st[k]), rb = find(st[k + 1]); if (ra !== rb) par[Math.max(ra, rb)] = Math.min(ra, rb); }
    const id = new Int32Array(nf).fill(-1), rep2 = [];
    for (let i = 0; i < nf; i++) { const r = find(i); if (id[r] < 0) { id[r] = rep2.length; rep2.push(repF[r]); } }
    for (let r = 0; r < nR; r++) mapR[r] = id[find(mapR[r])];
    repF.length = 0; repF.push(...rep2);
    const sewn = st.length / 2;
    buildMesh();
    console.log(`knit: ${sewn} seam stitches closed, ${st.length / 2} left`);
  }
  const openRim = Uint8Array.from(rimF); for (const q of st) openRim[q] = 0;   // rim points of the real openings (neck, cuffs, hem), not of a seam's cut
  // ---- the samples: what is simulated ----
  const sampleFine = [];
  {
    const dist = new Float64Array(nf).fill(Infinity), heap = [];
    const relax = (s0) => {   // lower `dist` around a new sample, out to the spacing
      dist[s0] = 0; heap.length = 0; heap.push([0, s0]);
      while (heap.length) {
        let bi = 0; for (let q = 1; q < heap.length; q++) if (heap[q][0] < heap[bi][0]) bi = q;
        const [d, i] = heap[bi]; heap[bi] = heap[heap.length - 1]; heap.pop();
        if (d > dist[i]) continue;
        for (let e = 0; e < adjF[i].length; e++) { const j = adjF[i][e], nd = d + adjLenF[i][e]; if (nd < dist[j] && nd < o.spacing) { dist[j] = nd; heap.push([nd, j]); } }
      }
    };
    for (const pass of [1, 0]) for (let i = 0; i < nf; i++) if (rimF[i] === pass && dist[i] >= (pass ? o.spacing * 0.6 : o.spacing)) { sampleFine.push(i); relax(i); }   // the rims first, closer together
  }
  const nc = sampleFine.length;
  // each point's patch (its nearest sample along the fabric), and the samples it follows: those within 2.2 spacings
  const patch = geodesic(nf, adjF, adjLenF, sampleFine).src, sIdx = new Int32Array(nf).fill(-1);
  sampleFine.forEach((f, c) => { sIdx[f] = c; });
  const follow = Array.from({ length: nf }, () => []);
  for (let c = 0; c < nc; c++) {
    const d = geodesic(nf, adjF, adjLenF, [sampleFine[c]], o.spacing * 2.2);
    for (let i = 0; i < nf; i++) if (d[i] < o.spacing * 2.2) follow[i].push([c, d[i]]);
  }
  const fI = new Int32Array(nf * 4).fill(-1), fW = new Float32Array(nf * 4);
  for (let i = 0; i < nf; i++) {
    let list = follow[i].sort((a, b) => a[1] - b[1]).slice(0, 4);
    if (!list.length) list = [[sIdx[patch[i]], 0]];
    let sum = 0; const ws = list.map(([, d]) => { const t = Math.max(0.02, 1 - d / (o.spacing * 2.2)); return t * t; });
    for (const w_ of ws) sum += w_;
    list.forEach(([c], q) => { fI[i * 4 + q] = c; fW[i * 4 + q] = ws[q] / sum; });
  }
  // the samples' own graph: two samples are joined when their patches touch
  const X0c = new Float64Array(nc * 3); sampleFine.forEach((f, c) => { X0c[c * 3] = Xf0[f * 3]; X0c[c * 3 + 1] = Xf0[f * 3 + 1]; X0c[c * 3 + 2] = Xf0[f * 3 + 2]; });
  const dc = (a, b) => Math.hypot(X0c[a * 3] - X0c[b * 3], X0c[a * 3 + 1] - X0c[b * 3 + 1], X0c[a * 3 + 2] - X0c[b * 3 + 2]);
  const adjC = Array.from({ length: nc }, () => []), adjLenC = Array.from({ length: nc }, () => []), csC = [], seenE = new Set();
  for (let i = 0; i < nf; i++) for (const j of adjF[i]) {
    const a = sIdx[patch[i]], b = sIdx[patch[j]]; if (a === b || a < 0 || b < 0) continue;
    const key = a < b ? a * 1e6 + b : b * 1e6 + a; if (seenE.has(key)) continue;
    seenE.add(key); csC.push(a, b); const l = dc(a, b); adjC[a].push(b); adjLenC[a].push(l); adjC[b].push(a); adjLenC[b].push(l);
  }
  // bending (2026-11-15; until then each sample kept its distance to a few samples two patches away, with a compliance of no
  // unit, the same for every top): the samples' own triangles, one wherever a fitted face has its three corners in three
  // patches, and on their inner edges the fabric's bending as in the skirt's solver (fabricHinges: Discrete Shells,
  // stiffness from the fabric's measured bending rigidity). Each sample weighs the fabric's weight times its patch's area.
  const fabric = fabricOf(o.fabric);
  const massC = new Float64Array(nc), triC = [], seenT = new Set();
  for (let f = 0; f < nFf; f++) {
    const p0 = Ff[f * 3], p1 = Ff[f * 3 + 1], p2 = Ff[f * 3 + 2];
    const ux = Xf0[p1 * 3] - Xf0[p0 * 3], uy = Xf0[p1 * 3 + 1] - Xf0[p0 * 3 + 1], uz = Xf0[p1 * 3 + 2] - Xf0[p0 * 3 + 2];
    const vx = Xf0[p2 * 3] - Xf0[p0 * 3], vy = Xf0[p2 * 3 + 1] - Xf0[p0 * 3 + 1], vz = Xf0[p2 * 3 + 2] - Xf0[p0 * 3 + 2];
    const A = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    const a = sIdx[patch[p0]], b = sIdx[patch[p1]], c = sIdx[patch[p2]];
    for (const q of [a, b, c]) if (q >= 0) massC[q] += A / 3 * fabric.weight;
    if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) continue;
    const key = [a, b, c].sort((m_, n_) => m_ - n_).join(',');
    if (seenT.has(key)) continue;
    seenT.add(key); triC.push(a, b, c);
  }
  for (let c = 0; c < nc; c++) if (!(massC[c] > 0)) massC[c] = 1e-6;
  const rimC = new Uint8Array(nc); sampleFine.forEach((f, c) => { rimC[c] = openRim[f]; });
  const CS = Uint32Array.from(csC), LS = Float64Array.from({ length: csC.length / 2 }, (_, k) => dc(csC[k * 2], csC[k * 2 + 1]));
  const { C: HC, T: HT, alphas: HA } = fabricHinges(X0c, triC, fabric.bending);
  const TC = Uint32Array.from(triC), dragK = o.drag ?? 0.72 / fabric.weight;
  const invMassC = Float64Array.from(massC, (m_) => 1 / m_);
  const ST = new Uint32Array(0), LST = new Float64Array(0);   // the seams are in the samples' graph already
  // from here on "points" are the samples
  const n = nc, X0 = X0c, rim = rimC, adj = adjC, adjLen = adjLenC, rep = sampleFine.map((f) => repF[f]);
  // ---- the body, cut into rigid pieces by bone, each a distance grid in its bone's space ----
  const pieceBones = PIECE_BONES.map((nm) => vrm.humanoid?.getRawBoneNode(nm)), pieceNames = PIECE_BONES.filter((_, k) => pieceBones[k]);
  const pb = pieceBones.filter(Boolean);
  const humanBones = new Set(Object.values(vrm.humanoid?.humanBones ?? {}).map((b) => b?.node).filter(Boolean));
  let minY = Infinity; for (let i = 0; i < n; i++) minY = Math.min(minY, X0[i * 3 + 1]);
  const cols = [];
  for (const body of describeParts(vrm.scene, new Set()).filter((p) => p.mesh !== mesh && bodyFilter(p))) {
    const bones = body.mesh.skeleton.bones;
    const pieceOf = bones.map((b) => { for (let q = b; q; q = q.parent) { const k = pb.indexOf(q); if (k >= 0) return k; if (humanBones.has(q)) return -1; } return -1; });
    const P = body.geometry.attributes.position.array, J = body.geometry.attributes.skinIndex, W = body.geometry.attributes.skinWeight, I = body.geometry.index.array;
    const tris = pb.map(() => []), sum = new Float64Array(pb.length);
    for (let f = 0; f < I.length; f += 3) {
      const a = I[f], b = I[f + 1], c = I[f + 2];
      if (Math.max(P[a * 3 + 1], P[b * 3 + 1], P[c * 3 + 1]) < minY - 0.15) continue;
      sum.fill(0);
      for (const v of [a, b, c]) for (let k = 0; k < 4; k++) { const q = pieceOf[J.getComponent(v, k)]; if (q >= 0) sum[q] += W.getComponent(v, k); }
      let best = -1;
      for (let q = 0; q < sum.length; q++) if (sum[q] > 0 && (best < 0 || sum[q] > sum[best])) best = q;
      if (best >= 0) tris[best].push(a, b, c);
    }
    const v = new THREE.Vector3(), inv = new THREE.Matrix4();
    for (let q = 0; q < pb.length; q++) {
      if (tris[q].length < 30) continue;
      inv.copy(pb[q].matrixWorld).invert();
      const pos = [], idx = [], id = new Map(), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (const t of tris[q]) {
        let i = id.get(t);
        if (i === undefined) {
          i = pos.length / 3; id.set(t, i);
          v.set(P[t * 3], P[t * 3 + 1], P[t * 3 + 2]).applyMatrix4(inv); pos.push(v.x, v.y, v.z);
          for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], v.getComponent(c)); max[c] = Math.max(max[c], v.getComponent(c)); }
        }
        idx.push(i);
      }
      const pad = 0.05, sdf = buildSDF(capRims(weld(pos, idx)), { min: min.map((m) => m - pad), max: max.map((m) => m + pad), cell: o.cell, band: 0.04 });
      const M = to12(pb[q].matrixWorld, new Float64Array(12)), col = { sdf, bone: pb[q], name: pieceNames[q], M, prev: M.slice(), cur: M.slice(), last: M.slice(), inv: new Float64Array(12), margin: new Float64Array(n) };
      inv12(M, col.inv);
      cols.push(col);
    }
  }
  for (const col of cols) {   // the same for every vertex of the mesh, for finePieces
    const m = col.inv; col.marginF = new Float32Array(nf);
    for (let i = 0; i < nf; i++) { const px = Xf0[i * 3], py = Xf0[i * 3 + 1], pz = Xf0[i * 3 + 2]; col.marginF[i] = col.sdf.sample(m[0] * px + m[1] * py + m[2] * pz + m[3], m[4] * px + m[5] * py + m[6] * pz + m[7], m[8] * px + m[9] * py + m[10] * pz + m[11]) - 0.0005; }
  }
  // how close each point is to each piece at rest (it is not pushed further out than that), and the skin under it
  const cand = Array.from({ length: n }, () => []);   // which pieces each point is tested against
  const g = [0, 0, 0], sdRest = new Float64Array(n).fill(1), upRest = new Float64Array(n), nearPiece = new Int16Array(n).fill(-1), gLoc = new Float64Array(n * 3);
  for (let q = 0; q < cols.length; q++) {
    const col = cols[q], m = col.inv, c = col.M;
    for (let i = 0; i < n; i++) {
      const px = X0[i * 3], py = X0[i * 3 + 1], pz = X0[i * 3 + 2];
      const sd = col.sdf.sample(m[0] * px + m[1] * py + m[2] * pz + m[3], m[4] * px + m[5] * py + m[6] * pz + m[7], m[8] * px + m[9] * py + m[10] * pz + m[11], g);
      col.margin[i] = Math.min(o.margin, sd - 0.0005);
      if (sd < 1) cand[i].push(q);   // inside the piece's grid in the rest pose (arms out): sleeves meet the arms, the body meets the trunk.
      // (Everything against the trunk and the arms: with the arms down they pushed the sides of the body out through the sleeves.)
      if (sd < sdRest[i]) { sdRest[i] = sd; upRest[i] = c[4] * g[0] + c[5] * g[1] + c[6] * g[2]; nearPiece[i] = q; gLoc.set(g, i * 3); }
    }
  }

  // ...and every point meets the head and the neck: upside down the whole top comes down over them, and tested only
  // against what it lay near as fitted, it went through the face
  if (o.headForAll) cols.forEach((c, q) => { if (/^(head|neck)$/.test(c.name)) for (let i = 0; i < n; i++) if (!cand[i].includes(q)) cand[i].push(q); });
  if (o.piecesForAll) cols.forEach((c, q) => { for (let i = 0; i < n; i++) if (!cand[i].includes(q)) cand[i].push(q); });
  if (o.armsForAll) cols.forEach((c, q) => { if (/(Upper|Lower)Arm$/.test(c.name)) for (let i = 0; i < n; i++) if (!cand[i].includes(q)) cand[i].push(q); });
  {   // the hem also meets the thighs
    const legs = cols.map((c, q) => (/UpperLeg/.test(c.name) ? q : -1)).filter((q) => q >= 0);
    for (let i = 0; i < n; i++) if (cand[i].some((q) => /hips|spine/.test(cols[q].name))) for (const q of legs) if (!cand[i].includes(q)) cand[i].push(q);
  }
  // ---- the leash: short on skin that faces up at shoulder height and at the cuffs, longer with the distance from there ----
  const armY = Math.min(...['leftUpperArm', 'rightUpperArm'].map((nm) => vrm.humanoid?.getRawBoneNode(nm)?.getWorldPosition(new THREE.Vector3()).y ?? Infinity));
  // What carries the knit is decided in the pose and under the gravity of the moment (supportNow): a point that lies on
  // skin facing up in the fitted mesh, out on the shoulders and arms, is carried until the part of the body under it has
  // turned over (supportOff: the piece's own up against the up of the moment). Upside down, or bent well past the
  // horizontal, only the cuffs are left and the knit falls as far as its fabric and the body let it.
  // (By each point's own skin normal instead, the front of the shoulders let go bent forward 80 degrees, where that skin
  // faces down: the belly's fabric drew the collar 2 cm toward the hips and laid the V's edge on the skin, its gap
  // 10 -> 5 mm. That held down to a threshold of -0.5; at -0.8 it was 9 mm again, but then little lets go upside down.) (Decided once in the rest pose, the shoulders kept the chest, neck and sleeves in place under a
  // gravity turned over: 0 / -2 / 1 mm of movement, and the hem stopped at leashMax.)
  // ...out on the shoulders and arms, not on the chest under the neck: once the fit laid the V's edge on the chest
  // (4 mm), that skin, facing up at the collarbones, carried it too, and bent forward it no longer left the body
  const canCarry = new Uint8Array(n), carried = new Uint8Array(n);   // canCarry: 1 while the skin faces up, 2 always (cuffs)
  for (let i = 0; i < n; i++) {
    const onTop = sdRest[i] < o.supportNear && upRest[i] > o.supportUp && Math.abs(X0[i * 3]) > o.supportOut && (o.supportBelow < 0 || X0[i * 3 + 1] > (Number.isFinite(armY) ? armY - o.supportBelow : -Infinity));
    const cuff = rim[i] && nearPiece[i] >= 0 && /LowerArm/.test(cols[nearPiece[i]].name);
    canCarry[i] = cuff ? 2 : onTop ? 1 : 0;
  }
  const support = [], leash = new Float64Array(n), leashT = new Float64Array(n), hangFrom = new Int32Array(n).fill(-1), hangLen = new Float64Array(n).fill(1e9), hangSlack = new Float64Array(n);
  let supportKey = -1;
  // What the knit hangs from (the limit on sagging) is the shoulders and arms only, not the carried points on the chest
  // under the neck: with those, the V's tip hung from a point 5 cm above it and, bent forward 80 degrees, could leave the
  // chest by 7 mm (its leash is 10 cm).
  function supportNow(first = false) {
    const upS = o.gravity <= 0 ? 1 : -1; let key = 0;
    for (let i = 0; i < n; i++) {
      if (canCarry[i] === 2) { carried[i] = 1; continue; }
      if (!canCarry[i]) continue;
      const up = cols[nearPiece[i]].M[5] * upS;   // how much of the piece's own up is still up
      if (up > o.supportOff + 0.1) carried[i] = 1; else if (up < o.supportOff) carried[i] = 0;   // a band between, so the idle sway does not switch it
      if (carried[i]) key = (key * 31 + i + 1) | 0;
    }
    if (key === supportKey && !first) return;
    supportKey = key; support.length = 0;
    for (let i = 0; i < n; i++) if (carried[i]) support.push(i);
    const fromSupport = geodesic(n, adj, adjLen, support);
    const hangSup = support.filter((i) => Math.abs(X0[i * 3]) > o.hangOut), fromHang = geodesic(n, adj, adjLen, hangSup.length ? hangSup : support);
    for (let i = 0; i < n; i++) {
      leashT[i] = Number.isFinite(fromSupport[i]) ? Math.min(o.leashMax, o.leashMin + o.leashSlope * fromSupport[i]) : o.leashMax;
      const hf = fromHang.src[i], hl = Number.isFinite(fromHang[i]) ? fromHang[i] * o.hang : 1e9;
      if (!first && hf >= 0 && hf !== i && hf !== hangFrom[i]) {   // hung from another point now: the limit comes in from where it is, not at once
        const k = i * 3, p_ = hf * 3; hangSlack[i] = Math.max(0, Math.hypot(x[k] - x[p_], x[k + 1] - x[p_ + 1], x[k + 2] - x[p_ + 2]) - hl);
      }
      hangFrom[i] = hf; hangLen[i] = hl;
    }
    if (first) leash.set(leashT);
  }
  supportNow(true);   // in the rest pose (arms out): what is tested against the skin and the pieces below is chosen by this leash
  // ---- skin planes: where the knit is fitted (a short leash) it must stay outside the skin as it is drawn, which the rigid
  // pieces are not at a bent shoulder (linear blend + MHR's correctives): the deltoid came through the knit. Each such
  // point remembers the body vertex nearest to it in the rest pose; every frame that vertex and its normal are skinned,
  // and the point is kept `margin` (or its rest distance, if less) above that plane.
  const bodies = [];
  vrm.scene.traverse((m) => {
    if (!m.isSkinnedMesh || m === mesh) return;
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material)?.name || '';
    if (bodyFilter({ mesh: m, name: m.name || mat, materialName: mat })) bodies.push(m);
  });
  const skinPts = [], skinBody = [], skinVert = [], skinGap = [];
  const bp = [0, 0, 0, 0, 0, 0];
  function skinVertex(m, r, out) {   // world position and normal of body vertex r as the bones have it now
    const gm = m.geometry, P = gm.attributes.position.array, N = gm.attributes.normal.array, J = gm.attributes.skinIndex, W = gm.attributes.skinWeight, bm = m.skeleton.boneMatrices, c = gm.attributes.mhrCorr?.array;
    let bx = P[r * 3], by = P[r * 3 + 1], bz = P[r * 3 + 2];
    if (c && useCorr) { bx += c[r * 3]; by += c[r * 3 + 1]; bz += c[r * 3 + 2]; }
    const nx = N[r * 3], ny = N[r * 3 + 1], nz = N[r * 3 + 2];
    let x_ = 0, y_ = 0, z_ = 0, a = 0, b = 0, d = 0;
    for (let k = 0; k < 4; k++) {
      const wt = W.getComponent(r, k); if (!wt) continue;
      const e = J.getComponent(r, k) * 16;
      x_ += wt * (bm[e] * bx + bm[e + 4] * by + bm[e + 8] * bz + bm[e + 12]); y_ += wt * (bm[e + 1] * bx + bm[e + 5] * by + bm[e + 9] * bz + bm[e + 13]); z_ += wt * (bm[e + 2] * bx + bm[e + 6] * by + bm[e + 10] * bz + bm[e + 14]);
      a += wt * (bm[e] * nx + bm[e + 4] * ny + bm[e + 8] * nz); b += wt * (bm[e + 1] * nx + bm[e + 5] * ny + bm[e + 9] * nz); d += wt * (bm[e + 2] * nx + bm[e + 6] * ny + bm[e + 10] * nz);
    }
    const l = Math.sqrt(a * a + b * b + d * d) || 1;
    out[0] = x_; out[1] = y_; out[2] = z_; out[3] = a / l; out[4] = b / l; out[5] = d / l;
  }
  let useCorr = false;
  {
    const near = []; for (let i = 0; i < nf; i++) near.push(i);   // every vertex of the mesh: the samples use theirs in the solver, the rest after the blend
    const best = new Float64Array(near.length).fill(Infinity), bb = new Int32Array(near.length).fill(-1), bv = new Int32Array(near.length);
    bodies.forEach((m, q) => {
      m.skeleton.update();
      const cnt = m.geometry.attributes.position.count, wp = new Float64Array(cnt * 3);
      // only the vertices the body's own triangles use (a shared vertex buffer also holds the top's, the hair's, the shoes')
      const own = new Uint8Array(cnt); for (const r of m.geometry.index.array) own[r] = 1;
      for (let r = 0; r < cnt; r++) { if (!own[r]) continue; skinVertex(m, r, bp); wp[r * 3] = bp[0]; wp[r * 3 + 1] = bp[1]; wp[r * 3 + 2] = bp[2]; }
      for (let t = 0; t < near.length; t++) {
        const k = near[t] * 3, px = Xf0[k], py = Xf0[k + 1], pz = Xf0[k + 2];
        for (let r = 0; r < cnt; r++) { if (!own[r]) continue; const dx = wp[r * 3] - px, dy = wp[r * 3 + 1] - py, dz = wp[r * 3 + 2] - pz, d = dx * dx + dy * dy + dz * dz; if (d < best[t]) { best[t] = d; bb[t] = q; bv[t] = r; } }
      }
    });
    for (let t = 0; t < near.length; t++) {
      if (bb[t] < 0 || best[t] > 0.06 * 0.06) continue;   // 6 cm: under the arms the fitted knit hangs 3-4 cm off the skin
      skinVertex(bodies[bb[t]], bv[t], bp);
      const k = near[t] * 3, d = (Xf0[k] - bp[0]) * bp[3] + (Xf0[k + 1] - bp[1]) * bp[4] + (Xf0[k + 2] - bp[2]) * bp[5];
      skinPts.push(near[t]); skinBody.push(bb[t]); skinVert.push(bv[t]); skinGap.push(Math.max(0.001, Math.min(o.margin, d)));
    }
  }
  const usePieces = new Uint8Array(n).fill(1);
  // skinPts: vertices of the mesh that have a plane; sPl: each sample's plane (the one of the vertex it sits on), or -1
  const sPl = new Int32Array(n).fill(-1);
  { const at = new Int32Array(nf).fill(-1); skinPts.forEach((f, t) => { at[f] = t; }); for (let c = 0; c < n; c++) sPl[c] = at[sampleFine[c]]; }
  const sitW = Float32Array.from({ length: nf }, (_, i) => { if (!(o.sitReach > 0)) return 0; const t = Math.min(1, Math.max(0, 1 - (leash[sIdx[patch[i]]] - o.leashMin) / o.sitReach)); return t * t * (3 - 2 * t); });
  const dropF = new Float32Array(nf), dropT = new Float32Array(nf), dropMax = new Float32Array(nf);
  // a set of body vertices followed every frame: their positions and normals as the bones (and the correctives) have them.
  // Their own data is kept flat (reading it through the attributes every frame took most of the step's time)
  function planeSet(bIdx, vIdx) {
    const nP = bIdx.length, plane = new Float64Array(nP * 6), plB = new Float32Array(nP * 6), plJ = new Uint16Array(nP * 4), plW = new Float32Array(nP * 4);
    for (let t = 0; t < nP; t++) {
      const gm = bodies[bIdx[t]].geometry, r = vIdx[t];
      for (let c = 0; c < 3; c++) { plB[t * 6 + c] = gm.attributes.position.array[r * 3 + c]; plB[t * 6 + 3 + c] = gm.attributes.normal.array[r * 3 + c]; }
      for (let k = 0; k < 4; k++) { plJ[t * 4 + k] = gm.attributes.skinIndex.getComponent(r, k); plW[t * 4 + k] = gm.attributes.skinWeight.getComponent(r, k); }
    }
    function read() {
      for (let t = 0; t < nP; t++) {
        const m = bodies[bIdx[t]], bm = m.skeleton.boneMatrices, c = useCorr ? m.geometry.attributes.mhrCorr?.array : null, r = vIdx[t], q = t * 6;
        let bx = plB[q], by = plB[q + 1], bz = plB[q + 2];
        if (c) { bx += c[r * 3]; by += c[r * 3 + 1]; bz += c[r * 3 + 2]; }
        const nx = plB[q + 3], ny = plB[q + 4], nz = plB[q + 5];
        let x_ = 0, y_ = 0, z_ = 0, a = 0, b = 0, d = 0;
        for (let k = 0; k < 4; k++) {
          const wt = plW[t * 4 + k]; if (!wt) continue;
          const e = plJ[t * 4 + k] * 16;
          x_ += wt * (bm[e] * bx + bm[e + 4] * by + bm[e + 8] * bz + bm[e + 12]); y_ += wt * (bm[e + 1] * bx + bm[e + 5] * by + bm[e + 9] * bz + bm[e + 13]); z_ += wt * (bm[e + 2] * bx + bm[e + 6] * by + bm[e + 10] * bz + bm[e + 14]);
          a += wt * (bm[e] * nx + bm[e + 4] * ny + bm[e + 8] * nz); b += wt * (bm[e + 1] * nx + bm[e + 5] * ny + bm[e + 9] * nz); d += wt * (bm[e + 2] * nx + bm[e + 6] * ny + bm[e + 10] * nz);
        }
        const l = Math.sqrt(a * a + b * b + d * d) || 1;
        plane[q] = x_; plane[q + 1] = y_; plane[q + 2] = z_; plane[q + 3] = a / l; plane[q + 4] = b / l; plane[q + 5] = d / l;
      }
    }
    return { plane, read };
  }
  const PS = planeSet(skinBody, skinVert), plane = PS.plane, readPlanes = PS.read;
  const planeLast = new Float64Array(plane.length), planeEnd = new Float64Array(plane.length);
  const planeStep = new Float64Array(plane.length), planeS = new Float64Array(plane.length);
  // out = the planes between A and B at a (0 to 1): the points along the line, the normals along it and made unit again
  // (the contact takes the dot with the normal for a distance), the end's normal where the two nearly cancel
  function lerpPlanes(out, A, B, a) {
    for (let q = 0; q < out.length; q += 6) {
      for (let e = 0; e < 3; e++) out[q + e] = A[q + e] + (B[q + e] - A[q + e]) * a;
      const nx = A[q + 3] + (B[q + 3] - A[q + 3]) * a, ny = A[q + 4] + (B[q + 4] - A[q + 4]) * a, nz = A[q + 5] + (B[q + 5] - A[q + 5]) * a, l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (l > 1e-6) { out[q + 3] = nx / l; out[q + 4] = ny / l; out[q + 5] = nz / l; } else { out[q + 3] = B[q + 3]; out[q + 4] = B[q + 4]; out[q + 5] = B[q + 5]; }
    }
  }   // where the last step left them, and this substep's (step)   // the skin planes the last step ended on, and this frame's (update)
  // For the sit: the skin UNDER each carried vertex (the body vertex nearest across, below it by up to 7 cm, facing up), not
  // the one nearest to it: beside the neck the nearest skin is the neck's side, and the collar stayed 2 cm over the shoulder.
  const sitPts = [], sitBody = [], sitVert = [];
  {
    const cand_ = []; for (let i = 0; i < nf; i++) if (sitW[i] > 0) cand_.push(i);
    const best = new Float64Array(cand_.length).fill(Infinity), bb = new Int32Array(cand_.length).fill(-1), bv = new Int32Array(cand_.length);
    bodies.forEach((m, q) => {
      const cnt = m.geometry.attributes.position.count, wp = new Float64Array(cnt * 6);
      for (let r = 0; r < cnt; r++) { skinVertex(m, r, bp); wp.set(bp, r * 6); }
      for (let t = 0; t < cand_.length; t++) {
        const k = cand_[t] * 3, px = Xf0[k], py = Xf0[k + 1], pz = Xf0[k + 2];
        for (let r = 0; r < cnt; r++) {
          const dy = py - wp[r * 6 + 1]; if (dy < -0.003 || dy > 0.07 || wp[r * 6 + 4] < 0.3) continue;
          const dx = wp[r * 6] - px, dz = wp[r * 6 + 2] - pz, d = dx * dx + dz * dz + 0.1 * dy * dy;
          if (d < best[t]) { best[t] = d; bb[t] = q; bv[t] = r; }
        }
      }
    });
    for (let t = 0; t < cand_.length; t++) if (bb[t] >= 0 && best[t] < 0.03 * 0.03) { sitPts.push(cand_[t]); sitBody.push(bb[t]); sitVert.push(bv[t]); }
  }
  const US = planeSet(sitBody, sitVert), under = US.plane;

  // ---- state ----
  const x = new Float64Array(X0), xp = new Float64Array(X0), v = new Float64Array(n * 3), w = new Float64Array(n).fill(1);
  const tgt = new Float64Array(X0), tgtPrev = new Float64Array(X0), nrm = new Float64Array(n * 3);
  const tgtStart = new Float64Array(n * 3), tgtEnd = new Float64Array(n * 3), xF0 = new Float64Array(n * 3);   // the targets a frame starts and ends on (update)
  const colStart = cols.map(() => new Float64Array(12)), colEnd = cols.map(() => new Float64Array(12));   // and the body's pieces
  const boost = new Float64Array(n);   // extra leash around a pinch
  let boostOn = 0;                     // 1 while held, decays after
  let boostT = 0, calm = 0;            // time since let go (0..1 of grabReturn); the extra damping's strength (1..0)
  const vSum = new Float64Array(n * 3), vCnt = new Uint16Array(n);
  const tvPrev = new Float64Array(n * 3);   // each target's speed in the step before
  const xs = new Float64Array(n * 3);  // where the points were when the frame began
  // every vertex of the mesh: its own target plus the blended offsets of the samples it follows
  const xf = new Float64Array(Xf0), tf = new Float64Array(Xf0), nrmF = new Float64Array(nf * 3);
  function fine() {
    for (let i = 0; i < nf; i++) {
      let ox = 0, oy = 0, oz = 0;
      for (let q = 0; q < 4; q++) { const c = fI[i * 4 + q]; if (c < 0) break; const wt = fW[i * 4 + q], k = c * 3; ox += wt * (x[k] - tgtPrev[k]); oy += wt * (x[k + 1] - tgtPrev[k + 1]); oz += wt * (x[k + 2] - tgtPrev[k + 2]); }   // tgtPrev: the targets the last step ended on
      xf[i * 3] = tf[i * 3] + ox; xf[i * 3 + 1] = tf[i * 3 + 1] + oy; xf[i * 3 + 2] = tf[i * 3 + 2] + oz;
    }
  }
  // the blended vertices kept outside the skin under them too (between samples the blend cut the corner of the armpit's
  // front and the skin showed)
  // ...and outside the rigid pieces its patch's sample is tested against (once a frame): lowering the arm bulges the chest
  // in front of the armpit, which no skin plane taken with the arms out stands for; the bulge came through between samples
  function finePieces() {
    for (let i = 0; i < nf; i++) {
      const cl = cand[sIdx[patch[i]]], k = i * 3;
      for (let q = 0; q < cl.length; q++) {
        const col = cols[cl[q]], m = col.inv;
        const sd = col.sdf.sample(m[0] * xf[k] + m[1] * xf[k + 1] + m[2] * xf[k + 2] + m[3], m[4] * xf[k] + m[5] * xf[k + 1] + m[6] * xf[k + 2] + m[7], m[8] * xf[k] + m[9] * xf[k + 1] + m[10] * xf[k + 2] + m[11], g);
        const mg = Math.min(0.003, col.marginF[i]);
        if (sd >= mg) continue;
        const c = col.M, gx = c[0] * g[0] + c[1] * g[1] + c[2] * g[2], gy = c[4] * g[0] + c[5] * g[1] + c[6] * g[2], gz = c[8] * g[0] + c[9] * g[1] + c[10] * g[2], gl = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1, push = (mg - sd) / gl;
        xf[k] += gx * push; xf[k + 1] += gy * push; xf[k + 2] += gz * push;
      }
    }
  }
  const lat0 = new Float64Array(skinPts.length); let lat0Set = false;
  function fineSkin() {
    for (let t = 0; t < skinPts.length; t++) {
      const k = skinPts[t] * 3, q = t * 6, g_ = Math.min(skinGap[t], 0.003), ex = xf[k] - plane[q], ey = xf[k + 1] - plane[q + 1], ez = xf[k + 2] - plane[q + 2], d = ex * plane[q + 3] + ey * plane[q + 4] + ez * plane[q + 5];
      const far = Math.sqrt(Math.max(0, ex * ex + ey * ey + ez * ez - d * d)) - lat0[t] - o.skinReach;
      if (far > 0.03) continue;
      if (d < g_) { const push = (g_ - d) * (far > 0 ? 1 - far / 0.03 : 1); xf[k] += plane[q + 3] * push; xf[k + 1] += plane[q + 4] * push; xf[k + 2] += plane[q + 5] * push; }
    }
  }
  function normals() {
    nrmF.fill(0);
    for (let f = 0; f < nFf; f++) {
      const a = Ff[f * 3] * 3, b = Ff[f * 3 + 1] * 3, c = Ff[f * 3 + 2] * 3;
      const ux = xf[b] - xf[a], uy = xf[b + 1] - xf[a + 1], uz = xf[b + 2] - xf[a + 2], vx = xf[c] - xf[a], vy = xf[c + 1] - xf[a + 1], vz = xf[c + 2] - xf[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      nrmF[a] += nx; nrmF[a + 1] += ny; nrmF[a + 2] += nz; nrmF[b] += nx; nrmF[b + 1] += ny; nrmF[b + 2] += nz; nrmF[c] += nx; nrmF[c + 1] += ny; nrmF[c + 2] += nz;
    }
    for (let k = 0; k < nf * 3; k += 3) { const l = Math.sqrt(nrmF[k] * nrmF[k] + nrmF[k + 1] * nrmF[k + 1] + nrmF[k + 2] * nrmF[k + 2]) || 1; nrmF[k] /= l; nrmF[k + 1] /= l; nrmF[k + 2] /= l; }
  }

  // ---- grab ----
  let grab = null;
  function startGrab(px, py, pz) {
    const ids = [], off = [];
    let centre = -1, best = Infinity;
    for (let i = 0; i < n; i++) {
      const dx = x[i * 3] - px, dy = x[i * 3 + 1] - py, dz = x[i * 3 + 2] - pz, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < best) { best = d; centre = i; }
      if (d < o.grabRadius) { ids.push(i); off.push(dx, dy, dz); }
    }
    if (centre < 0) return false;
    if (!ids.includes(centre)) { ids.push(centre); off.push(x[centre * 3] - px, x[centre * 3 + 1] - py, x[centre * 3 + 2] - pz); }
    for (const i of ids) w[i] = 0;
    const d = geodesic(n, adj, adjLen, [centre], o.grabReach);
    for (let i = 0; i < n; i++) { const t = Math.max(0, 1 - d[i] / o.grabReach); boost[i] = o.grabBoost * t * t * (3 - 2 * t); }
    boostOn = 1; boostT = 0;
    grab = { ids, off, centre, target: [px, py, pz], prev: [px, py, pz] };
    return true;
  }
  function moveGrab(px, py, pz) { if (grab) grab.target = [px, py, pz]; }
  function endGrab() { if (grab) { for (const i of grab.ids) w[i] = 1; grab = null; } }

  // Lc (optional): an edge is pushed back out only when shorter than this, not than L (between the two it is slack)
  function solve(C, L, alpha, limit, comp = 1, Lc = null) {
    const give = (o.pullStrain - o.maxStrain) / o.grabBoost * boostOn;
    for (let q = 0; q < L.length; q++) {
      const i = C[q * 2], j = C[q * 2 + 1], wi = w[i], wj = w[j], ws = wi + wj;
      if (!ws) continue;
      const ki = i * 3, kj = j * 3, dx = x[kj] - x[ki], dy = x[kj + 1] - x[ki + 1], dz = x[kj + 2] - x[ki + 2], l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (l < 1e-9) continue;
      // softly toward the rest length; past the limit, all the way back to the limit
      const lim = limit ? limit + give * Math.max(boost[i], boost[j]) : 0;
      if (limit && l > lim * L[q]) { heldBy[i] |= 64; heldBy[j] |= 64; }
      const lam = limit && l > lim * L[q] ? Math.max((l - L[q]) / ((ws + alpha + (lim > limit ? 0.5 : 0)) * l), (l - lim * L[q]) / (ws * l)) : (l - L[q]) / ((ws + alpha + (lim > limit ? 0.5 : 0)) * l);
      let lm = lam;
      if (lam < 0) {   // an edge shorter than its length is pushed back only by `comp` of the way: fabric folds
        const lc = Lc ? Lc[q] : L[q];
        lm = l < lc ? (l - lc) / ((ws + alpha) * l) * comp : 0;
      }
      x[ki] += dx * lm * wi; x[ki + 1] += dy * lm * wi; x[ki + 2] += dz * lm * wi; x[kj] -= dx * lm * wj; x[kj + 1] -= dy * lm * wj; x[kj + 2] -= dz * lm * wj;
    }
  }

  // ---- the skirt under the hem: its cloth points with their outward normals, in a hash grid, once a frame ----
  const SK = { cellInv: 1 / 0.03, table: new Map(), x: null, nrm: null, sign: 1, top: -Infinity, on: false };
  function readSkirt(skirt) {
    SK.on = !!skirt; if (!skirt) return;
    const c = skirt.cloth;
    if (SK.x !== c.x) {   // outward: away from the skirt's axis
      SK.x = c.x; SK.nrm = c.nrm; let s = 0;
      for (let i = 0; i < c.n; i++) s += c.nrm[i * 3] * (c.X0[i * 3] - skirt.pivot[0]) + c.nrm[i * 3 + 2] * (c.X0[i * 3 + 2] - skirt.pivot[1]);
      SK.sign = s >= 0 ? 1 : -1;
    }
    SK.top = -Infinity;
    for (let i = 0; i < c.n; i++) if (c.x[i * 3 + 1] > SK.top) SK.top = c.x[i * 3 + 1];
    buildSkirtTable();
  }
  // Over the skirt: each knit point keeps skirtGap outside the plane of the skirt point nearest to it (its outward normal).
  // The nearest point is found once a frame, and kept from the frame before while it is still within 3 cm (the pleats'
  // normals differ from point to point: a new nearest point every frame moved the hem about).
  // (Tried instead: the hem outside the pleats' outer envelope around the skirt's axis, per point or from a table by height
  // and direction. The hem's ring is shorter than that envelope, so it fought the edges: 1.2 mm a frame, ten times worse.)
  const skNear = new Int32Array(n).fill(-1), skCell = new Map();
  function findSkirt(i) {
    const k = i * 3, px = x[k], py = x[k + 1], pz = x[k + 2], old = skNear[i];
    if (old >= 0) { const dx = px - SK.x[old * 3], dy = py - SK.x[old * 3 + 1], dz = pz - SK.x[old * 3 + 2]; if (dx * dx + dy * dy + dz * dz < 0.02 * 0.02) return old; }
    const cx = Math.floor(px * SK.cellInv), cy = Math.floor(py * SK.cellInv), cz = Math.floor(pz * SK.cellInv);
    let best = -1, bd = 0.03 * 0.03;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const list = skCell.get(((cx + a) * 73856093) ^ ((cy + b) * 19349663) ^ ((cz + c) * 83492791));
      if (!list) continue;
      for (const j of list) { const dx = px - SK.x[j * 3], dy = py - SK.x[j * 3 + 1], dz = pz - SK.x[j * 3 + 2], d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; best = j; } }
    }
    return best;
  }
  function buildSkirtTable() {
    skCell.clear();
    for (let j = 0; j < SK.x.length / 3; j++) {
      const key = (Math.floor(SK.x[j * 3] * SK.cellInv) * 73856093) ^ (Math.floor(SK.x[j * 3 + 1] * SK.cellInv) * 19349663) ^ (Math.floor(SK.x[j * 3 + 2] * SK.cellInv) * 83492791);
      const list = skCell.get(key); if (list) list.push(j); else skCell.set(key, [j]);
    }
  }
  function overSkirt(k, best) {
    const j = best * 3, nx = SK.nrm[j] * SK.sign, ny = SK.nrm[j + 1] * SK.sign, nz = SK.nrm[j + 2] * SK.sign;
    const d = (x[k] - SK.x[j]) * nx + (x[k + 1] - SK.x[j + 1]) * ny + (x[k + 2] - SK.x[j + 2]) * nz;
    if (d < o.skirtGap) { const p = o.skirtGap - d; x[k] += nx * p; x[k + 1] += ny * p; x[k + 2] += nz * p; }
  }
  const LSe = new Float64Array(LS), LSc = new Float64Array(LS), hangE = new Float64Array(hangLen);
  // The neck's rim is taut: no ease on the edges within neckTaut of it along the fabric (rising to the full ease over the
  // same distance again). With the ease everywhere the V's edge bellied 5-13 mm forward off the chest standing upright;
  // its leash is untouched, so bent forward it still hangs away.
  // The ease is around the body, not along it: an edge running along the trunk (up and down) or along a sleeve gets
  // easeAlong, one running around gets the full ease. (The same ease on every edge made the knit 18% longer as well: the
  // hem came down 5 cm standing.)
  const easeE = new Float64Array(LS.length);
  for (let q = 0; q < LS.length; q++) {
    const a = CS[q * 2] * 3, b = CS[q * 2 + 1] * 3, dx = X0[b] - X0[a], dy = X0[b + 1] - X0[a + 1], dz = X0[b + 2] - X0[a + 2], l = Math.hypot(dx, dy, dz) || 1;
    const onArm = Math.abs((X0[a] + X0[b]) / 2) > o.armFrom, along = ((onArm ? dx : dy) / l) ** 2;   // the rest pose has the arms straight out
    easeE[q] = o.ease + (o.easeAlong - o.ease) * along;
  }
  {
    const neck = []; for (let c = 0; c < n; c++) if (rim[c] && Math.abs(X0[c * 3]) < 0.14 && X0[c * 3 + 1] > (Number.isFinite(armY) ? armY - 0.16 : Infinity) && nearPiece[c] >= 0 && !/Arm/.test(cols[nearPiece[c]].name)) neck.push(c);
    if (neck.length) {
      const d = geodesic(n, adj, adjLen, neck, o.neckTaut * 2);
      for (let q = 0; q < LS.length; q++) { const t = Math.min(1, Math.max(0, (o.neckBoth ? Math.max : Math.min)(d[CS[q * 2]], d[CS[q * 2 + 1]]) / o.neckTaut - 1)); easeE[q] = 1 + (easeE[q] - 1) * (Number.isFinite(t) ? t : 1); }
    }
  }
  const allPieces = cols.map((_, q) => q);
  for (const col of cols) col.slip = /^(head|neck)$/.test(col.name);
  const limbCols = cols.filter((c) => /(Upper|Lower)Arm$/.test(c.name));
  // the drawn faces as triples of simulated points (for the faces' middles against the arms)
  const triS = (() => { const seen = new Set(), out = []; for (let f = 0; f < Ff.length; f += 3) { const a_ = sIdx[patch[Ff[f]]], b_ = sIdx[patch[Ff[f + 1]]], c_ = sIdx[patch[Ff[f + 2]]]; if (a_ === b_ || b_ === c_ || a_ === c_) continue; const key = [a_, b_, c_].sort((p_, q_) => p_ - q_).join(','); if (!seen.has(key)) { seen.add(key); out.push(a_, b_, c_); } } return Uint32Array.from(out); })();
  // how far out the middle of each edge and face is pushed: no further than it lay from the arm as fitted (a sleeve lies on its arm;
  // pushed to the full margin, two of its points wandered 1 mm standing still)
  const midCols = o.edgeAll ? cols : limbCols;
  // which pieces each point came within `edgeNear` of in this step: only those are looked up for the edges and faces at it
  // (every middle against every piece made the top's step 2.5 times as long)
  // ...and only where the fabric has left its fitted place by `edgeMoved` (as fitted its faces clear the body: standing, 0.4% of the
  // trunk's vertices have fabric under them, with or without these tests)
  const away = new Uint8Array(n);
  const nearMask = new Uint32Array(n); cols.forEach((c, q) => { c.idx = q; });
  for (const col of cols) col.isLimb = /(Upper|Lower)Arm$/.test(col.name);
  for (const col of midCols) {
    const m = new Float64Array(12); inv12(col.M, m);
    const at = (px, py, pz) => o.edgeFull ? o.margin : Math.min(o.margin, col.sdf.sample(m[0] * px + m[1] * py + m[2] * pz + m[3], m[4] * px + m[5] * py + m[6] * pz + m[7], m[8] * px + m[9] * py + m[10] * pz + m[11]) - 0.0005);
    col.mE = new Float32Array(LS.length); col.mT = new Float32Array(triS.length / 3);
    for (let q = 0; q < LS.length; q++) { const i = CS[q * 2] * 3, j = CS[q * 2 + 1] * 3; col.mE[q] = at((X0[i] + X0[j]) / 2, (X0[i + 1] + X0[j + 1]) / 2, (X0[i + 2] + X0[j + 2]) / 2); }
    for (let f = 0; f < triS.length; f += 3) { const i = triS[f] * 3, j = triS[f + 1] * 3, l_ = triS[f + 2] * 3; col.mT[f / 3] = at((X0[i] + X0[j] + X0[l_]) / 3, (X0[i + 1] + X0[j + 1] + X0[l_ + 1]) / 3, (X0[i + 2] + X0[j + 2] + X0[l_ + 2]) / 3); }
  }
  // ---- a sleeve stays around its arm (2026-11-14, the user: 「片腕が袖の外に出るの防げる？」「ここは？」): the pieces push a point out
  // to the nearest surface, so a wall of the sleeve that the other limits had carried past the middle of the arm came out on
  // the far side, and upside down both arms ended up beside their sleeves (a line from the camera to the arm met no fabric
  // before it and two walls behind it; in the bones' shape one and one). Each point that lies around an arm as fitted remembers
  // on which side of the arm's axis it is (in the arm's own frame). A tube that hangs, falls to the other side or turns a
  // little keeps every point within a quarter turn of that side; a point found more than `sleeveTurn` away from it has gone
  // through the arm and is put back on its own side at the distance it has (its last place moved with it: no kick).
  const sleeves = [];
  if (o.sleeveSide) for (const col of limbCols) {
    const child = col.bone.children.find((c) => humanBones.has(c)); if (!child) continue;
    const L = child.position.length(), ax = [child.position.x / L, child.position.y / L, child.position.z / L], m = new Float64Array(12); inv12(col.M, m);
    const q = cols.indexOf(col), ids = [], side = [];
    for (let i = 0; i < n; i++) {
      if (nearPiece[i] !== q) continue;
      const px = X0[i * 3], py = X0[i * 3 + 1], pz = X0[i * 3 + 2];
      const lx = m[0] * px + m[1] * py + m[2] * pz + m[3], ly = m[4] * px + m[5] * py + m[6] * pz + m[7], lz = m[8] * px + m[9] * py + m[10] * pz + m[11];
      const al = lx * ax[0] + ly * ax[1] + lz * ax[2], rx = lx - al * ax[0], ry = ly - al * ax[1], rz = lz - al * ax[2], r = Math.hypot(rx, ry, rz);
      if (al < 0.02 || al > L * 1.1 || r < 0.005 || r > o.sleeveReach) continue;   // not the armhole end, where the body's fabric begins
      ids.push(i); side.push(rx / r, ry / r, rz / r);
    }
    if (ids.length) sleeves.push({ col, ax, L, ids: Int32Array.from(ids), side: Float64Array.from(side) });
  }
  // The arm's bone turns about its own length (raised overhead, a quarter turn and more) and the sleeve, sewn to the body, does
  // not: measured from the bone, sound points were on the "wrong" side all the time (2-10 points put back every step). So
  // first the sleeve's own turn about the arm: the mean of every point's angle from its remembered side (a sound tube: all
  // nearly the same; a tube lying beside the arm: all over the place, and the last sound turn is kept).
  function keepSleeves() {
    let moved = 0;
    for (const sl of sleeves) {
      const m = sl.col.inv, c = sl.col.cur, ax = sl.ax, nS = sl.ids.length;
      sl.loc ??= new Float64Array(nS * 5); sl.turn ??= 0;
      const loc = sl.loc; let sn = 0, cs = 0, cnt = 0;
      for (let t_ = 0; t_ < nS; t_++) {
        const k = sl.ids[t_] * 3, px = x[k], py = x[k + 1], pz = x[k + 2];
        const lx = m[0] * px + m[1] * py + m[2] * pz + m[3], ly = m[4] * px + m[5] * py + m[6] * pz + m[7], lz = m[8] * px + m[9] * py + m[10] * pz + m[11];
        const al = lx * ax[0] + ly * ax[1] + lz * ax[2], rx = lx - al * ax[0], ry = ly - al * ax[1], rz = lz - al * ax[2], r = Math.hypot(rx, ry, rz) || 1e-9;
        const sx = sl.side[t_ * 3], sy = sl.side[t_ * 3 + 1], sz = sl.side[t_ * 3 + 2];
        const co = (rx * sx + ry * sy + rz * sz) / r, si = ((sy * rz - sz * ry) * ax[0] + (sz * rx - sx * rz) * ax[1] + (sx * ry - sy * rx) * ax[2]) / r;
        loc[t_ * 5] = al; loc[t_ * 5 + 1] = r; loc[t_ * 5 + 2] = Math.atan2(si, co); loc[t_ * 5 + 3] = 0;
        // past the arm's ends there is nothing to be around; next to the axis the side means nothing (a cuff's point 1 cm from it was
        // put back 1,400 times in 6 s); and a point on a short leash goes where the bones put it
        if (al < -0.03 || al > sl.L + 0.03 || r < 0.025 || leash[sl.ids[t_]] < 0.03) { loc[t_ * 5 + 3] = 1; continue; }
        sn += si; cs += co; cnt++;
      }
      if (cnt < 4) continue;
      if (Math.hypot(sn, cs) / cnt > o.sleeveSound) sl.turn = Math.atan2(sn, cs);
      const ct = Math.cos(sl.turn), st = Math.sin(sl.turn);
      for (let t_ = 0; t_ < nS; t_++) {
        if (loc[t_ * 5 + 3]) continue;
        const i = sl.ids[t_], k = i * 3; if (!w[i]) continue;
        let d = loc[t_ * 5 + 2] - sl.turn; d = Math.atan2(Math.sin(d), Math.cos(d));
        if (Math.cos(d) >= o.sleeveTurn) continue;
        // its own side, turned as the sleeve is: s cos + (ax x s) sin
        const sx = sl.side[t_ * 3], sy = sl.side[t_ * 3 + 1], sz = sl.side[t_ * 3 + 2];
        const tx = sx * ct + (ax[1] * sz - ax[2] * sy) * st, ty = sy * ct + (ax[2] * sx - ax[0] * sz) * st, tz = sz * ct + (ax[0] * sy - ax[1] * sx) * st;
        const r = loc[t_ * 5 + 1], R = Math.max(r, o.sleeveOut), cd = Math.cos(loc[t_ * 5 + 2]), sd_ = Math.sin(loc[t_ * 5 + 2]);
        // where it is now, across the arm: s cos(a) + (ax x s) sin(a), times r
        const nx = (sx * cd + (ax[1] * sz - ax[2] * sy) * sd_) * r, ny = (sy * cd + (ax[2] * sx - ax[0] * sz) * sd_) * r, nz = (sz * cd + (ax[0] * sy - ax[1] * sx) * sd_) * r;
        const dx = tx * R - nx, dy = ty * R - ny, dz = tz * R - nz;
        const wx = c[0] * dx + c[1] * dy + c[2] * dz, wy = c[4] * dx + c[5] * dy + c[6] * dz, wz = c[8] * dx + c[9] * dy + c[10] * dz;
        x[k] += wx; x[k + 1] += wy; x[k + 2] += wz; xp[k] += wx; xp[k + 1] += wy; xp[k + 2] += wz; moved++;
        (sl.count ??= new Uint32Array(nS))[t_]++;
      }
    }
    return moved;
  }
  // ---- the body of the top keeps its tube (2026-11-14, the user: 「シャツが体を貫通して崩れてる」「スカートみたいな感じで捲れ上がらないと変」;
  // Codex's reading: nothing keeps the cross-section, the edges and the hang only stop it getting longer). Rings around the trunk
  // every `tubeStep` metres from the hem to the armpits, `tubeAround` points on each; each point and the ones across the ring
  // from it (half and a third of the way round) may not come closer than `tubeKeep` of their fitted distance. Only that:
  // the ring may move, turn, tilt and widen, so the body can still turn over the shoulders and the head as the skirt does.
  const tubeC = [], tubeL = [];
  if (o.tube) {
    const trunk = []; let cx = 0, cz = 0, top = armY - o.tubeBelowArms;
    for (let i = 0; i < n; i++) if (nearPiece[i] >= 0 && /^(hips|spine|chest|upperChest)$/.test(cols[nearPiece[i]].name) && X0[i * 3 + 1] < top) { trunk.push(i); cx += X0[i * 3]; cz += X0[i * 3 + 2]; }
    cx /= trunk.length || 1; cz /= trunk.length || 1;
    for (let y = minY + o.tubeStep * 0.25; y < top; y += o.tubeStep) {
      // the point nearest this height in each of tubeAround sectors
      const ring = new Int32Array(o.tubeAround).fill(-1), err = new Float64Array(o.tubeAround).fill(o.tubeStep * 0.5);
      for (const i of trunk) { const e = Math.abs(X0[i * 3 + 1] - y), sct = Math.floor((Math.atan2(X0[i * 3 + 2] - cz, X0[i * 3] - cx) / (2 * Math.PI) + 0.5) * o.tubeAround) % o.tubeAround; if (e < err[sct]) { err[sct] = e; ring[sct] = i; } }
      for (let a_ = 0; a_ < o.tubeAround; a_++) for (const hop of [o.tubeAround >> 1, Math.round(o.tubeAround / 3)]) {
        const i = ring[a_], j = ring[(a_ + hop) % o.tubeAround]; if (i < 0 || j < 0 || i === j || (hop === o.tubeAround >> 1 && a_ >= hop)) continue;
        tubeC.push(i, j); tubeL.push(Math.hypot(X0[i * 3] - X0[j * 3], X0[i * 3 + 1] - X0[j * 3 + 1], X0[i * 3 + 2] - X0[j * 3 + 2]) * o.tubeKeep);
      }
    }
  }
  // ...and stays around the body: as with the sleeves, a wall of the tube that got past the middle of the neck or the head came out
  // on the far side, and the body of the top hung behind the head or beside it instead of over it (3 runs: over the head once).
  // Each trunk point remembers its side of the body's axis (hips ... head, and 22 cm on past the head, where the tube hangs
  // upside down); the side is carried by the chest's turning. A point more than `sleeveTurn` from its side (after the tube's
  // own mean turn) is turned back around the axis to that limit, at the distance it has: around the body, not through it.
  const around = { ids: [], side: [], turn: 0, moves: 0 };
  const axisCols = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'].map((nm) => cols.find((c) => c.name === nm)).filter(Boolean);
  const chestCol = cols.find((c) => c.name === 'upperChest') || cols.find((c) => c.name === 'chest');
  const hipsCol = cols.find((c) => c.name === 'hips');
  if (o.tubeSide && chestCol && axisCols.length >= 3) {
    let cx = 0, cz = 0, cnt = 0; const top = armY - o.tubeBelowArms, M = chestCol.M;
    for (let i = 0; i < n; i++) if (nearPiece[i] >= 0 && /^(hips|spine|chest|upperChest)$/.test(cols[nearPiece[i]].name) && X0[i * 3 + 1] < top) { around.ids.push(i); cx += X0[i * 3]; cz += X0[i * 3 + 2]; cnt++; }
    cx /= cnt || 1; cz /= cnt || 1;
    for (const i of around.ids) { const sx = X0[i * 3] - cx, sz = X0[i * 3 + 2] - cz, l = Math.hypot(sx, sz) || 1; around.side.push(M[0] * sx / l + M[8] * sz / l, M[1] * sx / l + M[9] * sz / l, M[2] * sx / l + M[10] * sz / l); }   // in the chest's frame
    around.ang = new Float64Array(around.ids.length * 8);
  }
  const isTrunk = new Uint8Array(n); for (const i of around.ids) isTrunk[i] = 1;
  const isLimbCol = cols.map((c) => /(Upper|Lower)Arm$/.test(c.name));
  let rise = o.riseKeep; const chestUpL = chestCol ? [chestCol.M[4], chestCol.M[5], chestCol.M[6]] : [0, 1, 0];
  const axP = new Float64Array(24);
  const neckSeg = axisCols.findIndex((c) => c.name === 'neck');
  function keepAround() {
    const nA = around.ids.length; if (!nA) return;
    const m_ = axisCols.length; for (let q = 0; q < m_; q++) { const c = axisCols[q].cur; axP[q * 3] = c[3]; axP[q * 3 + 1] = c[7]; axP[q * 3 + 2] = c[11]; }
    { const a = (m_ - 2) * 3, b = (m_ - 1) * 3, dx = axP[b] - axP[a], dy = axP[b + 1] - axP[a + 1], dz = axP[b + 2] - axP[a + 2], l = Math.hypot(dx, dy, dz) || 1; axP[m_ * 3] = axP[b] + dx / l * o.tubePast; axP[m_ * 3 + 1] = axP[b + 1] + dy / l * o.tubePast; axP[m_ * 3 + 2] = axP[b + 2] + dz / l * o.tubePast; }
    const c = chestCol.cur, A = around.ang; let sn = 0, cs = 0, cnt = 0;
    for (let t_ = 0; t_ < nA; t_++) {
      const k = around.ids[t_] * 3, px = x[k], py = x[k + 1], pz = x[k + 2];
      let best = Infinity, ax = 0, ay = 0, az = 0, rx = 0, ry = 0, rz = 0, end = false;
      let seg = 0, segT = 0;
      for (let q = 0; q < m_; q++) {   // the nearest place on the axis
        const a = q * 3, dx = axP[a + 3] - axP[a], dy = axP[a + 4] - axP[a + 1], dz = axP[a + 5] - axP[a + 2], l2 = dx * dx + dy * dy + dz * dz || 1e-9;
        const tt = ((px - axP[a]) * dx + (py - axP[a + 1]) * dy + (pz - axP[a + 2]) * dz) / l2, tc = Math.min(1, Math.max(0, tt));
        const ex = px - axP[a] - dx * tc, ey = py - axP[a + 1] - dy * tc, ez = pz - axP[a + 2] - dz * tc, d2 = ex * ex + ey * ey + ez * ez;
        if (d2 < best) { best = d2; seg = q; segT = tc; const l = Math.sqrt(l2); ax = dx / l; ay = dy / l; az = dz / l; rx = ex; ry = ey; rz = ez; end = (q === 0 && tt < 0) || (q === m_ - 1 && tt > 1); }
      }
      A[t_ * 8 + 7] = 1;
      if (end) continue;   // past either end of the axis the tube is around nothing
      const ar = rx * ax + ry * ay + rz * az; rx -= ar * ax; ry -= ar * ay; rz -= ar * az;
      let r = Math.hypot(rx, ry, rz);
      // from the top of the chest on, the neck and the head count as one smooth round post for the trunk's fabric (widening over
      // the last bone before the neck): upside down the underside of the jaw faces up, a shelf, and the front of the top lay on
      // it 5 cm short of the neck's base while the back hung down behind the head
      if (o.tubeGuide && seg >= neckSeg - 1 && w[around.ids[t_]]) {
        const R = o.tubeGuide * (seg === neckSeg - 1 ? segT : 1);
        if (r < R && r > 1e-4) { const f = (R - r) / r; x[k] += rx * f; x[k + 1] += ry * f; x[k + 2] += rz * f; rx *= R / r; ry *= R / r; rz *= R / r; r = R; }
      }
      if (r < 0.03) continue;
      let sx = around.side[t_ * 3], sy = around.side[t_ * 3 + 1], sz = around.side[t_ * 3 + 2];
      let wx = c[0] * sx + c[1] * sy + c[2] * sz, wy = c[4] * sx + c[5] * sy + c[6] * sz, wz = c[8] * sx + c[9] * sy + c[10] * sz;
      const as = wx * ax + wy * ay + wz * az; wx -= as * ax; wy -= as * ay; wz -= as * az; const wl = Math.hypot(wx, wy, wz); if (wl < 0.2) continue; wx /= wl; wy /= wl; wz /= wl;
      const co = (rx * wx + ry * wy + rz * wz) / r, si = ((wy * rz - wz * ry) * ax + (wz * rx - wx * rz) * ay + (wx * ry - wy * rx) * az) / r;
      A[t_ * 8] = Math.atan2(si, co); A[t_ * 8 + 1] = r; A[t_ * 8 + 2] = ax; A[t_ * 8 + 3] = ay; A[t_ * 8 + 4] = az; A[t_ * 8 + 5] = 0; A[t_ * 8 + 7] = 0;
      // the side's direction is rebuilt below from the angle; keep it
      around.w ??= new Float64Array(nA * 3); around.w[t_ * 3] = wx; around.w[t_ * 3 + 1] = wy; around.w[t_ * 3 + 2] = wz;
      sn += si; cs += co; cnt++;
    }
    if (cnt < 6) return;
    if (Math.hypot(sn, cs) / cnt > o.sleeveSound) around.turn = Math.atan2(sn, cs);
    const lim = Math.acos(o.tubeTurn);
    for (let t_ = 0; t_ < nA; t_++) {
      if (A[t_ * 8 + 7]) continue;
      const i = around.ids[t_], k = i * 3; if (!w[i]) continue;
      let d = A[t_ * 8] - around.turn; d = Math.atan2(Math.sin(d), Math.cos(d));
      if (Math.abs(d) <= lim) continue;
      const to = around.turn + (o.tubeBack ? 0 : d > 0 ? lim : -lim), r = A[t_ * 8 + 1], ax = A[t_ * 8 + 2], ay = A[t_ * 8 + 3], az = A[t_ * 8 + 4];
      const wx = around.w[t_ * 3], wy = around.w[t_ * 3 + 1], wz = around.w[t_ * 3 + 2], ux = ay * wz - az * wy, uy = az * wx - ax * wz, uz = ax * wy - ay * wx;   // a x w
      const at = (ang, R) => [(wx * Math.cos(ang) + ux * Math.sin(ang)) * R, (wy * Math.cos(ang) + uy * Math.sin(ang)) * R, (wz * Math.cos(ang) + uz * Math.sin(ang)) * R];
      const now = at(A[t_ * 8], r), then = at(to, Math.max(r, o.tubeOut)), dx = then[0] - now[0], dy = then[1] - now[1], dz = then[2] - now[2];
      x[k] += dx; x[k + 1] += dy; x[k + 2] += dz; xp[k] += dx; xp[k + 1] += dy; xp[k + 2] += dz; around.moves++;
    }
  }
  function keepTube() {
    for (let q = 0; q < tubeL.length; q++) {
      const i = tubeC[q * 2], j = tubeC[q * 2 + 1], ki = i * 3, kj = j * 3, ws = w[i] + w[j]; if (!ws) continue;
      const dx = x[kj] - x[ki], dy = x[kj + 1] - x[ki + 1], dz = x[kj + 2] - x[ki + 2], l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (l >= tubeL[q] || l < 1e-9) continue;
      const lam = (l - tubeL[q]) / (ws * l) * o.tubeStiff;
      x[ki] += dx * lam * w[i]; x[ki + 1] += dy * lam * w[i]; x[ki + 2] += dz * lam * w[i];
      x[kj] -= dx * lam * w[j]; x[kj + 1] -= dy * lam * w[j]; x[kj + 2] -= dz * lam * w[j];
    }
  }
  // a ball around each piece's grid, where it is now: a point outside it is not looked up (with every point tested against
  // every piece, most pairs are far apart)
  for (const col of cols) { const b = col.sdf.box; col.bc = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2]; col.br2 = ((b[3] - b[0]) ** 2 + (b[4] - b[1]) ** 2 + (b[5] - b[2]) ** 2) / 4; col.bw = [0, 0, 0]; }
  function ball(col) { const c = col.cur, l = col.bc, w_ = col.bw; w_[0] = c[0] * l[0] + c[1] * l[1] + c[2] * l[2] + c[3]; w_[1] = c[4] * l[0] + c[5] * l[1] + c[6] * l[2] + c[7]; w_[2] = c[8] * l[0] + c[9] * l[1] + c[10] * l[2] + c[11]; }
  const heldBy = new Uint8Array(n);   // what held each sample in the last step: 1 leash, 2 hang, 4 skin plane, 8 piece, 16 skirt, 32 kept at rest, 64 an edge at its limit
  const stats = { steps: 0, ms: 0, rig: 0, out: 0, t: [0, 0, 0, 0] };   // t: predict+grab, edges, body+skirt+leash, the rest (ms a frame, eased)
  // ---- the air (once a step): see `drag` ----
  const aero = new Float64Array(n * 3), aeroW = new Float64Array(n), windK = [0, 0, 0];
  // dt: this step's length; span: how much of the world's time it stands for (more than dt on a frame cut at 2.5 steps).
  // The air is the world's: the body's speed is its targets' move over span, and the knit's own speed is taken at the same
  // rate (with the body's speed over dt, a cut frame of 100 ms walking at 1.3 m/s took the body for 3.1 m/s, and the lee
  // pushed a top's back forward)
  function computeAero(dt, span = dt) {
    aero.fill(0); aeroW.fill(0);
    const idt = 1 / span, rv = dt / span;
    // The body's own line (hips to chest, and on down past the hips): a face's outside is its side away from that line.
    // (Away from the world's vertical through the hips until 2026-11-16: bent forward, the back ahead of the hips, the back's
    // faces were taken as facing in, and the air on them as the lee's.)
    const H = hipsCol ? hipsCol.M : null, C_ = chestCol && chestCol !== hipsCol ? chestCol.M : null;
    const lx0 = H ? H[3] : 0, ly0 = H ? H[7] : 0, lz0 = H ? H[11] : 0;
    let ldx = C_ ? C_[3] - lx0 : 0, ldy = C_ ? C_[7] - ly0 : 1, ldz = C_ ? C_[11] - lz0 : 0;
    { const L = Math.sqrt(ldx * ldx + ldy * ldy + ldz * ldz); if (L > 1e-6) { ldx /= L; ldy /= L; ldz /= L; } else { ldx = 0; ldy = 1; ldz = 0; } }
    for (let f = 0; f < TC.length; f += 3) {
      const i = TC[f], j = TC[f + 1], l = TC[f + 2], a = i * 3, b = j * 3, c = l * 3;
      const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2], vx = x[c] - x[a], vy = x[c + 1] - x[a + 1], vz = x[c + 2] - x[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const A2 = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (A2 < 1e-12) continue;
      nx /= A2; ny /= A2; nz /= A2;
      // the body's speed here, and the air against the body
      const bx = ((tgt[a] - tgtPrev[a]) + (tgt[b] - tgtPrev[b]) + (tgt[c] - tgtPrev[c])) / 3 * idt, by = ((tgt[a + 1] - tgtPrev[a + 1]) + (tgt[b + 1] - tgtPrev[b + 1]) + (tgt[c + 1] - tgtPrev[c + 1])) / 3 * idt, bz = ((tgt[a + 2] - tgtPrev[a + 2]) + (tgt[b + 2] - tgtPrev[b + 2]) + (tgt[c + 2] - tgtPrev[c + 2])) / 3 * idt;
      const ux_ = windK[0] - bx, uy_ = windK[1] - by, uz_ = windK[2] - bz;
      const ox = (x[a] + x[b] + x[c]) / 3 - lx0, oy = (x[a + 1] + x[b + 1] + x[c + 1]) / 3 - ly0, oz = (x[a + 2] + x[b + 2] + x[c + 2]) / 3 - lz0, od = ox * ldx + oy * ldy + oz * ldz;
      const out = nx * (ox - ldx * od) + ny * (oy - ldy * od) + nz * (oz - ldz * od) >= 0 ? 1 : -1;
      const k = (nx * ux_ + ny * uy_ + nz * uz_) * out > 0 ? o.shield : 1;   // the air leaves through this face: the lee
      const rx = (v[a] + v[b] + v[c]) / 3 * rv - (bx + ux_ * k), ry = (v[a + 1] + v[b + 1] + v[c + 1]) / 3 * rv - (by + uy_ * k), rz = (v[a + 2] + v[b + 2] + v[c + 2]) / 3 * rv - (bz + uz_ * k);
      const vn = rx * nx + ry * ny + rz * nz, m = -dragK * Math.abs(vn) * vn * A2;
      for (const q of [a, b, c]) { aero[q] += nx * m; aero[q + 1] += ny * m; aero[q + 2] += nz * m; }
      aeroW[i] += A2; aeroW[j] += A2; aeroW[l] += A2;
    }
    for (let i = 0; i < n; i++) {
      if (!aeroW[i]) continue;
      const k = i * 3, q = 1 / aeroW[i];
      let ax = aero[k] * q, ay = aero[k + 1] * q, az = aero[k + 2] * q;
      const L = Math.sqrt(ax * ax + ay * ay + az * az);
      if (L > o.maxAero) { const r = o.maxAero / L; ax *= r; ay *= r; az *= r; }
      aero[k] = ax; aero[k + 1] = ay; aero[k + 2] = az;
    }
  }
  function step(dt, span = dt) {
    const t0 = performance.now(), ns = o.substeps, h = dt / ns, aS = o.stretch / (h * h), damp = Math.max(0, 1 - (o.damping + sleepCalm) * h), ih = 1 / h;
    if (grab) { boostT = 0; boostOn = 1; calm = 1; }
    else {
      if (boostT < 1) { boostT = Math.min(1, boostT + dt / o.grabReturn); boostOn = boostT >= 1 ? 0 : 1 - boostT * boostT * (3 - 2 * boostT); }
      if (calm > 0) calm = Math.max(0, calm - dt / o.calmTime);
    }
    xs.set(x); heldBy.fill(0);
    supportNow();
    // a leash that got shorter (a point carried again) comes in at leashIn, a longer one is there at once
    for (let i = 0; i < n; i++) { leash[i] = leashT[i] >= leash[i] ? leashT[i] : Math.max(leashT[i], leash[i] - o.leashIn * dt); if (hangSlack[i] > 0) hangSlack[i] = Math.max(0, hangSlack[i] - o.leashIn * dt); }
    // An edge is as long as in the fitted mesh (with ease), or as long as the bones stretch it now if that is more: linear
    // blend skinning stretches the knit 10-20% around a lowered shoulder, and edges held to their rest length there fought
    // the short leashes without end (the samples' edges are solved to the end, unlike the full mesh's were).
    for (let q = 0; q < LS.length; q++) {
      const i = CS[q * 2] * 3, j = CS[q * 2 + 1] * 3, lt = Math.sqrt((tgt[j] - tgt[i]) ** 2 + (tgt[j + 1] - tgt[i + 1]) ** 2 + (tgt[j + 2] - tgt[i + 2]) ** 2);
      // ...but no more than rigStretch times: a VRoid top's hem hangs on the legs' bones, and with the legs apart its edges
      // were allowed three times their length, which is no edge at all (neighbouring vertices 2 cm apart from frame to frame)
      LSe[q] = Math.max(LS[q] * easeE[q], Math.min(lt, LS[q] * easeE[q] * o.rigStretch));
      // The ease is how far the knit may give, not how big it wants to be: it is pushed back out only when shorter than the
      // bones make it now (the fitted shape). (Pushed out to the eased length until 2026-11-16, the fitted knit's edges
      // around the body were all 17% short, and awake the whole T-shirt swelled: 7 mm in the first frame awake, front and
      // back, and asleep it went back to the fitted shape. Standing still it swelled and shrank like breathing.)
      LSc[q] = Math.min(lt, LSe[q]);
    }
    for (let i = 0; i < n; i++) {
      const sI = hangFrom[i]; if (sI < 0 || sI === i) continue;
      const k = i * 3, p_ = sI * 3, lt = Math.sqrt((tgt[k] - tgt[p_]) ** 2 + (tgt[k + 1] - tgt[p_ + 1]) ** 2 + (tgt[k + 2] - tgt[p_ + 2]) ** 2);
      hangE[i] = Math.max(hangLen[i] + hangSlack[i], Math.min(lt * 1.02, hangLen[i] * o.rigStretch));
    }
    const calmK = grab ? 0 : o.calm * calm / o.grabBoost;
    // `compress` is for a round of the edges, however many passes it takes (see stretchIters)
    const compressPass = 1 - Math.pow(1 - Math.min(1, o.compress), 1 / Math.max(1, o.stretchIters));
    const gFrom = grab ? grab.prev.slice() : null;
    const idtF = 1 / dt;
    // How much of the body's own change of speed the knit feels as inertia. The rest is given to it at once: each point's
    // speed changes with its target's. (All of it left to the cloth, a top in a breakdance, the body changing speed by
    // 12 mm a frame every frame, was left behind and caught up again all the time: 「ずっとガクブルしてる」.)
    if (o.inertia < 1) for (let k = 0; k < n * 3; k++) { const tv = (tgt[k] - tgtPrev[k]) * idtF; if (w[k / 3 | 0]) v[k] += (1 - o.inertia) * (tv - tvPrev[k]); tvPrev[k] = tv; }
    const tt = [0, 0, 0, 0]; let tm = performance.now(); const lap = (q) => { const now = performance.now(); tt[q] += now - tm; tm = now; };
    for (let i = 0; i < n; i++) skNear[i] = SK.on && x[i * 3 + 1] < SK.top + 0.02 ? findSkirt(i) : -1;
    computeAero(dt, span);
    for (let s = 0; s < ns; s++) {
      const a = (s + 1) / ns;
      // the skin planes too, from where the last step left them (as the pieces and the targets are)
      lerpPlanes(planeS, planeStep, plane, a);
      for (const col of cols) { col.last.set(s === 0 ? col.prev : col.cur); for (let q = 0; q < 12; q++) col.cur[q] = col.prev[q] + (col.M[q] - col.prev[q]) * a; inv12(col.cur, col.inv); ball(col); }
      for (let i = 0; i < n; i++) {
        const k = i * 3;
        xp[k] = x[k]; xp[k + 1] = x[k + 1]; xp[k + 2] = x[k + 2];
        if (!w[i]) continue;
        v[k] += aero[k] * h; v[k + 1] += (o.gravity + aero[k + 1]) * h; v[k + 2] += aero[k + 2] * h;
        const sp = Math.sqrt(v[k] * v[k] + v[k + 1] * v[k + 1] + v[k + 2] * v[k + 2]);
        if (sp > o.maxSpeed) { const r = o.maxSpeed / sp; v[k] *= r; v[k + 1] *= r; v[k + 2] *= r; }
        x[k] += v[k] * h; x[k + 1] += v[k + 1] * h; x[k + 2] += v[k + 2] * h;
      }
      if (grab) {
        let tx = gFrom[0] + (grab.target[0] - gFrom[0]) * a, ty = gFrom[1] + (grab.target[1] - gFrom[1]) * a, tz = gFrom[2] + (grab.target[2] - gFrom[2]) * a;
        // the pinch goes no further from where the knit sits than its lengthened leash
        const c = grab.centre, ci = grab.ids.indexOf(c) * 3, k = c * 3, lim = leash[c] + boost[c];
        const cx = tgtPrev[k] + (tgt[k] - tgtPrev[k]) * a, cy = tgtPrev[k + 1] + (tgt[k + 1] - tgtPrev[k + 1]) * a, cz = tgtPrev[k + 2] + (tgt[k + 2] - tgtPrev[k + 2]) * a;
        const dx = tx + grab.off[ci] - cx, dy = ty + grab.off[ci + 1] - cy, dz = tz + grab.off[ci + 2] - cz, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > lim) { const r = lim / d - 1; tx += dx * r; ty += dy * r; tz += dz * r; }
        for (let q = 0; q < grab.ids.length; q++) { const kk = grab.ids[q] * 3; x[kk] = tx + grab.off[q * 3]; x[kk + 1] = ty + grab.off[q * 3 + 1]; x[kk + 2] = tz + grab.off[q * 3 + 2]; }
        if (s === ns - 1) grab.prev = [tx, ty, tz];
      }
      lap(0);
      solveHinges(x, w, HC, HT, 0, HA, 1 / (h * h), invMassC);
      if (tubeL.length) keepTube();
      // edges, hang and the skin under the fitted points, together and contactIters times over: solved once each in turn,
      // fabric drawn taut over the chest (a VRoid top upside down, its hem's weight on it) went in with the edges and out
      // with the skin every substep and never came to rest while the body moved at all
      for (let ci = 0; ci < o.contactIters; ci++) {
      for (let it = 0; it < o.stretchIters; it++) solve(CS, LSe, aS, o.maxStrain, compressPass, LSc);
      // hang: not further from its support than the way there along the fabric (longer around a pinch while it is held)
      for (let i = 0; i < n; i++) {
        const sI = hangFrom[i];
        if (!w[i] || sI < 0 || sI === i) continue;
        const k = i * 3, p = sI * 3, dx = x[k] - x[p], dy = x[k + 1] - x[p + 1], dz = x[k + 2] - x[p + 2], d = Math.sqrt(dx * dx + dy * dy + dz * dz), lim = hangE[i] + boost[i] * boostOn;
        if (d > lim) { const r = lim / d; x[k] = x[p] + dx * r; x[k + 1] = x[p + 1] + dy * r; x[k + 2] = x[p + 2] + dz * r; heldBy[i] |= 2; }
      }
      for (let i = 0; i < n; i++) {
        const t = sPl[i]; if (t < 0 || !w[i] || o.noSkin) continue;
        const k = i * 3, q = t * 6, ex = x[k] - planeS[q], ey = x[k + 1] - planeS[q + 1], ez = x[k + 2] - planeS[q + 2], d = ex * planeS[q + 3] + ey * planeS[q + 4] + ez * planeS[q + 5];
        // the plane is the skin only near its own vertex: a point that has travelled along the body (a top upside down) is
        // left to the rigid pieces. (Held to the plane of the skin it lay on at rest wherever it went, it was pushed out of
        // a plane that is not there, against its edges.)
        const far = Math.sqrt(Math.max(0, ex * ex + ey * ey + ez * ez - d * d)) - lat0[t] - o.skinReach;
        if (far > 0.03) continue;
        if (d < skinGap[t]) { heldBy[i] |= 4; const push = (skinGap[t] - d) * (far > 0 ? 1 - far / 0.03 : 1); x[k] += planeS[q + 3] * push; x[k + 1] += planeS[q + 4] * push; x[k + 2] += planeS[q + 5] * push; }
      }
      }
      lap(1);
      // ---- back down once the body is upright again (2026-11-14, the user: 「1回逆立ちすると服が戻らない」): the trunk's fabric
      // went toward the head between the arms, through the armpits (armsInward); upright, it sat on the shoulders and round the
      // neck, 35-40 cm above its place, and could not come back the way it went. While the chest is upright no trunk point may
      // be further toward the head than its bone-driven place plus `rise`, which closes from wherever the fabric is to
      // `riseKeep` at `riseBack` m/s; a point held by this is not tested against the body's pieces in that step (it is on
      // its way back through them). Upside down or lying, no limit.
      nearMask.fill(0);
      let riseU = null;
      if (o.riseKeep != null && chestCol && around.ids.length) {
        const c = chestCol.cur, u = chestUpL, ux = c[0] * u[0] + c[1] * u[1] + c[2] * u[2], uy = c[4] * u[0] + c[5] * u[1] + c[6] * u[2], uz = c[8] * u[0] + c[9] * u[1] + c[10] * u[2];
        if (uy * (o.gravity <= 0 ? 1 : -1) > o.riseUpright) { rise = Math.max(o.riseKeep, rise - o.riseBack * h); riseU = [ux, uy, uz]; } else rise = o.riseFrom;
      }
      for (let i = 0; i < n; i++) {
        if (!w[i]) continue;
        const k = i * 3;
        let back = false;
        if (riseU && isTrunk[i]) {
          const over = (x[k] - tgt[k]) * riseU[0] + (x[k + 1] - tgt[k + 1]) * riseU[1] + (x[k + 2] - tgt[k + 2]) * riseU[2] - rise;
          if (over > 0) { x[k] -= riseU[0] * over; x[k + 1] -= riseU[1] * over; x[k + 2] -= riseU[2] * over; back = true; }
        }
        // around a pinch the fabric travels: there, every piece (pulled 10 cm, the chest's fabric slid onto the upper arm,
        // which it is not tested against at rest, and the arm came through)
        // (only while it is held: left on during the return, arm and trunk pushed the fabric between them back and forth,
        // 26 swings after letting go)
        const cl = grab && boost[i] > 0 ? allPieces : cand[i];
        for (let q = 0; !back && usePieces[i] && !o.noPieces && s % o.piecesEvery === 0 && q < cl.length; q++) {
          const col = cols[cl[q]], m = col.inv, px = x[k], py = x[k + 1], pz = x[k + 2], bw = col.bw;
          if ((px - bw[0]) ** 2 + (py - bw[1]) ** 2 + (pz - bw[2]) ** 2 > col.br2) continue;
          const lx = m[0] * px + m[1] * py + m[2] * pz + m[3], ly = m[4] * px + m[5] * py + m[6] * pz + m[7], lz = m[8] * px + m[9] * py + m[10] * pz + m[11];
          const sd = col.sdf.sample(lx, ly, lz, g);
          if (sd < o.edgeNear) nearMask[i] |= 1 << cl[q];
          if (sd >= col.margin[i]) continue;
          const c = col.cur;
          let gx = c[0] * g[0] + c[1] * g[1] + c[2] * g[2], gy = c[4] * g[0] + c[5] * g[1] + c[6] * g[2], gz = c[8] * g[0] + c[9] * g[1] + c[10] * g[2];
          const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1; gx /= gl; gy /= gl; gz /= gl;
          // The trunk's fabric leaves an arm on the body's side of it, whichever surface is nearer (see armsInward): toward the
          // nearest place on the body's axis, across the arm. Above the chest that is the chest -> head line. Below it, the
          // hips -> chest line, carried on down past the hips: until 2026-11-16 a point below the chest was sent to the chest
          // itself, mostly upward, and the sides of a T-shirt long enough to reach the hands were lifted 9 cm onto the hanging
          // arms; the hem, one ring, then pulled the front up and in, and the front stood out round over the belly
          if (o.armsInward && isTrunk[i] && isLimbCol[cl[q]] && chestCol) {
            const cc = chestCol.cur, hc = (axisCols[axisCols.length - 1] || chestCol).cur, ex = hc[3] - cc[3], ey = hc[7] - cc[7], ez = hc[11] - cc[11];
            let ox = cc[3], oy = cc[7], oz = cc[11], tt = ((px - cc[3]) * ex + (py - cc[7]) * ey + (pz - cc[11]) * ez) / (ex * ex + ey * ey + ez * ez || 1e-9);
            if (tt < 0 && hipsCol && hipsCol !== chestCol) {
              const bc = hipsCol.cur, fx_ = cc[3] - bc[3], fy_ = cc[7] - bc[7], fz_ = cc[11] - bc[11];
              const u = Math.min(1, ((px - bc[3]) * fx_ + (py - bc[7]) * fy_ + (pz - bc[11]) * fz_) / (fx_ * fx_ + fy_ * fy_ + fz_ * fz_ || 1e-9));
              ox = bc[3] + fx_ * u; oy = bc[7] + fy_ * u; oz = bc[11] + fz_ * u;
            } else { tt = Math.min(1.6, Math.max(0, tt)); ox += ex * tt; oy += ey * tt; oz += ez * tt; }
            const ix = ox - px, iy = oy - py, iz = oz - pz, il = Math.sqrt(ix * ix + iy * iy + iz * iz);
            if (il > 0.01) { gx = ix / il; gy = iy / il; gz = iz / il; }
          }
          const push = col.margin[i] - sd; heldBy[i] |= 8;
          x[k] += gx * push; x[k + 1] += gy * push; x[k + 2] += gz * push;
          const l = col.last, bx = l[0] * lx + l[1] * ly + l[2] * lz + l[3], by = l[4] * lx + l[5] * ly + l[6] * lz + l[7], bz = l[8] * lx + l[9] * ly + l[10] * lz + l[11];
          const sx = (x[k] - xp[k]) - (px - bx), sy = (x[k + 1] - xp[k + 1]) - (py - by), sz = (x[k + 2] - xp[k + 2]) - (pz - bz), sn = sx * gx + sy * gy + sz * gz;
          const fr_ = col.slip ? o.headFriction : o.friction;
          x[k] -= (sx - sn * gx) * fr_; x[k + 1] -= (sy - sn * gy) * fr_; x[k + 2] -= (sz - sn * gz) * fr_;
        }
        if (skNear[i] >= 0) overSkirt(k, skNear[i]);
        // the leash
        const tx = tgtPrev[k] + (tgt[k] - tgtPrev[k]) * a, ty = tgtPrev[k + 1] + (tgt[k + 1] - tgtPrev[k + 1]) * a, tz = tgtPrev[k + 2] + (tgt[k + 2] - tgtPrev[k + 2]) * a;
        const dx = x[k] - tx, dy = x[k + 1] - ty, dz = x[k + 2] - tz, d = Math.sqrt(dx * dx + dy * dy + dz * dz), lim = leash[i] + boost[i] * boostOn;
        away[i] = d > o.edgeMoved ? 1 : 0;
        if (d > lim) { const r = lim / d; x[k] = tx + dx * r; x[k + 1] = ty + dy * r; x[k + 2] = tz + dz * r; heldBy[i] |= 1; }
      }
      if (sleeves.length) stats.sleeve = (stats.sleeve || 0) + keepSleeves();
      keepAround();
      // the middle of every edge stays outside the arms too (see edgeLimbs): both ends are moved out by what the middle is in
      if (o.edgeLimbs && !o.noPieces && s % o.edgeEvery === o.edgeEvery - 1) for (let q = 0; q < LS.length; q++) {
        const i = CS[q * 2], j = CS[q * 2 + 1], ki = i * 3, kj = j * 3, wi = w[i], wj = w[j];
        if (!wi && !wj) continue;
        const trunkE = o.armsInward && (isTrunk[i] || isTrunk[j]);
        const maskE = nearMask[i] | nearMask[j]; if (!maskE || !(away[i] | away[j])) continue;
        const px = (x[ki] + x[kj]) / 2, py = (x[ki + 1] + x[kj + 1]) / 2, pz = (x[ki + 2] + x[kj + 2]) / 2;
        for (let c_ = 0; c_ < midCols.length; c_++) {
          const col = midCols[c_], bw = col.bw; if (!(maskE >>> col.idx & 1) || (trunkE && col.isLimb) || (riseU && !col.isLimb)) continue;   // upright, the fitted top and the skin planes do it (and these moved a few points 5 mm standing still)
          if ((px - bw[0]) ** 2 + (py - bw[1]) ** 2 + (pz - bw[2]) ** 2 > col.br2) continue;
          const m = col.inv, lx_ = m[0] * px + m[1] * py + m[2] * pz + m[3], ly_ = m[4] * px + m[5] * py + m[6] * pz + m[7], lz_ = m[8] * px + m[9] * py + m[10] * pz + m[11], sd = col.sdf.sample(lx_, ly_, lz_);
          const mg = col.mE[q]; if (sd >= mg) continue; col.sdf.sample(lx_, ly_, lz_, g);
          const c = col.cur; let gx = c[0] * g[0] + c[1] * g[1] + c[2] * g[2], gy = c[4] * g[0] + c[5] * g[1] + c[6] * g[2], gz = c[8] * g[0] + c[9] * g[1] + c[10] * g[2];
          const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1, push = (mg - sd) / gl * 2 / (wi + wj) * (col.isLimb ? 1 : o.edgeSoft);   // the middle moves by the mean of the two ends
          gx *= push; gy *= push; gz *= push;
          const still_ = 0;
          if (wi) { x[ki] += gx; x[ki + 1] += gy; x[ki + 2] += gz; xp[ki] += gx * still_; xp[ki + 1] += gy * still_; xp[ki + 2] += gz * still_; heldBy[i] |= 8; }
          if (wj) { x[kj] += gx; x[kj + 1] += gy; x[kj + 2] += gz; xp[kj] += gx * still_; xp[kj + 1] += gy * still_; xp[kj + 2] += gz * still_; heldBy[j] |= 8; }
        }
      }
      if (o.edgeLimbs && !o.noPieces && s % o.edgeEvery === o.edgeEvery - 1) for (let f = 0; f < triS.length; f += 3) {   // ...and the middle of every face
        const i = triS[f], j = triS[f + 1], l_ = triS[f + 2], ki = i * 3, kj = j * 3, kl = l_ * 3, ws = w[i] + w[j] + w[l_];
        if (!ws) continue;
        const trunkF = o.armsInward && (isTrunk[i] || isTrunk[j] || isTrunk[l_]);
        const maskF = nearMask[i] | nearMask[j] | nearMask[l_]; if (!maskF || !(away[i] | away[j] | away[l_])) continue;
        const px = (x[ki] + x[kj] + x[kl]) / 3, py = (x[ki + 1] + x[kj + 1] + x[kl + 1]) / 3, pz = (x[ki + 2] + x[kj + 2] + x[kl + 2]) / 3;
        for (let c_ = 0; c_ < midCols.length; c_++) {
          const col = midCols[c_], bw = col.bw; if (!(maskF >>> col.idx & 1) || (trunkF && col.isLimb) || (riseU && !col.isLimb)) continue;
          if ((px - bw[0]) ** 2 + (py - bw[1]) ** 2 + (pz - bw[2]) ** 2 > col.br2) continue;
          const m = col.inv, lx_ = m[0] * px + m[1] * py + m[2] * pz + m[3], ly_ = m[4] * px + m[5] * py + m[6] * pz + m[7], lz_ = m[8] * px + m[9] * py + m[10] * pz + m[11], sd = col.sdf.sample(lx_, ly_, lz_);
          const mg = col.mT[f / 3]; if (sd >= mg) continue; col.sdf.sample(lx_, ly_, lz_, g);
          const c = col.cur; let gx = c[0] * g[0] + c[1] * g[1] + c[2] * g[2], gy = c[4] * g[0] + c[5] * g[1] + c[6] * g[2], gz = c[8] * g[0] + c[9] * g[1] + c[10] * g[2];
          const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1, push = (mg - sd) / gl * 3 / ws * (col.isLimb ? 1 : o.edgeSoft);
          gx *= push; gy *= push; gz *= push;
          const still_ = 0;
          for (const t_ of [i, j, l_]) if (w[t_]) { x[t_ * 3] += gx; x[t_ * 3 + 1] += gy; x[t_ * 3 + 2] += gz; xp[t_ * 3] += gx * still_; xp[t_ * 3 + 1] += gy * still_; xp[t_ * 3 + 2] += gz * still_; heldBy[t_] |= 8; }
        }
      }
      lap(2);
      // the speed dies out against the bones' own motion, not against the room: damped against the room the knit lagged
      // behind the idle sway and the hem never stopped (0.9 mm a frame against the bones, nine times the body's own motion)
      for (let k = 0; k < n * 3; k++) { const tv = (tgt[k] - tgtPrev[k]) * idtF; v[k] = tv + ((x[k] - xp[k]) * ih - tv) * damp; }
      // the fabric's own damping: each point's speed is drawn toward the mean of the points it shares an edge with, so
      // folds that flick back and forth from one step to the next die out while the cloth as a whole moves as it did
      if (o.viscosity > 0) {
        vSum.fill(0); vCnt.fill(0);
        for (let q = 0; q < LS.length; q++) { const a_ = CS[q * 2], b_ = CS[q * 2 + 1], ka = a_ * 3, kb = b_ * 3; vSum[ka] += v[kb]; vSum[ka + 1] += v[kb + 1]; vSum[ka + 2] += v[kb + 2]; vSum[kb] += v[ka]; vSum[kb + 1] += v[ka + 1]; vSum[kb + 2] += v[ka + 2]; vCnt[a_]++; vCnt[b_]++; }
        const f_ = Math.min(1, o.viscosity * h);
        for (let i = 0; i < n; i++) { const c_ = vCnt[i]; if (!c_) continue; const k = i * 3; v[k] += (vSum[k] / c_ - v[k]) * f_; v[k + 1] += (vSum[k + 1] / c_ - v[k + 1]) * f_; v[k + 2] += (vSum[k + 2] / c_ - v[k + 2]) * f_; }
      }
      if (calmK > 0) for (let i = 0; i < n; i++) {   // around the pinch just let go: the speed against the bones' own dies out
        if (!boost[i]) continue;
        const k = i * 3, f = Math.max(0, 1 - calmK * boost[i] * h), idt = 1 / dt;
        for (let c = 0; c < 3; c++) { const tv = (tgt[k + c] - tgtPrev[k + c]) * idt; v[k + c] = tv + (v[k + c] - tv) * f; }
      }
    }
    if (o.rest > 0) {   // at rest against the bones: stay
      const r2 = (o.rest * dt) ** 2, idt = 1 / dt, held = grab || boostOn > 0;
      for (let i = 0; i < n; i++) {
        if (!w[i] || (held && boost[i] > 0)) continue;
        const k = i * 3, ax = xs[k] - tgtPrev[k], ay = xs[k + 1] - tgtPrev[k + 1], az = xs[k + 2] - tgtPrev[k + 2];
        const dx = x[k] - tgt[k] - ax, dy = x[k + 1] - tgt[k + 1] - ay, dz = x[k + 2] - tgt[k + 2] - az;
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        x[k] = tgt[k] + ax; x[k + 1] = tgt[k + 1] + ay; x[k + 2] = tgt[k + 2] + az; heldBy[i] |= 32;
        v[k] = (tgt[k] - tgtPrev[k]) * idt; v[k + 1] = (tgt[k + 1] - tgtPrev[k + 1]) * idt; v[k + 2] = (tgt[k + 2] - tgtPrev[k + 2]) * idt;
      }
    }
    for (const col of cols) col.prev.set(col.M);
    tgtPrev.set(tgt); planeStep.set(plane);
    lap(3); for (let q = 0; q < 4; q++) stats.t[q] += (tt[q] - stats.t[q]) * 0.1;
    stats.ms += (performance.now() - t0 - stats.ms) * 0.1;
  }

  // ---- the new geometry on the same mesh: every vertex on the hips, written back through the hips' skinning matrix ----
  const hipsBone = vrm.humanoid?.getRawBoneNode('hips'), hipsIndex = Math.max(0, skeleton.bones.indexOf(hipsBone));
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(new Float32Array(nR * 3), 3).setUsage(THREE.DynamicDrawUsage), nrmAttr = new THREE.BufferAttribute(new Float32Array(nR * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const si = new Uint16Array(nR * 4), sw = new Float32Array(nR * 4);
  for (let i = 0; i < nR; i++) { si[i * 4] = hipsIndex; sw[i * 4] = 1; }
  geo.setAttribute('position', posAttr); geo.setAttribute('normal', nrmAttr);
  // the engine's outline and rim passes read these (as SkinnedCloth gives them)
  geo.setAttribute('smoothNormal', nrmAttr); geo.setAttribute('origNormal', nrmAttr); geo.setAttribute('curvature', new THREE.BufferAttribute(new Float32Array(nR), 1));
  for (const name of ['uv', 'uv1', 'color']) if (g0.attributes[name]) geo.setAttribute(name, g0.attributes[name]);
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4)); geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  // MHR's shader patch on this material adds the attributes mhrCorr / mhrNCorr; the offsets are already in the targets, so
  // here they are zero. (Left out, the shoulders showed holes with the skin in them: the attribute read something else.)
  for (const name of ['mhrCorr', 'mhrNCorr']) geo.setAttribute(name, new THREE.BufferAttribute(new Float32Array(nR * 3), 3));
  geo.setIndex(g0.index);
  if (Array.isArray(mesh.material)) for (let m = 0; m < mesh.material.length; m++) geo.addGroup(0, index.length, m);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 5);
  // which way the fabric's outside faces: the fitted mesh's own normals against the simulated ones
  let flip = 1;
  if (g0.attributes.normal) {
    normals(); let s = 0; const vn = new THREE.Vector3(), nm3 = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    for (let r = 0; r < nR; r += 7) { vn.fromBufferAttribute(g0.attributes.normal, r).applyMatrix3(nm3); const k = mapR[r] * 3; s += vn.x * nrmF[k] + vn.y * nrmF[k + 1] + vn.z * nrmF[k + 2]; }
    flip = s >= 0 ? 1 : -1;
  }
  const oldGeometry = mesh.geometry;
  mesh.geometry = geo; mesh.frustumCulled = false;
  const hipsSkin = new THREE.Matrix4(), hipsSkinInv = new THREE.Matrix4();
  function write() {
    hipsSkin.fromArray(skeleton.boneMatrices, hipsIndex * 16).multiply(mesh.bindMatrix); hipsSkinInv.copy(hipsSkin).invert();
    const e = hipsSkinInv.elements, P = posAttr.array, N = nrmAttr.array;
    for (let r = 0; r < nR; r++) {
      const k = mapR[r] * 3, wx = xf[k], wy = xf[k + 1], wz = xf[k + 2], nx = nrmF[k] * flip, ny = nrmF[k + 1] * flip, nz = nrmF[k + 2] * flip;
      P[r * 3] = e[0] * wx + e[4] * wy + e[8] * wz + e[12]; P[r * 3 + 1] = e[1] * wx + e[5] * wy + e[9] * wz + e[13]; P[r * 3 + 2] = e[2] * wx + e[6] * wy + e[10] * wz + e[14];
      N[r * 3] = e[0] * nx + e[4] * ny + e[8] * nz; N[r * 3 + 1] = e[1] * nx + e[5] * ny + e[9] * nz; N[r * 3 + 2] = e[2] * nx + e[6] * ny + e[10] * nz;
    }
    posAttr.needsUpdate = true; nrmAttr.needsUpdate = true;
  }
  // `fresh`: a skeleton whose bones' matrices (the whole scene's) have just been brought up to date by someone else in this
  // frame (the skirt's cloth, updated right before): the forced update of every matrix in the scene is then not repeated
  function readRig(fresh = null) {
    if (!fresh) vrm.scene.updateMatrixWorld(true);
    if (skeleton !== fresh) skeleton.update();
    corrNow = corr ? corr(oldGeometry) : null; useCorr = !!corrNow;
    for (const m of bodies) if (m.skeleton !== skeleton && m.skeleton !== fresh) m.skeleton.update();
    readPlanes();
    for (const col of cols) to12(col.bone.matrixWorld, col.M);
    for (let i = 0; i < nf; i++) pose(repF[i], tf, i * 3);
    // The carried parts lie on the skin: the fitted mesh keeps its shoulders 15 mm (up to 24) and the sides of its collar
    // 14 mm (up to 26) over the skin with the arms down, and a short leash held them there: 「開始時点でニットが宙に浮いてる」.
    // Each vertex's target comes down along the normal of the skin under it to `sit` above it, by how much it is carried
    // (sitW) and how much that skin faces up now.
    // Straight down, by amounts evened out over the neighbours: moved each along its own skin normal, the collar's rib
    // crumpled into a zigzag (the normals under neighbouring vertices differ).
    dropF.fill(0); dropMax.fill(0);
    if (sitPts.length) US.read();
    for (let t = 0; t < sitPts.length; t++) {
      const i = sitPts[t], wS = sitW[i], q = t * 6, k = i * 3, ny = under[q + 4], up = Math.min(1, Math.max(0, (ny - 0.2) / 0.4));
      const d = (tf[k] - under[q]) * under[q + 3] + (tf[k + 1] - under[q + 1]) * ny + (tf[k + 2] - under[q + 2]) * under[q + 5];
      if (d <= o.sit || !up) continue;
      dropMax[i] = Math.min(0.03, (d - o.sit) / Math.max(ny, 0.4));   // never further than the skin under it allows
      dropF[i] = dropMax[i] * wS * up;
    }
    for (let it = 0; sitPts.length && it < 4; it++) {
      for (let i = 0; i < nf; i++) { const nb = adjF[i]; let sum = 0; for (let e = 0; e < nb.length; e++) sum += dropF[nb[e]]; dropT[i] = nb.length ? 0.5 * dropF[i] + 0.5 * sum / nb.length : dropF[i]; }
      dropF.set(dropT);
    }
    if (sitPts.length) for (let i = 0; i < nf; i++) tf[i * 3 + 1] -= Math.min(dropF[i], dropMax[i]);
    for (let c = 0; c < n; c++) { const f = sampleFine[c] * 3, k = c * 3; tgt[k] = tf[f]; tgt[k + 1] = tf[f + 1]; tgt[k + 2] = tf[f + 2]; }
  }
  // ---- sleep ----
  const tgtF = new Float64Array(n * 3), tvF = new Float64Array(n * 3), offSlept = new Float64Array(n * 3), rotSlept = new Float64Array(cols.length * 9);
  const offLen = new Float64Array(cols.length), invTmp = new Float64Array(12), offPiece = new Int16Array(n);
  let pushedSum = 0;   // asleep: how far the skirt has pushed the knit since it fell asleep (the furthest point, added up)
  let asleep = false, quietT = 0, watched = 0, sleepCalm = 0, fitW = 0;   // fitW: how much of restToFit applies awake (0 to 1)
  // this frame: is everything that moves the knit quiet, and has a piece of the body turned away from where it fell asleep?
  function watch(dt, skirt) {
    const idt = 1 / dt;
    let accMax = 0, carry = 0;
    for (let k = 0; k < n * 3; k += 3) {
      const vx = (tgt[k] - tgtF[k]) * idt, vy = (tgt[k + 1] - tgtF[k + 1]) * idt, vz = (tgt[k + 2] - tgtF[k + 2]) * idt;
      if (watched >= 2) accMax = Math.max(accMax, Math.hypot(vx - tvF[k], vy - tvF[k + 1], vz - tvF[k + 2]) * idt);
      if (watched >= 1) carry = Math.max(carry, Math.hypot(vx - windK[0], vy - windK[1], vz - windK[2]));
      if (watched >= 1) { tvF[k] = vx; tvF[k + 1] = vy; tvF[k + 2] = vz; }
      tgtF[k] = tgt[k]; tgtF[k + 1] = tgt[k + 1]; tgtF[k + 2] = tgt[k + 2];
    }
    watched++;
    // how far out the points on each piece are after its turn since they fell asleep: the chord of the angle times the
    // longest offset on it
    let out = 0, outPiece = -1;
    if (asleep) for (let q = 0; q < cols.length; q++) {   // trace(R_now R_slept^T) = 1 + 2 cos(angle)
      if (!offLen[q]) continue;
      const M = cols[q].M, r = rotSlept, b = q * 9;
      const tr = M[0] * r[b] + M[1] * r[b + 1] + M[2] * r[b + 2] + M[4] * r[b + 3] + M[5] * r[b + 4] + M[6] * r[b + 5] + M[8] * r[b + 6] + M[9] * r[b + 7] + M[10] * r[b + 8];
      const d = 2 * Math.sin(Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) / 2) * offLen[q];
      if (d > out) { out = d; outPiece = q; }
    }
    const skirtAwake = !!(skirt && skirt.cloth.o.sleep && !skirt.cloth.sleeping);
    const calmAir = !windK[0] && !windK[1] && !windK[2];
    stats.watch = { accel: accMax, out, air: carry, piece: outPiece >= 0 ? cols[outPiece].name : null, skirtAwake };   // for tuning: what keeps the knit awake
    return { quiet: !grab && boostOn <= 0 && calm <= 0 && (asleep || !skirtAwake) && calmAir && carry < o.quietAir && accMax < o.quietAccel, moved: out > o.wakeDist };
  }
  function fallAsleep() {
    asleep = true;
    for (let k = 0; k < n * 3; k++) offSlept[k] = x[k] - tgtPrev[k];
    for (let q = 0; q < cols.length; q++) { const M = cols[q].M; rotSlept.set([M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]], q * 9); }
    // each point is on the piece of the body nearest to its target; each piece keeps the longest offset of its points
    offLen.fill(0);
    const invs = cols.map((col) => { inv12(col.M, invTmp); return invTmp.slice(); });
    for (let i = 0; i < n; i++) {
      const k = i * 3, px = tgt[k], py = tgt[k + 1], pz = tgt[k + 2];
      let best = Infinity, bq = 0;
      for (let q = 0; q < cols.length; q++) {
        const m = invs[q], d = cols[q].sdf.sample(m[0] * px + m[1] * py + m[2] * pz + m[3], m[4] * px + m[5] * py + m[6] * pz + m[7], m[8] * px + m[9] * py + m[10] * pz + m[11]);
        if (d < best) { best = d; bq = q; }
      }
      offLen[bq] = Math.max(offLen[bq], Math.hypot(offSlept[k], offSlept[k + 1], offSlept[k + 2])); offPiece[i] = bq;
    }
    pushedSum = 0;
  }
  // asleep: every point at its target plus the offset it fell asleep with (kept: see restToFit), at its target's speed,
  // and outside the skirt under it as awake (the skirt waking does not wake the knit, so it may move up under the hem:
  // Codex's review, 2026-11-15, found the knit left 1 cm inside a skirt surface moved out under it). A push is kept in
  // the offset, so the next frame searches the skirt from where the point was pushed to (kept only for the frame, the
  // knit fell back inside once the skirt had spread more than the 3 cm the search looks: the second review); and a push
  // further than wakeDist in one frame wakes the knit: the skirt is moving it. So do pushes adding up to wakeDist over the
  // frames (with the offsets kept asleep, small pushes frame after frame left the knit wherever the skirt had moved it,
  // and the piece's longest offset, which the turn that wakes it is measured by, went on as it fell asleep: Codex's
  // review, 2026-11-16). Returns the furthest push of this frame or all of them so far, whichever is more.
  function stepAsleep(dt) {
    for (let k = 0; k < n * 3; k++) { x[k] = tgt[k] + offSlept[k]; v[k] = tvF[k]; }
    let pushed = 0;
    if (SK.on) for (let i = 0; i < n; i++) {
      if (!w[i] || x[i * 3 + 1] >= SK.top + 0.02) { skNear[i] = -1; continue; }
      skNear[i] = findSkirt(i);
      if (skNear[i] < 0) continue;
      const k = i * 3, bx = x[k], by = x[k + 1], bz = x[k + 2];
      overSkirt(k, skNear[i]);
      const d = Math.hypot(x[k] - bx, x[k + 1] - by, x[k + 2] - bz);
      if (d > 0) { pushed = Math.max(pushed, d); offSlept[k] = x[k] - tgt[k]; offSlept[k + 1] = x[k + 1] - tgt[k + 1]; offSlept[k + 2] = x[k + 2] - tgt[k + 2]; offLen[offPiece[i]] = Math.max(offLen[offPiece[i]], Math.hypot(offSlept[k], offSlept[k + 1], offSlept[k + 2])); }
    }
    pushedSum += pushed;
    xp.set(x); tgtPrev.set(tgt); tvPrev.set(tvF);
    for (const col of cols) col.prev.set(col.M);
    acc = 0;
    return Math.max(pushed, pushedSum);
  }
  // the knit where the bones put it (cloth off, or after a cut to another pose)
  function settle() {
    asleep = false; quietT = 0; watched = 0; sleepCalm = 0; fitW = 0;
    readRig(); endGrab(); boostOn = 0; boostT = 1; calm = 0; planeLast.set(plane); planeStep.set(plane);
    x.set(tgt); xp.set(tgt); tgtPrev.set(tgt); v.fill(0); tvPrev.fill(0); acc = 0;
    if (!lat0Set) {   // how far along the skin each fitted vertex is from its plane's own body vertex, as fitted
      lat0Set = true;
      for (let t = 0; t < skinPts.length; t++) { const k = skinPts[t] * 3, q = t * 6, ex = tf[k] - plane[q], ey = tf[k + 1] - plane[q + 1], ez = tf[k + 2] - plane[q + 2], d = ex * plane[q + 3] + ey * plane[q + 4] + ez * plane[q + 5]; lat0[t] = Math.sqrt(Math.max(0, ex * ex + ey * ey + ez * ez - d * d)); }
    }
    for (const col of cols) { col.prev.set(col.M); col.cur.set(col.M); col.last.set(col.M); }
    fine(); normals(); write();
  }
  const STEP = 1 / 60; let acc = 0;
  // wind: { x, y, z } m/s in the world (or null)
  function update(dt, skirt = null, fresh = null, wind = null) {
    const t0 = performance.now();
    windK[0] = wind?.x ?? 0; windK[1] = wind?.y ?? 0; windK[2] = wind?.z ?? 0;
    readRig(fresh); readSkirt(skirt);
    stats.rig += (performance.now() - t0 - stats.rig) * 0.1;
    // In steps of about 1/60 s whatever the frame rate (from 0.75 to 1.5 of it alone, from 0.75 to 1.25 of it two to a
    // frame; two at most a frame; none on a frame that comes early): how the knit moved depended on the frame's length (at 24 frames a second the hem lay still, near 60 it
    // never did). The steps of a frame together last exactly as long as the time since the last step, so the body moves
    // as fast in the knit's time as it does: until 2026-11-16 the steps were exactly 1/60 s and the time left over went on
    // to the next frame, so with frames of uneven length the body seemed to speed up and slow down from frame to frame
    // (a frame 1.5 steps long moved the targets 1.5 steps' worth in one step), and walking, the front of a T-shirt shook
    // 2-4 cm a frame. Frames longer than 2.5 steps are cut there (slow motion, as before): then the steps last less than the
    // time gone, and only the air is reckoned in the world's time (computeAero).
    let calming = false;
    sleepCalm = 0;
    if (o.sleep && dt > 0) {
      const { quiet, moved } = watch(dt, skirt);
      if (asleep && (!quiet || moved)) { asleep = false; quietT = quiet ? o.calmAfter : 0; }
      else if (!asleep) quietT = quiet ? quietT + dt : 0;
      if (!asleep && quietT > o.calmAfter) { calming = true; sleepCalm = o.calmDamping * Math.min(1, (quietT - o.calmAfter) / Math.max(1e-3, o.sleepAfter - o.calmAfter)); }
      // the body about still: the offsets die out (restToFit; awake only)
      const air = stats.watch?.air ?? Infinity, goal = air <= o.fitStill ? 1 : air >= o.quietAir ? 0 : (o.quietAir - air) / Math.max(1e-6, o.quietAir - o.fitStill);
      fitW += (goal - fitW) * (1 - Math.exp(-dt / Math.max(1e-3, o.fitEase)));
    } else { asleep = false; fitW = 0; }
    if (asleep) { planeLast.set(plane); planeStep.set(plane); if (stepAsleep(dt) > o.wakeDist) { asleep = false; quietT = o.calmAfter; } }
    else {
      acc += dt;
      const steps = acc < 0.75 * STEP ? 0 : Math.max(1, Math.min(2, Math.round(acc / STEP)));
      const h_ = steps ? Math.min(acc, 2.5 * STEP) / steps : 0;
      let ran = 0;
      // The body's move since the last step, spread evenly over this frame's steps. (Until 2026-11-16 the first step got
      // all of it and the second none: at 30 frames a second the targets seemed to move twice as fast for a step and then
      // stop, and walking along, the knit was flung ahead: the front of a T-shirt stood 9 cm further out than standing.)
      // ...and so are the skin planes: left at the frame's end for both steps, the first step met the skin half a frame
      // ahead of everything else, and the skin pushed the front of a T-shirt forward every other step (walking at 30 frames
      // a second, the chest's fabric shook 9 mm a frame; 2 with the skin planes off)
      if (calming && steps > 0) xF0.set(x);
      if (steps > 0) { tgtEnd.set(tgt); tgtStart.set(tgtPrev); planeEnd.set(plane); for (let q = 0; q < cols.length; q++) { colEnd[q].set(cols[q].M); colStart[q].set(cols[q].prev); } }
      while (ran < steps) {
        ran++;
        if (steps > 1) {
          const a_ = Math.min(1, ran / steps);
          for (let k = 0; k < n * 3; k++) tgt[k] = tgtStart[k] + (tgtEnd[k] - tgtStart[k]) * a_;
          for (let q = 0; q < cols.length; q++) { const M = cols[q].M, A = colStart[q], B = colEnd[q]; for (let e = 0; e < 12; e++) M[e] = A[e] + (B[e] - A[e]) * a_; }
          lerpPlanes(plane, planeLast, planeEnd, a_);
        }
        step(h_, acc / steps); stats.steps++;
        if (fitW > 1e-3 && o.restToFit > 0) {   // the offsets from the targets die out (see restToFit; after `rest`, which would hold them)
          const keep = Math.exp(-o.restToFit * fitW * h_);
          for (let i = 0; i < n; i++) {
            if (!w[i]) continue;
            const k = i * 3; x[k] = tgt[k] + (x[k] - tgt[k]) * keep; x[k + 1] = tgt[k + 1] + (x[k + 1] - tgt[k + 1]) * keep; x[k + 2] = tgt[k + 2] + (x[k + 2] - tgt[k + 2]) * keep;
            // ...and outside the skirt again: a target under a spread skirt drew the knit back inside it (Codex's review)
            if (skNear[i] >= 0) overSkirt(k, skNear[i]);
          }
        }
      }
      if (steps) { acc = 0; planeLast.set(plane); }
      if (calming && ran) {
        let fastest = 0;
        // the speed against the targets, and the move over the frame against theirs: the drawing back to the fitted shape
        // and the skirt move a point after its speed is set (by `rest` at the targets' own), and asleep the offsets are
        // kept as they are, so the knit falls asleep only once that has come to rest too (Codex's review)
        const idt_ = 1 / Math.max(1e-6, h_ * ran);
        for (let i = 0; i < n; i++) {
          if (!w[i]) continue; const k = i * 3;
          fastest = Math.max(fastest, Math.hypot(v[k] - tvF[k], v[k + 1] - tvF[k + 1], v[k + 2] - tvF[k + 2]),
            Math.hypot((x[k] - xF0[k]) - (tgt[k] - tgtStart[k]), (x[k + 1] - xF0[k + 1]) - (tgt[k + 1] - tgtStart[k + 1]), (x[k + 2] - xF0[k + 2]) - (tgt[k + 2] - tgtStart[k + 2])) * idt_);
        }
        if (fastest < o.sleepSpeed || quietT >= o.sleepAfter) fallAsleep();
      }
    }
    stats.asleep = asleep;
    const t1 = performance.now();
    for (const col of cols) inv12(col.M, col.inv);
    fine(); fineSkin(); finePieces(); normals(); write();
    stats.out += (performance.now() - t1 - stats.out) * 0.1;
  }
  const ea = new THREE.Vector3(), eb = new THREE.Vector3(), ec = new THREE.Vector3(), hit = new THREE.Vector3();
  function raycast(ray) {
    let best = null;
    for (let f = 0; f < Ff.length; f += 3) {
      ea.fromArray(xf, Ff[f] * 3); eb.fromArray(xf, Ff[f + 1] * 3); ec.fromArray(xf, Ff[f + 2] * 3);
      if (!ray.intersectTriangle(ea, eb, ec, false, hit)) continue;
      const d = hit.distanceTo(ray.origin);
      if (!best || d < best.distance) best = { point: hit.clone(), distance: d };
    }
    return best;
  }
  // distance of point i from the body now (the nearest piece), for measuring
  function gap(i) {   // i: a vertex of the mesh (welded)
    let best = 1; const k = i * 3;
    for (const col of cols) { inv12(col.M, col.inv); const m = col.inv; best = Math.min(best, col.sdf.sample(m[0] * xf[k] + m[1] * xf[k + 1] + m[2] * xf[k + 2] + m[3], m[4] * xf[k] + m[5] * xf[k + 1] + m[6] * xf[k + 2] + m[7], m[8] * xf[k] + m[9] * xf[k + 1] + m[10] * xf[k + 2] + m[11])); }
    return best;
  }
  // distance of vertex i from the skin as it is drawn (the plane of the body vertex under it), or null
  const planeOf = new Int32Array(nf).fill(-1); skinPts.forEach((f, t) => { planeOf[f] = t; });
  function skinGapNow(i) {
    const t = planeOf[i]; if (t < 0) return null;
    const q = t * 6, k = i * 3;
    return (xf[k] - plane[q]) * plane[q + 3] + (xf[k + 1] - plane[q + 1]) * plane[q + 4] + (xf[k + 2] - plane[q + 2]) * plane[q + 5];
  }
  function measure() {
    let strain = 0, sum = 0, speed = 0;
    for (let q = 0; q < LS.length; q++) { const i = CS[q * 2] * 3, j = CS[q * 2 + 1] * 3, e = Math.hypot(x[j] - x[i], x[j + 1] - x[i + 1], x[j + 2] - x[i + 2]) / LSe[q] - 1; strain = Math.max(strain, e); sum += Math.abs(e); }
    let off = 0, offMax = 0;
    for (let k = 0; k < n * 3; k += 3) { const d = Math.hypot(x[k] - tgt[k], x[k + 1] - tgt[k + 1], x[k + 2] - tgt[k + 2]); off += d; offMax = Math.max(offMax, d); speed = Math.max(speed, Math.hypot(v[k], v[k + 1], v[k + 2])); }
    return { strain, meanStrain: sum / LS.length, off: off / n, offMax, speed, steps: stats.steps, ms: stats.ms + stats.rig + stats.out, stepMs: stats.ms, rigMs: stats.rig, outMs: stats.out, parts: stats.t.map((v) => +v.toFixed(1)) };
  }
  function dispose() { mesh.geometry = oldGeometry; geo.dispose(); }
  function setEnabled(on) { mesh.geometry = on ? geo : oldGeometry; if (on) settle(); }

  settle();
  return {
    get sleeping() { return asleep; }, stats,
    mesh, update, settle, setEnabled, raycast, skinGapNow, startGrab, moveGrab, endGrab, measure, gap, dispose, o,
    n: nf, x: xf, X0: Xf0, tgt: tf, rim: openRim, support: support.map((c) => sampleFine[c]), F: Ff,
    leash: Float64Array.from({ length: nf }, (_, i) => leash[sIdx[patch[i]]]),
    samples: { n, x, tgt, leash, of: sampleFine, hit: heldBy, hangFrom, hangE },
    get grabbing() { return !!grab; },
    _dbg: { tubeC, tubeL, around, get sleeveMoves() { return stats.sleeve || 0; }, sleeves, get sleeveTurns() { return sleeves.map((s) => Math.round((s.turn || 0) * 180 / Math.PI)); }, cols, cand, get oldGeometry() { return oldGeometry; }, rep: repF, map: mapR, pose, skin, bindPos, get corrNow() { return corrNow; } },
    info: { vertices: nf, samples: n, faces: nFf, stretch: LS.length, bend: HT.length, fabric: o.fabric, support: support.length, stitches: LST.length, skinPlanes: skinPts.length, pieces: cols.map((c) => c.name), leash: [Math.min(...leash), Math.max(...leash)] },
  };
}
