/**
 * PostProcessingPipeline - Post-processing for loader rendering
 *
 * Mirrors the editor's post-processing pipeline:
 * EffectComposer + RenderPass + VolumetricFogPass + UnrealBloomPass + OutputPass
 */

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { VolumetricFogPass } from "@/lib/editor/weather/VolumetricFogPass";

export class PostProcessingPipeline {
  private composer: EffectComposer;
  private volumetricFogPass: VolumetricFogPass;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    width: number,
    height: number
  ) {
    // Create render target with depth texture for volumetric fog
    const renderTarget = new THREE.WebGLRenderTarget(width, height, {
      depthTexture: new THREE.DepthTexture(width, height),
      depthBuffer: true,
    });
    if (renderTarget.depthTexture) {
      renderTarget.depthTexture.format = THREE.DepthFormat;
      renderTarget.depthTexture.type = THREE.UnsignedIntType;
    }

    this.composer = new EffectComposer(renderer, renderTarget);

    // 1. Render pass
    const renderPass = new RenderPass(scene, camera);
    this.composer.addPass(renderPass);

    // 2. Volumetric fog pass
    this.volumetricFogPass = new VolumetricFogPass(
      camera,
      new THREE.Vector2(width, height)
    );
    this.volumetricFogPass.fogDensity = 0.015;
    this.volumetricFogPass.fogHeightFalloff = 0.08;
    this.volumetricFogPass.fogBaseHeight = 0.0;
    this.volumetricFogPass.godRayIntensity = 0.25;
    this.volumetricFogPass.steps = 16;
    this.composer.addPass(this.volumetricFogPass);

    // 3. Bloom pass (subtle)
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      0.3,   // strength
      0.15,  // radius — tight spread to avoid sky haze
      0.85   // threshold
    );
    this.composer.addPass(bloomPass);

    // 4. Output pass (tone mapping + color space)
    const outputPass = new OutputPass();
    this.composer.addPass(outputPass);

    // OutputPass handles tone mapping, so disable on renderer
    renderer.toneMapping = THREE.NoToneMapping;
  }

  getVolumetricFogPass(): VolumetricFogPass {
    return this.volumetricFogPass;
  }

  /**
   * Call every frame to update camera matrices for volumetric fog.
   */
  updateCamera(camera: THREE.Camera): void {
    this.volumetricFogPass.updateCamera(camera);
  }

  /**
   * Sync fog/sun parameters with weather system. Call when weather changes.
   */
  syncWeather(
    fogColor: THREE.Color,
    fogDensity: number,
    sunDirection: THREE.Vector3,
    sunColor: THREE.Color
  ): void {
    this.volumetricFogPass.syncWeather(fogColor, fogDensity, sunDirection, sunColor);
  }

  render(): void {
    this.composer.render();
  }

  resize(width: number, height: number): void {
    this.composer.setSize(width, height);
    this.volumetricFogPass.setSize(width, height);
  }

  dispose(): void {
    this.composer.dispose();
    this.volumetricFogPass.dispose();
  }
}
