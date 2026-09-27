import { ACESFilmicToneMapping, PerspectiveCamera, Scene } from "three";
import { WebGPURenderer } from "three/webgpu";
import { particleDefaults, type ParticleConfig } from "@/config/particleDefaults";
import type { PresenceSignalSource } from "@/presence/signal";
import type { MorphTarget } from "@/visual-actions/types";
import { morphSpeechBlend } from "./morphBlend";
import { AdaptiveQuality, qualityRange, qualityTiers } from "./quality";
import { createParticleSystem, type FormationPlanner } from "./ParticleSystem";
import { PointerPusher } from "./interaction/pointer";
import { syncUniforms } from "./physics/uniforms";
import { createPostFX } from "./rendering/postfx";
import { SpeechMotion } from "./speechMotion";

/** What the runtime reads each frame. It knows nothing about the Realtime session, tools or permissions. */
export interface MorphSource { sample(dt: number): number; readonly revision: number; readonly target: MorphTarget | null }
export interface RuntimeInputs { presence: PresenceSignalSource; morph: MorphSource }

/**
 * Camera staging relative to the product's own framing (a director's camera, e.g. the promo film).
 * yaw/pitch orbit the origin (radians), distance scales the fitted distance, lift lowers the camera and
 * its aim together so the body sits higher in frame.
 */
export interface StagePose { yaw: number; pitch: number; distance: number; lift: number }
export interface StageSource { pose(): StagePose }
/** The body assembling itself from free particles (see formation.ts); `time` is the formation clock. */
export interface FormationSource { plan: FormationPlanner; time(): number }

/**
 * Optional runtime behaviour. The product (`/`) passes none of these and keeps its self-driven loop,
 * adaptive quality, pointer interaction, reduced-motion calming and fixed framing.
 */
export interface RuntimeOptions {
  /** A fixed quality tier for the whole session: no adaptive changes (film playback and recording). */
  tier?: number;
  /** Overrides the tier's device-pixel-ratio cap, e.g. 2 to supersample a 1080p capture. */
  pixelRatio?: number;
  /** "external": no animation loop of its own; the caller renders each frame with handle.advance(). */
  loop?: "internal" | "external";
  /** Pointer interaction with the body. Default true. */
  interactive?: boolean;
  /** Calm the body under prefers-reduced-motion. Default true. */
  reducedMotion?: boolean;
  stage?: StageSource;
  formation?: FormationSource;
}

export interface RuntimeHandle {
  readonly config: ParticleConfig;
  /** Development tuning: copy `config` into uniforms every frame. */
  tuning: boolean;
  quality(): { tier: number; ceiling: number; count: number; frameMs: number };
  setTier(tier: number): void;
  /** External loop only: simulate `dt` seconds and render one frame at time `now` (seconds). */
  advance(dt: number, now: number): void;
  /** Samples known targets into particle positions ahead of time, so a later morph never waits on it. */
  prepare(targets: Iterable<MorphTarget>): void;
  /** Resolves once the GPU has finished the work submitted so far (frame capture). */
  settle(): Promise<void>;
  /** Formation time by which every particle has arrived, when the body was built with a formation. */
  readonly formationEnd: number | null;
  dispose(): void;
}

const STEP = 1 / 120;
export async function createParticleRuntime(
  container: HTMLElement, inputs: RuntimeInputs, lifetime: AbortSignal, onError: (message: string) => void,
  options: RuntimeOptions = {},
): Promise<RuntimeHandle | undefined> {
  if (!navigator.gpu) throw new Error("webgpu-unavailable");
  const config = structuredClone(particleDefaults);
  const renderer = new WebGPURenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
  try { await renderer.init(); } catch { renderer.dispose(); throw new Error("webgpu-failed"); }
  if (lifetime.aborted) { renderer.dispose(); return; }
  if (!("isWebGPUBackend" in renderer.backend)) { renderer.dispose(); throw new Error("webgpu-unavailable"); }
  renderer.setClearColor(0x090e16, 0);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  const scene = new Scene();
  const camera = new PerspectiveCamera(38, 1, 0.1, 40);
  const coarse = matchMedia("(pointer: coarse)").matches;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const fixed = options.tier === undefined ? null : Math.max(0, Math.min(qualityTiers.length - 1, Math.round(options.tier)));
  const range = fixed === null ? qualityRange(coarse, navigator.hardwareConcurrency || 4, memory) : { initial: fixed, max: fixed };
  const quality = new AdaptiveQuality(range.initial, range.max);
  // Buffers are sized for the session ceiling so the tier can rise without reallocation.
  const system = createParticleSystem(qualityTiers[range.max].count, config, options.formation?.plan);
  system.setCount(qualityTiers[quality.tier].count);
  scene.add(system.mesh);
  const u = system.uniforms;
  const speechMotion = new SpeechMotion();
  const fx = createPostFX(renderer, scene, camera, config);
  const pointer = options.interactive === false ? null : new PointerPusher(container, camera);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const calm = () => options.reducedMotion !== false && reducedMotion.matches;
  renderer.domElement.setAttribute("aria-hidden", "true");
  container.append(renderer.domElement);
  let stopped = false, frame = 0, revision = -1, accumulator = 0, frameMs = 16.7, fitted = 7.4, spinAngle = 0;
  let last = performance.now();
  const stage = () => {
    if (!options.stage) return;
    const { yaw, pitch, distance, lift } = options.stage.pose();
    const d = fitted * distance;
    camera.position.set(Math.sin(yaw) * Math.cos(pitch) * d, Math.sin(pitch) * d - lift, Math.cos(yaw) * Math.cos(pitch) * d);
    camera.lookAt(0, -lift, 0);
  };
  const resize = () => {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    camera.aspect = width / height;
    const extent = (config.geometry.radius + config.spring.maxOffset) * 1.07;
    fitted = Math.max(7.4, extent / (Math.tan(camera.fov * Math.PI / 360) * Math.min(1, camera.aspect)));
    camera.position.z = fitted;
    stage();
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(options.pixelRatio ?? Math.min(devicePixelRatio, qualityTiers[quality.tier].pixelRatio));
    renderer.setSize(width, height);
  };
  const applyTier = () => { system.setCount(qualityTiers[quality.tier].count); resize(); };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    pointer?.dispose();
    fx.post.dispose(); fx.scenePass.dispose(); fx.glow.dispose();
    system.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    document.removeEventListener("visibilitychange", visibility);
    lifetime.removeEventListener("abort", cleanup);
  };
  const visibility = () => { last = performance.now(); accumulator = 0; pointer?.reset(); };
  document.addEventListener("visibilitychange", visibility);
  lifetime.addEventListener("abort", cleanup, { once: true });
  renderer.onDeviceLost = () => { if (!stopped) { cleanup(); onError("device-lost"); } };

  /** One frame: presence and morph inputs, fixed-step physics, then the post-processed render. */
  const step = (dt: number, now: number) => {
    accumulator = Math.min(accumulator + dt, STEP * 8);
    if (handle.tuning) {
      syncUniforms(u, config);
      fx.glow.strength.value = config.bloom.strength;
      fx.glow.radius.value = config.bloom.radius; fx.glow.threshold.value = config.bloom.threshold;
    }
    const presence = inputs.presence.sample(dt, now);
    const morph = inputs.morph.sample(dt);
    // The controller only replaces its target while the body is a sphere, so this upload never snaps.
    if (revision !== inputs.morph.revision) {
      revision = inputs.morph.revision;
      spinAngle = 0;
      if (inputs.morph.target) {
        try { system.setTarget(inputs.morph.target); } catch { /* invalid targets are rejected upstream */ }
      }
    }
    u.morph.value = morph;
    // A spinning visual (MorphTarget.motion) turns slowly about the view axis; each new target starts upright.
    const spin = inputs.morph.target?.motion?.spin ?? 0;
    if (morph > 0 && Number.isFinite(spin) && spin !== 0) spinAngle = (spinAngle + spin * dt * (calm() ? 0.15 : 1)) % (Math.PI * 2);
    u.formedAngle.value = spinAngle;
    const blend = morphSpeechBlend(morph);
    u.speechGain.value = blend.speech; u.formedShimmer.value = blend.shimmer;
    for (let i = 0; i < presence.assistantBands.length; i++) u.spectrum.array[i] = presence.assistantBands[i];
    const speech = speechMotion.sample(presence.assistantAmplitude, dt);
    u.voiceBody.value = speech.body; u.voiceArticulation.value = speech.articulation;
    u.voiceAccent.value = speech.accent; u.voiceFollow.value = speech.follow;
    u.voicePhase.value = speech.phase;
    u.voiceDirection.value.set(speech.directionX, speech.directionY, speech.directionZ);
    u.attention.value = presence.focus;
    u.focusPulse.value = presence.acousticFocus;
    u.thinking.value = presence.thinking;
    u.listeningAudio.value = presence.userAmplitude;
    u.energy.value = presence.energy;
    u.warmth.value = presence.warmth;
    u.motion.value = calm() ? 0.15 : 1;
    if (system.formation && options.formation) system.formation.clock.value = options.formation.time();
    stage();
    try {
      while (accumulator >= STEP) {
        if (pointer) {
          pointer.step(STEP, config.pusher.follow, config.pusher.maxSpeed);
          u.pusherPosition.value.copy(pointer.position);
          u.pusherVelocity.value.copy(pointer.velocity);
        }
        u.active.value = pointer?.active ? (calm() ? 0.25 : 1) : 0;
        u.clock.value += STEP;
        renderer.compute(system.compute);
        if (stopped) return false;
        accumulator -= STEP;
      }
      fx.post.render();
    } catch {
      if (!stopped) { cleanup(); onError("device-lost"); }
      return false;
    }
    return true;
  };

  const handle: RuntimeHandle = {
    config, tuning: false,
    quality: () => ({ tier: quality.tier, ceiling: quality.ceiling, count: qualityTiers[quality.tier].count, frameMs }),
    setTier(tier) { quality.force(Math.min(range.max, tier)); applyTier(); },
    advance(dt, now) {
      if (stopped || options.loop !== "external") return;
      const bounded = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), STEP * 8) : 0;
      if (bounded > 0 && bounded < 0.15) frameMs += (bounded * 1000 - frameMs) * 0.05;
      // three.js advances its node frame (which gates once-per-frame work such as the post-processing
      // scene pass) only from its own requestAnimationFrame. A caller-driven frame — especially export,
      // which renders many frames without yielding — must be a new node frame, or it shows a stale image.
      (renderer as unknown as { _nodes?: { nodeFrame?: { update(): void } } })._nodes?.nodeFrame?.update();
      step(bounded, now);
    },
    prepare(targets) { for (const target of targets) system.prepare(target); },
    async settle() {
      const device = (renderer.backend as { device?: GPUDevice }).device;
      await device?.queue.onSubmittedWorkDone();
    },
    formationEnd: system.formation?.end ?? null,
    dispose: cleanup,
  };
  const animate = (now: number) => {
    if (stopped) return;
    const rawDt = (now - last) / 1000;
    last = now;
    if (!document.hidden) {
      const dt = Math.min(Math.max(rawDt, 0), STEP * 8);
      if (rawDt > 0 && rawDt < 0.15) frameMs += (rawDt * 1000 - frameMs) * 0.05;
      if (fixed === null && quality.sample(rawDt)) applyTier();
      if (!step(dt, now / 1000)) return;
    }
    if (!stopped) frame = requestAnimationFrame(animate);
  };
  if (options.loop !== "external") frame = requestAnimationFrame(animate);
  return handle;
}
