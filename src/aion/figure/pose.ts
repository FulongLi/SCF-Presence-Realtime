import { GESTURE_SECONDS, sanitizeState, type AionState } from "../state";
import { ANCHOR, ANCHOR_COUNT, FIGURE_SCALE, PROPORTIONS as P } from "./skeleton";

/**
 * Body language: a pose is a handful of joint parameters, solved into anchor positions with simple
 * forward kinematics (limb lengths never change). States choose target parameters; the animator eases
 * toward them, and adds only slow breathing and weight shift. Every movement is small, low-frequency and
 * restrained: the figure is present, not theatrical.
 */
export interface ArmPose {
  /** Upper arm angle from hanging straight down, outward positive (radians). */
  raise: number;
  /** Elbow bend, added to `raise` for the forearm (radians). */
  bend: number;
  /** How far the hand comes toward the viewer (normalized units). */
  forward: number;
}

export interface PoseParams {
  /** Pelvis sideways shift: weight moving between the feet. */
  sway: number;
  /** Torso toward the viewer (normalized units at the neck). */
  lean: number;
  /** Head roll (radians, positive toward the figure's left). */
  tilt: number;
  /** Head dip, 0…1 (a nod is a brief dip). */
  nod: number;
  /** Shoulder lift (breathing). */
  lift: number;
  left: ArmPose;
  right: ArmPose;
}

const arm = (raise: number, bend: number, forward: number): ArmPose => ({ raise, bend, forward });
const REST_ARM = arm(0.16, 0.1, 0.02);
export const NEUTRAL_POSE: PoseParams = { sway: 0, lean: 0, tilt: 0, nod: 0, lift: 0, left: REST_ARM, right: REST_ARM };

/** Held targets per state. Timed gestures add their envelope on top (see gestureTarget). */
const STATE_POSES: Record<AionState, PoseParams> = {
  idle: NEUTRAL_POSE,
  // Turned toward the user: a slight lean and head tilt, hands drawn in a little; calmer.
  listening: { ...NEUTRAL_POSE, lean: 0.05, tilt: 0.07, nod: 0.08, left: arm(0.12, 0.2, 0.04), right: arm(0.12, 0.2, 0.04) },
  // Still, head slightly lowered. No spinner, no hand to chin.
  thinking: { ...NEUTRAL_POSE, lean: 0.02, tilt: -0.03, nod: 0.2, left: arm(0.12, 0.28, 0.05), right: arm(0.12, 0.28, 0.05) },
  speaking: { ...NEUTRAL_POSE, lean: 0.03, left: arm(0.17, 0.2, 0.04), right: arm(0.17, 0.2, 0.04) },
  // One hand raised, forearm up; the wave itself is the gesture envelope.
  greeting: { ...NEUTRAL_POSE, lean: 0.02, tilt: 0.05, right: arm(0.8, 1.95, 0.06) },
  acknowledging: { ...NEUTRAL_POSE, lean: 0.03 },
  curious: { ...NEUTRAL_POSE, lean: 0.03, tilt: 0.15 },
  // An open arm toward the information forming beside/through the body.
  presenting: { ...NEUTRAL_POSE, lean: 0.02, tilt: -0.04, right: arm(0.75, 0.25, 0.12), left: arm(0.2, 0.18, 0.04) },
};

/** Motion amplitudes per state: breathing and weight shift are quieter while listening and thinking. */
const STATE_MOTION: Record<AionState, { breath: number; sway: number }> = {
  idle: { breath: 1, sway: 1 }, listening: { breath: 0.7, sway: 0.4 }, thinking: { breath: 0.45, sway: 0.2 },
  speaking: { breath: 0.9, sway: 0.6 }, greeting: { breath: 0.8, sway: 0.3 }, acknowledging: { breath: 0.8, sway: 0.4 },
  curious: { breath: 0.8, sway: 0.4 }, presenting: { breath: 0.7, sway: 0.3 },
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const approach = (value: number, target: number, rate: number, dt: number) => value + (target - value) * (1 - Math.exp(-rate * dt));

const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** Rise over `rise` seconds, hold, fall over the last `fall` seconds of `total`. */
const envelope = (t: number, total: number, rise: number, fall: number) => smooth(0, rise, t) * (1 - smooth(total - fall, total, t));

/** The target pose for a state `t` seconds after it began, with the speaking amplitude (0…1). */
export function gestureTarget(state: AionState, t: number, amplitude = 0): PoseParams {
  const pose = STATE_POSES[sanitizeState(state)];
  switch (state) {
    case "greeting": {
      // Raise, two small waves, lower: the forearm swings a little around the raised elbow.
      const total = GESTURE_SECONDS.greeting, w = envelope(t, total, 0.6, 0.8);
      const wave = Math.sin((t - 0.6) * Math.PI * 2 * 1.4) * 0.2 * smooth(0.6, 0.9, t) * (1 - smooth(1.9, 2.1, t));
      const right = { raise: lerp(REST_ARM.raise, pose.right.raise, w), bend: lerp(REST_ARM.bend, pose.right.bend + wave, w), forward: lerp(REST_ARM.forward, pose.right.forward, w) };
      return { ...pose, tilt: pose.tilt * w, right };
    }
    case "acknowledging":
      return { ...pose, nod: 0.55 * Math.sin(Math.PI * Math.min(1, t / GESTURE_SECONDS.acknowledging)) };
    case "curious":
      return { ...pose, tilt: pose.tilt * envelope(t, GESTURE_SECONDS.curious, 0.5, 0.7) };
    case "speaking": {
      // The voice lifts the hands and chest a little; it never becomes a wave.
      const a = Math.max(0, Math.min(1, amplitude));
      const lifted = (side: ArmPose) => ({ raise: side.raise + a * 0.04, bend: side.bend + a * 0.2, forward: side.forward + a * 0.02 });
      return { ...pose, lift: a * 0.012, left: lifted(pose.left), right: lifted(pose.right) };
    }
    default:
      return pose;
  }
}

/**
 * Pose parameters → normalized anchor positions (x, y, z per anchor, in ANCHORS order). Pure: the same
 * parameters always give the same skeleton, and limb lengths are preserved.
 */
export function solvePose(pose: PoseParams, out = new Float32Array(ANCHOR_COUNT * 3)): Float32Array {
  const set = (index: number, x: number, y: number, z: number) => { out[index * 3] = x; out[index * 3 + 1] = y; out[index * 3 + 2] = z; };
  const pelvis = [pose.sway, P.pelvisY, 0];
  // The torso stays upright over the pelvis, a touch opposite the weight shift, and leans toward the viewer.
  const bendX = -pose.sway * 0.5;
  const neck = [pelvis[0] + bendX, pelvis[1] + P.torso + pose.lift * 0.5, pose.lean];
  set(ANCHOR.spine, pelvis[0], pelvis[1], pelvis[2]);
  set(ANCHOR.neck, neck[0], neck[1], neck[2]);
  // Head: rolls about the neck; a nod lowers it slightly and brings it forward.
  const headLength = P.neck - pose.nod * 0.02;
  set(ANCHOR.head, neck[0] + Math.sin(pose.tilt) * headLength, neck[1] + Math.cos(pose.tilt) * headLength, neck[2] + pose.nod * 0.05 + pose.lean * 0.3);
  for (const [side, sign] of [["Left", 1], ["Right", -1]] as const) {
    const armPose = side === "Left" ? pose.left : pose.right;
    const shoulder = [neck[0] + sign * P.shoulderWidth, neck[1] - P.shoulderDrop + pose.lift, neck[2] * 0.8];
    const elbowZ = shoulder[2] + armPose.forward * 0.4, handZ = shoulder[2] + armPose.forward;
    const elbow = [shoulder[0] + sign * Math.sin(armPose.raise) * P.upperArm, shoulder[1] - Math.cos(armPose.raise) * P.upperArm, elbowZ];
    const fore = armPose.raise + armPose.bend;
    const hand = [elbow[0] + sign * Math.sin(fore) * P.forearm, elbow[1] - Math.cos(fore) * P.forearm, handZ];
    set(ANCHOR[`shoulder${side}`], shoulder[0], shoulder[1], shoulder[2]);
    set(ANCHOR[`elbow${side}`], elbow[0], elbow[1], elbow[2]);
    set(ANCHOR[`hand${side}`], hand[0], hand[1], hand[2]);
    // Legs: feet stay planted; the knee takes up the slack with a slight forward bend (two-bone solve).
    const hip = [pelvis[0] + sign * P.hipWidth, pelvis[1] - P.hipDrop, 0];
    const foot = [sign * P.footX, P.footY, 0];
    const dx = foot[0] - hip[0], dy = foot[1] - hip[1];
    const reach = Math.hypot(dx, dy);
    const half = Math.min(reach, P.thigh + P.shin) / 2;
    const bend = Math.sqrt(Math.max(0, P.thigh * P.thigh - half * half));
    set(ANCHOR[`hip${side}`], hip[0], hip[1], hip[2]);
    set(ANCHOR[`knee${side}`], hip[0] + dx / 2 + sign * 0.004, hip[1] + dy / 2, bend);
    set(ANCHOR[`foot${side}`], foot[0], foot[1], foot[2]);
  }
  return out;
}

/**
 * Eases the figure's pose toward its state's target and adds slow breathing and weight shift. Output is
 * world-space anchors (x, y, z, 0 per anchor) for the particle runtime.
 */
export class FigureAnimator {
  /** Each arm is its own object: the neutral pose shares one arm between both sides. */
  readonly params: PoseParams = { ...NEUTRAL_POSE, left: { ...NEUTRAL_POSE.left }, right: { ...NEUTRAL_POSE.right } };
  readonly anchors = new Float32Array(ANCHOR_COUNT * 4);
  private readonly normalized = new Float32Array(ANCHOR_COUNT * 3);
  private readonly motion = { breath: 1, sway: 1 };
  private clock = 0;

  /**
   * @param state what Aion is doing; @param t seconds since that state began;
   * @param amplitude assistant speech loudness (0…1); @param calm reduced motion.
   */
  sample(dt: number, state: AionState, t: number, amplitude = 0, calm = false): Float32Array {
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
    this.clock += step;
    const safe = sanitizeState(state);
    const target = gestureTarget(safe, Number.isFinite(t) ? Math.max(0, t) : 0, amplitude);
    const p = this.params, quick = 6, slow = 2.2;
    p.lean = approach(p.lean, target.lean, slow, step);
    p.tilt = approach(p.tilt, target.tilt, quick, step);
    p.nod = approach(p.nod, target.nod, quick * 1.5, step);
    for (const side of ["left", "right"] as const) {
      p[side].raise = approach(p[side].raise, target[side].raise, quick, step);
      p[side].bend = approach(p[side].bend, target[side].bend, quick, step);
      p[side].forward = approach(p[side].forward, target[side].forward, quick, step);
    }
    const goal = STATE_MOTION[safe];
    this.motion.breath = approach(this.motion.breath, goal.breath, 1.5, step);
    this.motion.sway = approach(this.motion.sway, goal.sway, 1, step);
    const quiet = calm ? 0.3 : 1;
    // Breathing about every 4.5 s; weight shift about every 16 s. Both tiny.
    const breath = Math.sin(this.clock * Math.PI * 2 * 0.22) * 0.006 * this.motion.breath * quiet;
    const sway = Math.sin(this.clock * Math.PI * 2 * 0.062 + 0.7) * 0.008 * this.motion.sway * quiet;
    p.lift = approach(p.lift, target.lift, quick, step);
    const pose: PoseParams = { ...p, lift: p.lift + breath, sway: p.sway + sway };
    solvePose(pose, this.normalized);
    for (let i = 0; i < ANCHOR_COUNT; i++) {
      this.anchors[i * 4] = this.normalized[i * 3] * FIGURE_SCALE;
      this.anchors[i * 4 + 1] = this.normalized[i * 3 + 1] * FIGURE_SCALE;
      this.anchors[i * 4 + 2] = this.normalized[i * 3 + 2] * FIGURE_SCALE;
      this.anchors[i * 4 + 3] = 0;
    }
    return this.anchors;
  }
}
