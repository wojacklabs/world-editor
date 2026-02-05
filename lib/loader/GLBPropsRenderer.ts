/**
 * GLBPropsRenderer - Loads and renders user-placed GLB assets
 *
 * Usage:
 * ```typescript
 * import { WorldLoader, GLBPropsRenderer } from "@world-editor/loader";
 *
 * const result = WorldLoader.loadWorld(json);
 * const renderer = new GLBPropsRenderer(scene);
 * await renderer.loadProps(result.data!.props);
 * ```
 */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { PropInstance } from "./types";
import { disposeMesh } from "../shared/rendering/threeHelpers";

export interface GLBPropsRendererOptions {
  /** Base URL for resolving relative GLB paths */
  baseUrl?: string;
  /** Callback when a prop fails to load */
  onLoadError?: (prop: PropInstance, error: Error) => void;
}

export class GLBPropsRenderer {
  private scene: THREE.Scene;
  private options: GLBPropsRendererOptions;
  private loadedProps: Map<string, THREE.Group> = new Map();
  private gltfLoader: GLTFLoader;

  constructor(scene: THREE.Scene, options: GLBPropsRendererOptions = {}) {
    this.scene = scene;
    this.options = {
      baseUrl: options.baseUrl ?? "",
      onLoadError: options.onLoadError,
    };
    this.gltfLoader = new GLTFLoader();
  }

  /**
   * Load all GLB props
   */
  async loadProps(props: PropInstance[]): Promise<void> {
    if (props.length === 0) return;

    const loadPromises = props.map((prop) => this.loadProp(prop));
    await Promise.allSettled(loadPromises);

    console.log(
      `[GLBPropsRenderer] Loaded ${this.loadedProps.size}/${props.length} GLB props`
    );
  }

  /**
   * Load a single GLB prop
   */
  private async loadProp(prop: PropInstance): Promise<void> {
    if (!prop.glbPath) {
      console.warn(`[GLBPropsRenderer] Prop ${prop.id} has no glbPath`);
      return;
    }

    try {
      // Resolve URL
      let url = prop.glbPath;
      if (!url.startsWith("http") && !url.startsWith("/")) {
        url = this.options.baseUrl + url;
      }

      // Load GLB
      const gltf = await this.gltfLoader.loadAsync(url);

      // Create parent group
      const parent = new THREE.Group();
      parent.name = `prop_${prop.id}`;

      // Re-parent all top-level children from the loaded scene
      while (gltf.scene.children.length > 0) {
        parent.add(gltf.scene.children[0]);
      }

      // Apply transform
      parent.position.set(prop.position.x, prop.position.y, prop.position.z);
      parent.rotation.set(prop.rotation.x, prop.rotation.y, prop.rotation.z);
      parent.scale.set(prop.scale.x, prop.scale.y, prop.scale.z);

      this.scene.add(parent);
      this.loadedProps.set(prop.id, parent);
    } catch (error) {
      console.error(`[GLBPropsRenderer] Failed to load ${prop.glbPath}:`, error);
      if (this.options.onLoadError) {
        this.options.onLoadError(prop, error as Error);
      }
    }
  }

  /**
   * Get a loaded prop by ID
   */
  getProp(propId: string): THREE.Group | undefined {
    return this.loadedProps.get(propId);
  }

  /**
   * Set visibility for all props
   */
  setVisible(visible: boolean): void {
    for (const node of this.loadedProps.values()) {
      node.visible = visible;
    }
  }

  /**
   * Remove a prop
   */
  removeProp(propId: string): void {
    const node = this.loadedProps.get(propId);
    if (node) {
      disposeMesh(this.scene, node);
      this.loadedProps.delete(propId);
    }
  }

  /**
   * Dispose all resources
   */
  dispose(): void {
    for (const [id] of this.loadedProps) {
      this.removeProp(id);
    }
    this.loadedProps.clear();
  }
}
