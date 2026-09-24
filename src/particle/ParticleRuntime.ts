import { ACESFilmicToneMapping, PerspectiveCamera, Scene } from "three";
import { WebGPURenderer } from "three/webgpu";
import { particleDefaults, type ParticleConfig } from "@/config/particleDefaults";
import type { PresenceSignalSource } from "@/presence/signal";
import type { MorphTarget } from "@/visual-actions/types";
import { morphSpeechBlend } from "./morphBlend";
import { AdaptiveQuality, qualityRange, qualityTiers } from "./quality";
import { createParticleSystem } from "./ParticleSystem";
import { PointerPusher } from "./interaction/pointer";
import { syncUniforms } from "./physics/uniforms";
import { createPostFX } from "./rendering/postfx";
import { SpeechMotion } from "./speechMotion";

/** What the runtime reads each frame. It knows nothing about the Realtime session, tools or permissions. */
export interface MorphSource { sample(dt: number): number; readonly revision: number; readonly target: MorphTarget | null }
export interface RuntimeInputs { presence: PresenceSignalSource; morph: MorphSource }
export interface RuntimeHandle {
  readonly config: ParticleConfig;
  /** Development tuning: copy `config` into uniforms every frame. */
  tuning: boolean;
  quality(): { tier: number; ceiling: number; count: number; frameMs: number };
  setTier(tier: number): void;
  dispose(): void;
}

const STEP = 1 / 120;
export async function createParticleRuntime(
  container: HTMLElement, inputs: RuntimeInputs, lifetime: AbortSignal, onError: (message: string) => void,
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
  const range = qualityRange(coarse, navigator.hardwareConcurrency || 4, memory);
  const quality = new AdaptiveQuality(range.initial, range.max);
  // Buffers are sized for the session ceiling so the tier can rise without reallocation.
  const system = createParticleSystem(qualityTiers[range.max].count, config);
  system.setCount(qualityTiers[quality.tier].count);
  scene.add(system.mesh);
  const u = system.uniforms;
  const speechMotion = new SpeechMotion();
  const fx = createPostFX(renderer, scene, camera, config);
  const pointer = new PointerPusher(container, camera);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  renderer.domElement.setAttribute("aria-hidden", "true");
  container.append(renderer.domElement);
  let stopped = false, frame = 0, revision = -1, accumulator = 0, frameMs = 16.7;
  let last = performance.now();
  const resize = () => {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    camera.aspect = width / height;
    const extent = (config.geometry.radius + config.spring.maxOffset) * 1.07;
    camera.position.z = Math.max(7.4, extent / (Math.tan(camera.fov * Math.PI / 360) * Math.min(1, camera.aspect)));
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(devicePixelRatio, qualityTiers[quality.tier].pixelRatio));
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
    pointer.dispose();
    fx.post.dispose(); fx.scenePass.dispose(); fx.glow.dispose();
    system.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    document.removeEventListener("visibilitychange", visibility);
    lifetime.removeEventListener("abort", cleanup);
  };
  const visibility = () => { last = performance.now(); accumulator = 0; pointer.reset(); };
  document.addEventListener("visibilitychange", visibility);
  lifetime.addEventListener("abort", cleanup, { once: true });
  renderer.onDeviceLost = () => { if (!stopped) { cleanup(); onError("device-lost"); } };

  const handle: RuntimeHandle = {
    config, tuning: false,
    quality: () => ({ tier: quality.tier, ceiling: quality.ceiling, count: qualityTiers[quality.tier].count, frameMs }),
    setTier(tier) { quality.force(Math.min(range.max, tier)); applyTier(); },
    dispose: cleanup,
  };
  const animate = (now: number) => {
    if (stopped) return;
    const rawDt = (now - last) / 1000;
    last = now;
    if (!document.hidden) {
      const dt = Math.min(Math.max(rawDt, 0), STEP * 8);
      accumulator = Math.min(accumulator + dt, STEP * 8);
      if (rawDt > 0 && rawDt < 0.15) frameMs += (rawDt * 1000 - frameMs) * 0.05;
      if (quality.sample(rawDt)) applyTier();
      if (handle.tuning) {
        syncUniforms(u, config);
        fx.glow.strength.value = config.bloom.strength;
        fx.glow.radius.value = config.bloom.radius; fx.glow.threshold.value = config.bloom.threshold;
      }
      const presence = inputs.presence.sample(dt, now / 1000);
      const morph = inputs.morph.sample(dt);
      // The controller only replaces its target while the body is a sphere, so this upload never snaps.
      if (revision !== inputs.morph.revision) {
        revision = inputs.morph.revision;
        if (inputs.morph.target) {
          try { system.setTarget(inputs.morph.target); } catch { /* invalid targets are rejected upstream */ }
        }
      }
      u.morph.value = morph;
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
      u.motion.value = reducedMotion.matches ? 0.15 : 1;
      try {
        while (accumulator >= STEP) {
          pointer.step(STEP, config.pusher.follow, config.pusher.maxSpeed);
          u.pusherPosition.value.copy(pointer.position);
          u.pusherVelocity.value.copy(pointer.velocity);
          u.active.value = pointer.active ? (reducedMotion.matches ? 0.25 : 1) : 0;
          u.clock.value += STEP;
          renderer.compute(system.compute);
          if (stopped) return;
          accumulator -= STEP;
        }
        fx.post.render();
      } catch {
        if (!stopped) { cleanup(); onError("device-lost"); }
        return;
      }
    }
    if (!stopped) frame = requestAnimationFrame(animate);
  };
  frame = requestAnimationFrame(animate);
  return handle;
}
