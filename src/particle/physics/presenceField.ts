import { SPECTRUM_BANDS } from "../../audio/spectrum";
import type { Node } from "three/webgpu";
import { atan, float, mx_fractal_noise_vec3, normalize, sin, smoothstep, vec3 } from "three/tsl";
import type { PhysicsUniforms } from "./uniforms";
type VectorNode = Node;

export function presenceForce(rest: VectorNode, seed: VectorNode, u: PhysicsUniforms) {
  const normal = rest.div(rest.length().add(0.0001));
  const cycle = u.clock.mul(u.breathFrequency).mul(float(1).sub(u.attention.mul(0.18)));
  // Shared rhythm with a travelling phase: different regions inhale in succession.
  // Listening breathes smaller and slower; attention and focus impulses gather the body inward.
  const breathing = sin(cycle.add(rest.y.mul(0.65)).add(rest.x.mul(0.25)))
    .add(sin(cycle.mul(1.71).add(rest.z)).mul(0.22)).mul(u.breath).mul(float(1).sub(u.attention.mul(u.listeningBreath)));
  // The user's voice draws the listening body slightly further in, following their loudness.
  const gather = u.attention.mul(u.contraction).add(u.focusPulse.mul(u.focusContraction)).add(u.listeningAudio.mul(u.inputResponse));
  const target = rest.mul(breathing.sub(gather));
  const time = u.clock.mul(u.idleSpeed);
  const slowNoise = mx_fractal_noise_vec3(
    rest.mul(1.8).add(seed.mul(0.12)).add(vec3(time, time.mul(0.61), time.mul(0.73))),
    2, 2, 0.5,
  );
  // Coherence: attention and focus quiet the autonomous field so the body holds still for the user.
  const attentionScale = float(1).sub(u.attention.mul(u.coherence)).sub(u.focusPulse.mul(u.focusCoherence)).max(0.08);
  const drift = slowNoise.mul(u.drift).mul(u.energy.add(0.92)).mul(attentionScale);
  // Bounded tangential movement passes through the same spring as pointer forces.
  const swirl = sin(time.mul(1.9).add(rest.y.mul(1.4)));
  const flow = vec3(rest.z.mul(swirl), sin(time.mul(1.3).add(rest.x)).mul(0.22), rest.x.negate().mul(swirl))
    .mul(u.flow).mul(attentionScale);
  const thoughtNoise = mx_fractal_noise_vec3(
    rest.mul(2.1).add(vec3(u.clock.mul(0.33), u.clock.mul(0.17), 0)), 2, 2, 0.5,
  );
  const rotation = vec3(rest.z, rest.x.mul(0.08), rest.x.negate()).mul(u.rotation);
  const thought = thoughtNoise.mul(u.thoughtTurbulence).add(rotation).mul(u.thinking);
  // Travelling internal activity: soft fronts of motion pass through the interior while thinking.
  const interior = float(1).sub(smoothstep(0.35, 1.3, rest.length())).add(0.2);
  const front = sin(rest.y.mul(2.4).add(rest.x.mul(1.1)).sub(u.clock.mul(2.3))).max(0).pow(3);
  const travel = thoughtNoise.mul(front).mul(interior).mul(u.thoughtTravel).mul(u.thinking);
  // Coherent regions take turns expressing accents instead of inflating every particle.
  const direction = normalize(u.voiceDirection);
  const alignment = normal.dot(direction);
  const lead = smoothstep(0.15, 0.94, alignment);
  const followerDirection = normalize(vec3(direction.y.negate(), direction.x, direction.z.mul(0.65)));
  const follower = smoothstep(0.12, 0.92, normal.dot(followerDirection));
  const tangent = direction.sub(normal.mul(alignment));
  const wave = sin(rest.y.mul(2.5).add(rest.x.mul(1.7)).sub(u.voicePhase.mul(3.2)));
  const localLift = lead.mul(u.voiceAccent).add(follower.mul(u.voiceFollow).mul(0.65))
    .mul(u.audioAccent);
  const circulation = tangent.mul(wave).mul(lead.add(follower.mul(0.55)))
    .mul(u.voiceBody.add(u.voiceArticulation.mul(0.65))).mul(u.audioFlow);
  const speechNoise = mx_fractal_noise_vec3(
    rest.mul(2.6).add(seed.mul(0.08)).add(vec3(u.voicePhase, u.voicePhase.mul(0.6), 0)), 2, 2, 0.5,
  );
  const texture = speechNoise.mul(u.voiceArticulation.add(u.voiceBody.mul(0.3)))
    .mul(lead.add(follower).clamp(0, 1)).mul(u.audioTurbulence);
  // Each frequency owns a soft radial tuft. Zero at sector edges avoids seams;
  // the core stays together while outer particles reach beyond the silhouette.
  const sector = atan(normal.y, normal.x).div(Math.PI * 2).add(1).fract().mul(SPECTRUM_BANDS);
  const band = u.spectrum.element(sector.floor().toInt());
  const tuft = sin(sector.fract().mul(Math.PI)).pow(2);
  const shell = smoothstep(0.3, 1.3, rest.length());
  const perimeter = smoothstep(0.15, 0.8, normal.xy.length());
  const spectrumTarget = normal.mul(band).mul(tuft).mul(shell).mul(perimeter)
    .mul(seed.z.mul(0.12).add(1)).mul(u.spectrumStrength);
  // While a Visual Action forms, speaking forces fade out early so the image is not scattered.
  const speechTarget = normal.mul(localLift).add(circulation).add(texture).add(spectrumTarget).mul(u.speechGain);
  // Assistant speech radiates outward.
  const voice = normal.mul(u.voiceBody.mul(u.audioForce)).mul(u.speechGain);
  return target.add(drift).add(flow).add(travel).add(speechTarget).mul(u.stiffness)
    .add(thought).add(voice).mul(u.motion);
}
