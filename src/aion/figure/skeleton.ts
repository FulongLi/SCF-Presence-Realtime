/**
 * The Particle Figure's skeleton: named anchors in a normalized frame (x right on screen, y up, z toward
 * the viewer; the standing figure spans about y −0.9…0.86). The figure faces the viewer, so its *left* is
 * on the viewer's right (+x).
 *
 * Geometry is data: poses move anchors (pose.ts), and the particle layout binds grains to anchors
 * (layout.ts). Nothing here animates or renders.
 */
export const ANCHORS = [
  "head", "neck",
  "shoulderLeft", "shoulderRight", "elbowLeft", "elbowRight", "handLeft", "handRight",
  /** The base of the spine (pelvis centre). */
  "spine",
  "hipLeft", "hipRight", "kneeLeft", "kneeRight", "footLeft", "footRight",
] as const;
export type AnchorName = typeof ANCHORS[number];
export const ANCHOR_COUNT = ANCHORS.length;
export const ANCHOR = Object.fromEntries(ANCHORS.map((name, index) => [name, index])) as Record<AnchorName, number>;

/** Normalized → world units (the sphere's radius is 1.35, so the figure stands about as tall as the sphere is wide). */
export const FIGURE_SCALE = 1.55;

/** Limb lengths and offsets in normalized units. Slender and calm: about eight and a half heads tall. */
export const PROPORTIONS = {
  pelvisY: 0.06,
  torso: 0.52,
  /** Neck anchor → head centre. The head ring's radius leaves a short visible neck. */
  neck: 0.17,
  headRadius: 0.105,
  shoulderWidth: 0.19,
  shoulderDrop: 0.065,
  upperArm: 0.27,
  forearm: 0.25,
  hipWidth: 0.095,
  hipDrop: 0.03,
  thigh: 0.47,
  shin: 0.47,
  footX: 0.12,
  footY: -0.9,
};

/** Bones the particle layout draws as fine lines: [from, to, relative density, tone]. */
export const BONES: readonly [AnchorName, AnchorName, number, number][] = [
  ["neck", "spine", 1, 0.62],
  ["neck", "shoulderLeft", 0.9, 0.55], ["neck", "shoulderRight", 0.9, 0.55],
  ["shoulderLeft", "elbowLeft", 1, 0.6], ["shoulderRight", "elbowRight", 1, 0.6],
  ["elbowLeft", "handLeft", 1, 0.6], ["elbowRight", "handRight", 1, 0.6],
  ["spine", "hipLeft", 0.8, 0.5], ["spine", "hipRight", 0.8, 0.5],
  ["hipLeft", "kneeLeft", 1, 0.58], ["hipRight", "kneeRight", 1, 0.58],
  ["kneeLeft", "footLeft", 1, 0.55], ["kneeRight", "footRight", 1, 0.55],
];

/** Small joint clusters: [anchor, spread (normalized σ), tone]. Hands are a touch larger. */
export const JOINTS: readonly [AnchorName, number, number][] = [
  ["neck", 0.01, 0.75], ["spine", 0.012, 0.7],
  ["shoulderLeft", 0.011, 0.85], ["shoulderRight", 0.011, 0.85],
  ["elbowLeft", 0.01, 0.8], ["elbowRight", 0.01, 0.8],
  ["handLeft", 0.018, 0.9], ["handRight", 0.018, 0.9],
  ["hipLeft", 0.01, 0.7], ["hipRight", 0.01, 0.7],
  ["kneeLeft", 0.01, 0.75], ["kneeRight", 0.01, 0.75],
  ["footLeft", 0.014, 0.75], ["footRight", 0.014, 0.75],
];
