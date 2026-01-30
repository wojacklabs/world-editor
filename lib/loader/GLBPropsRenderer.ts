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

import {
  Scene,
  Vector3,
  SceneLoader,
  TransformNode,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import type { PropInstance } from "./types";

export interface GLBPropsRendererOptions {
  /** Base URL for resolving relative GLB paths */
  baseUrl?: string;
  /** Callback when a prop fails to load */
  onLoadError?: (prop: PropInstance, error: Error) => void;
}

export class GLBPropsRenderer {
  private scene: Scene;
  private options: GLBPropsRendererOptions;
  private loadedProps: Map<string, TransformNode> = new Map();

  constructor(scene: Scene, options: GLBPropsRendererOptions = {}) {
    this.scene = scene;
    this.options = {
      baseUrl: options.baseUrl ?? "",
      onLoadError: options.onLoadError,
    };
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

      // Extract root and filename
      const lastSlash = url.lastIndexOf("/");
      const rootUrl = lastSlash >= 0 ? url.substring(0, lastSlash + 1) : "";
      const fileName = lastSlash >= 0 ? url.substring(lastSlash + 1) : url;

      // Load GLB
      const result = await SceneLoader.ImportMeshAsync(
        "",
        rootUrl,
        fileName,
        this.scene
      );

      if (result.meshes.length === 0) {
        throw new Error("No meshes in GLB file");
      }

      // Create parent transform node
      const parent = new TransformNode(`prop_${prop.id}`, this.scene);

      // Parent all loaded meshes
      for (const mesh of result.meshes) {
        if (!mesh.parent) {
          mesh.parent = parent;
        }
      }

      // Apply transform
      parent.position = new Vector3(
        prop.position.x,
        prop.position.y,
        prop.position.z
      );
      parent.rotation = new Vector3(
        prop.rotation.x,
        prop.rotation.y,
        prop.rotation.z
      );
      parent.scaling = new Vector3(prop.scale.x, prop.scale.y, prop.scale.z);

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
  getProp(propId: string): TransformNode | undefined {
    return this.loadedProps.get(propId);
  }

  /**
   * Set visibility for all props
   */
  setVisible(visible: boolean): void {
    for (const node of this.loadedProps.values()) {
      node.setEnabled(visible);
    }
  }

  /**
   * Remove a prop
   */
  removeProp(propId: string): void {
    const node = this.loadedProps.get(propId);
    if (node) {
      // Dispose all child meshes
      const meshes = node.getChildMeshes();
      for (const mesh of meshes) {
        mesh.dispose();
      }
      node.dispose();
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
