import { ANCHOR, ANCHOR_COUNT, BONES, FIGURE_SCALE, JOINTS, PROPORTIONS } from "./skeleton";

/**
 * The Particle Figure as particles: every grain of the body is bound to the skeleton, so a pose only
 * moves 15 anchors and the grains follow on the GPU. It is procedural (no model, bitmap or avatar asset)
 * and drawn in the same language as the sphere: fine sampled paths instead of solid limbs, a ring of
 * light for the head, small joint clusters, a faint veil for the torso, loose grains drifting around the
 * body and a deep, near-black dust that keeps the figure airy at any particle count.
 *
 * A binding is two vec4 per particle:
 *   bind  = (packed anchors a, b, c, d and kind, s, t, tone)
 *   local = (offset along the bone, offset across it, depth, phase)   (world units)
 *
 * Position = bilinear(a, b, c, d; s, t) + local offset in the frame of a → b. A bone uses c = b, d = a
 * (so t is irrelevant); a joint or the dust uses one anchor four times; the head ring hangs off
 * neck → head with s = 1, so tilting the head turns the ring. Every particle picks its component from
 * one fixed random sequence, so every quality tier (a prefix) shows the whole figure.
 */
export const FIGURE_KINDS = { bone: 0, ring: 1, joint: 2, veil: 3, aura: 4, halo: 5, dust: 6 } as const;
export type FigureKind = keyof typeof FIGURE_KINDS;

export interface FigureLayout { count: number; bind: Float32Array; local: Float32Array }

/** Share of all particles per component. The dust takes the excess so lines stay fine at any count. */
export const FIGURE_SHARES: Record<FigureKind, number> = { ring: 0.07, bone: 0.24, joint: 0.05, veil: 0.04, aura: 0.14, halo: 0.04, dust: 0.42 };

export const packAnchors = (a: number, b: number, c: number, d: number, kind: number) => a + b * 16 + c * 256 + d * 4096 + kind * 65536;
export function unpackAnchors(packed: number) {
  const p = Math.round(packed);
  return { a: p % 16, b: Math.floor(p / 16) % 16, c: Math.floor(p / 256) % 16, d: Math.floor(p / 4096) % 16, kind: Math.floor(p / 65536) };
}

const random = (initial: number) => { let seed = initial; return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; };

/**
 * A bone is a few fine filaments (strands) that part slightly mid-bone and meet at the joints, rather
 * than one thick line: `strands` per bone, `spacing` between them at mid-bone, `width` of each (normalized
 * σ), and a gentle flow along the bone.
 */
export const figureStroke = { strands: 3, spacing: 0.009, width: 0.0035, flow: 0.035, flowSpeed: 0.45 };

export function createFigureLayout(count: number, seed = 0xa10f): FigureLayout {
  const bind = new Float32Array(count * 4), local = new Float32Array(count * 4);
  const next = random(seed);
  const gaussian = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  const S = FIGURE_SCALE, R = PROPORTIONS.headRadius;
  // Bones weighted by their neutral length × density, so grains are spread evenly along the body.
  const neutralLength: Record<string, number> = {
    "neck-spine": PROPORTIONS.torso, "neck-shoulderLeft": 0.2, "neck-shoulderRight": 0.2,
    "spine-hipLeft": 0.1, "spine-hipRight": 0.1,
  };
  const boneWeights = BONES.map(([a, b, density]) => (neutralLength[`${a}-${b}`]
    ?? (a.startsWith("shoulder") ? PROPORTIONS.upperArm : a.startsWith("elbow") ? PROPORTIONS.forearm : a.startsWith("hip") ? PROPORTIONS.thigh : PROPORTIONS.shin)) * density);
  const boneTotal = boneWeights.reduce((sum, value) => sum + value, 0);
  const shares = Object.entries(FIGURE_SHARES) as [FigureKind, number][];
  const pickFrom = <T,>(items: readonly T[], weights: readonly number[], total: number) => {
    let r = next() * total;
    for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i]; }
    return items[items.length - 1];
  };
  const put = (i: number, anchors: [number, number, number, number], kind: FigureKind, s: number, t: number, tone: number,
    along: number, across: number, depth: number) => {
    bind[i * 4] = packAnchors(...anchors, FIGURE_KINDS[kind]);
    bind[i * 4 + 1] = s; bind[i * 4 + 2] = t; bind[i * 4 + 3] = Math.max(0, Math.min(1, tone));
    local[i * 4] = along * S; local[i * 4 + 1] = across * S; local[i * 4 + 2] = depth * S; local[i * 4 + 3] = next() * Math.PI * 2;
  };
  for (let i = 0; i < count; i++) {
    let r = next(), kind: FigureKind = "dust";
    for (const [name, share] of shares) { r -= share; if (r <= 0) { kind = name; break; } }
    switch (kind) {
      case "bone": {
        const [from, to, , tone] = pickFrom(BONES, boneWeights, boneTotal);
        const a = ANCHOR[from], b = ANCHOR[to];
        const s = next(), strand = Math.floor(next() * figureStroke.strands) - (figureStroke.strands - 1) / 2;
        // Filaments part toward mid-bone and meet at the joints; the middle strand is the brightest.
        const part = Math.sin(Math.PI * s) * figureStroke.spacing * strand;
        const glow = strand === 0 ? 1 : 0.7;
        put(i, [a, b, b, a], kind, s, 0, tone * glow * (0.7 + next() * 0.45),
          0, part + gaussian() * figureStroke.width, part * 0.6 + gaussian() * figureStroke.width);
        break;
      }
      case "ring": {
        // A ring of light, with a sparse, dim interior.
        const angle = next() * Math.PI * 2;
        const inner = next() < 0.14;
        const radius = inner ? Math.sqrt(next()) * R * 0.85 : R + gaussian() * 0.0045;
        put(i, [ANCHOR.neck, ANCHOR.head, ANCHOR.head, ANCHOR.neck], kind, 1, 0, inner ? 0.12 + next() * 0.08 : 0.62 + next() * 0.25,
          Math.cos(angle) * radius, Math.sin(angle) * radius, gaussian() * 0.012);
        break;
      }
      case "joint": {
        const [name, spread, tone] = pickFrom(JOINTS, JOINTS.map(joint => joint[1]), JOINTS.reduce((sum, joint) => sum + joint[1], 0));
        const a = ANCHOR[name];
        put(i, [a, a, a, a], kind, 0, 0, tone * (0.85 + next() * 0.2), gaussian() * spread, gaussian() * spread, gaussian() * spread);
        break;
      }
      case "veil": {
        // The torso as a faint surface between shoulders and hips (it narrows toward the hips).
        // Denser toward the spine and fading toward the sides, so it has no hard edge.
        const across = 0.5 + (next() + next() + next() - 1.5) * 0.4;
        put(i, [ANCHOR.shoulderRight, ANCHOR.shoulderLeft, ANCHOR.hipLeft, ANCHOR.hipRight], kind, across, 0.05 + next() * 0.9,
          (0.04 + next() * 0.07) * (1 - Math.abs(across - 0.5)), gaussian() * 0.012, gaussian() * 0.012, gaussian() * 0.025);
        break;
      }
      case "aura": {
        // Loose grains around the limbs: the figure is still Presence, not a drawing.
        const [from, to] = pickFrom(BONES, boneWeights, boneTotal);
        const a = ANCHOR[from], b = ANCHOR[to];
        const spread = 0.03 + next() * 0.06;
        put(i, [a, b, b, a], kind, next(), 0, 0.06 + next() * 0.14, gaussian() * spread * 0.4, gaussian() * spread, gaussian() * spread);
        break;
      }
      case "halo": {
        // A faint orbit about the head; it turns and brightens slightly only while thinking.
        const angle = next() * Math.PI * 2, radius = R * (1.45 + next() * 0.9);
        put(i, [ANCHOR.neck, ANCHOR.head, ANCHOR.head, ANCHOR.neck], kind, 1, 0, 0.05 + next() * 0.08,
          Math.cos(angle) * radius, Math.sin(angle) * radius, gaussian() * 0.03);
        break;
      }
      default: {
        // Deep, near-black dust behind the figure, fading out with no edge (as in the celestial pack).
        const along = Math.max(-1.1, Math.min(1.1, gaussian() * 0.55)), across = Math.max(-0.9, Math.min(0.9, gaussian() * 0.35));
        const s = ANCHOR.spine;
        put(i, [s, s, s, s], kind, 0, 0, 0.006 + 0.06 * Math.pow(next(), 6), along, across, -0.2 - next() * 0.6);
      }
    }
  }
  return { count, bind, local };
}

/** Per-frame figure inputs besides the anchors (the GPU reads the same values from uniforms). */
export interface FigureFrame { clock: number; orbit: number; thinking: number }

/**
 * CPU reference of the GPU figure position (particle/physics/figure.ts evaluates the identical
 * expression). `anchors` are world-space vec4s in ANCHORS order.
 */
export function figurePoint(layout: FigureLayout, index: number, anchors: Float32Array, frame: FigureFrame = { clock: 0, orbit: 0, thinking: 0 }) {
  if (anchors.length < ANCHOR_COUNT * 4) throw new Error("invalid-anchors");
  const b = index * 4;
  const { a, b: ib, c, d, kind } = unpackAnchors(layout.bind[b]);
  const anchor = (k: number) => [anchors[k * 4], anchors[k * 4 + 1], anchors[k * 4 + 2]];
  const [A, B, C, D] = [anchor(a), anchor(ib), anchor(c), anchor(d)];
  const s0 = layout.bind[b + 1], t = layout.bind[b + 2];
  const [lx0, ly0, lz, phase] = [layout.local[b], layout.local[b + 1], layout.local[b + 2], layout.local[b + 3]];
  const s = s0 + Math.sin(frame.clock * figureStroke.flowSpeed + phase) * figureStroke.flow * s0 * (1 - s0) * 4;
  const base = [0, 1, 2].map(k => { const top = A[k] + (B[k] - A[k]) * s, bottom = D[k] + (C[k] - D[k]) * s; return top + (bottom - top) * t; });
  const dx = B[0] - A[0], dy = B[1] - A[1] + 1e-4, dz = B[2] - A[2];
  const length = Math.hypot(dx, dy, dz);
  const dir = [dx / length, dy / length, dz / length], perp = [-dir[1], dir[0], 0];
  const halo = kind === FIGURE_KINDS.halo ? 1 : 0;
  const co = Math.cos(frame.orbit), si = Math.sin(frame.orbit);
  const lx = lx0 + (lx0 * co - ly0 * si - lx0) * halo, ly = ly0 + (lx0 * si + ly0 * co - ly0) * halo;
  const drift = 0.006 + Math.hypot(lx0, ly0) * 0.06;
  const wobble = [Math.sin(frame.clock * 0.7 + phase), Math.sin(frame.clock * 0.53 + phase * 1.9), Math.sin(frame.clock * 0.61 + phase * 2.7)];
  const position = [0, 1, 2].map(k => base[k] + dir[k] * lx + perp[k] * ly + (k === 2 ? lz : 0) + wobble[k] * drift) as [number, number, number];
  const tone = layout.bind[b + 3] * (1 + halo * frame.thinking * 2.5);
  return { position, tone, kind };
}
