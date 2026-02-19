/**
 * PointLightsRenderer - Point light rendering for loader
 *
 * Creates Three.js PointLight objects from serialized light data.
 */

import * as THREE from "three";
import type { SerializedPointLight } from "./types";

export class PointLightsRenderer {
  private scene: THREE.Scene;
  private lights: THREE.PointLight[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  loadLights(data: SerializedPointLight[]): void {
    this.dispose();

    for (const light of data) {
      const pointLight = new THREE.PointLight(
        new THREE.Color(light.color.r, light.color.g, light.color.b),
        light.intensity,
        light.range
      );
      pointLight.position.set(light.position.x, light.position.y, light.position.z);
      pointLight.name = `pointLight_${light.id}`;

      this.scene.add(pointLight);
      this.lights.push(pointLight);
    }
  }

  dispose(): void {
    for (const light of this.lights) {
      this.scene.remove(light);
      light.dispose();
    }
    this.lights = [];
  }
}
