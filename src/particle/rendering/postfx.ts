import { PostProcessing, WebGPURenderer } from "three/webgpu";
import type { Camera, Scene } from "three";
import { pass } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import type { ParticleConfig } from "@/config/particleDefaults";

export function createPostFX(renderer: WebGPURenderer, scene: Scene, camera: Camera, config: ParticleConfig) {
  const scenePass = pass(scene, camera);
  const output = scenePass.getTextureNode("output");
  const glow = bloom(output, config.bloom.strength, config.bloom.radius, config.bloom.threshold);
  const post = new PostProcessing(renderer);
  post.outputNode = output.add(glow);
  return { post, scenePass, glow };
}
