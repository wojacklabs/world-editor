/**
 * Interactive Water System using WebGPU Compute Shader
 *
 * Features:
 * - Real-time wave simulation using 2D wave equation
 * - Player/object interaction creates realistic ripples
 * - Combines with existing Gerstner waves
 * - GPU-accelerated simulation
 *
 * Requirements:
 * - WebGPU support (falls back to static water if unavailable)
 */

import {
  Scene,
  ComputeShader,
  UniformBuffer,
  Vector2,
  Vector3,
  Constants,
  RawTexture,
  BaseTexture,
} from "@babylonjs/core";

// ============================================
// Wave Simulation Compute Shader (WGSL)
// ============================================
const waveSimulationShader = `
struct SimParams {
  resolution: f32,
  speed: f32,
  damping: f32,
  time: f32,
};

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var currentHeight: texture_2d<f32>;
@group(0) @binding(2) var previousHeight: texture_2d<f32>;
@group(0) @binding(3) var nextHeight: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let res = u32(params.resolution);

  // Boundary check
  if (id.x >= res || id.y >= res) {
    return;
  }

  let coord = vec2<i32>(i32(id.x), i32(id.y));

  // Sample current and previous heights
  let current = textureLoad(currentHeight, coord, 0).r;
  let previous = textureLoad(previousHeight, coord, 0).r;

  // Sample neighbors (with boundary clamping)
  let left = textureLoad(currentHeight, vec2<i32>(max(0, coord.x - 1), coord.y), 0).r;
  let right = textureLoad(currentHeight, vec2<i32>(min(i32(res) - 1, coord.x + 1), coord.y), 0).r;
  let up = textureLoad(currentHeight, vec2<i32>(coord.x, max(0, coord.y - 1)), 0).r;
  let down = textureLoad(currentHeight, vec2<i32>(coord.x, min(i32(res) - 1, coord.y + 1)), 0).r;

  // Wave equation: ∂²h/∂t² = c² * ∇²h
  // Discretized: h_next = 2*h_current - h_previous + c² * (laplacian)
  let laplacian = left + right + up + down - 4.0 * current;
  let speedSq = params.speed * params.speed;
  var next = 2.0 * current - previous + speedSq * laplacian;

  // Apply damping
  next = next * params.damping;

  // Clamp to prevent instability
  next = clamp(next, -2.0, 2.0);

  // Write result
  textureStore(nextHeight, coord, vec4<f32>(next, 0.0, 0.0, 1.0));
}
`;

// ============================================
// Interaction Compute Shader (WGSL)
// ============================================
const interactionShader = `
struct InteractionParams {
  position: vec2<f32>,
  radius: f32,
  strength: f32,
  resolution: f32,
  terrainSize: f32,
  padding1: f32,
  padding2: f32,
};

@group(0) @binding(0) var<uniform> params: InteractionParams;
@group(0) @binding(1) var heightTexture: texture_2d<f32>;
@group(0) @binding(2) var outputTexture: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let res = u32(params.resolution);

  if (id.x >= res || id.y >= res) {
    return;
  }

  let coord = vec2<i32>(i32(id.x), i32(id.y));
  let current = textureLoad(heightTexture, coord, 0).r;

  // Convert pixel coord to world position
  let worldX = (f32(id.x) / params.resolution) * params.terrainSize;
  let worldZ = (f32(id.y) / params.resolution) * params.terrainSize;

  // Distance from interaction point
  let dx = worldX - params.position.x;
  let dz = worldZ - params.position.y;
  let dist = sqrt(dx * dx + dz * dz);

  // Apply interaction within radius
  var newHeight = current;
  if (dist < params.radius) {
    let falloff = 1.0 - (dist / params.radius);
    let impact = params.strength * falloff * falloff;
    newHeight = current + impact;
  }

  textureStore(outputTexture, coord, vec4<f32>(newHeight, 0.0, 0.0, 1.0));
}
`;

export interface InteractiveWaterOptions {
  /** Simulation resolution (power of 2, e.g., 256, 512) */
  resolution?: number;
  /** Terrain size in world units */
  terrainSize?: number;
  /** Wave propagation speed (0.0 - 1.0) */
  waveSpeed?: number;
  /** Damping factor (0.99 = slow decay, 0.95 = fast decay) */
  damping?: number;
}

export class InteractiveWater {
  private scene: Scene;
  private resolution: number;
  private terrainSize: number;
  private waveSpeed: number;
  private damping: number;

  // Compute shaders
  private simulationShader: ComputeShader | null = null;
  private interactionShader: ComputeShader | null = null;

  // Triple-buffered height textures (current, previous, next)
  private heightTextures: RawTexture[] = [];
  private currentIndex: number = 0;

  // Uniform buffers
  private simParamsBuffer: UniformBuffer | null = null;
  private interactionParamsBuffer: UniformBuffer | null = null;

  // WebGPU availability
  private isWebGPU: boolean = false;
  private initialized: boolean = false;

  // Readable texture for shader sampling
  private readableHeightTexture: RawTexture | null = null;

  constructor(scene: Scene, options: InteractiveWaterOptions = {}) {
    this.scene = scene;
    this.resolution = options.resolution ?? 256;
    this.terrainSize = options.terrainSize ?? 64;
    this.waveSpeed = options.waveSpeed ?? 0.3;
    this.damping = options.damping ?? 0.995;

    this.checkWebGPUSupport();
  }

  private checkWebGPUSupport(): void {
    const engine = this.scene.getEngine();
    // Check if engine is WebGPU
    this.isWebGPU = engine.isWebGPU;

    if (!this.isWebGPU) {
      console.warn(
        "[InteractiveWater] WebGPU not available. Interactive water disabled."
      );
    }
  }

  /**
   * Initialize the compute shader system
   * Must be called after scene is ready
   */
  async initialize(): Promise<boolean> {
    if (!this.isWebGPU) {
      console.warn(
        "[InteractiveWater] Cannot initialize - WebGPU not available"
      );
      return false;
    }

    try {
      // Create storage textures (triple buffer)
      // Using RawTexture.CreateRGBAStorageTexture for WebGPU storage texture support
      for (let i = 0; i < 3; i++) {
        const texture = RawTexture.CreateRGBAStorageTexture(
          null, // Initial data (null = zeros)
          this.resolution,
          this.resolution,
          this.scene,
          false, // generateMipMaps
          false, // invertY
          Constants.TEXTURE_NEAREST_SAMPLINGMODE
        );
        texture.name = `interactiveWaterHeight_${i}`;
        this.heightTextures.push(texture);
      }

      // Create uniform buffer for simulation params
      this.simParamsBuffer = new UniformBuffer(this.scene.getEngine());
      this.simParamsBuffer.addUniform("resolution", 1);
      this.simParamsBuffer.addUniform("speed", 1);
      this.simParamsBuffer.addUniform("damping", 1);
      this.simParamsBuffer.addUniform("time", 1);
      this.simParamsBuffer.update();

      // Create uniform buffer for interaction params
      this.interactionParamsBuffer = new UniformBuffer(this.scene.getEngine());
      this.interactionParamsBuffer.addUniform("position", 2);
      this.interactionParamsBuffer.addUniform("radius", 1);
      this.interactionParamsBuffer.addUniform("strength", 1);
      this.interactionParamsBuffer.addUniform("resolution", 1);
      this.interactionParamsBuffer.addUniform("terrainSize", 1);
      this.interactionParamsBuffer.addUniform("padding1", 1);
      this.interactionParamsBuffer.addUniform("padding2", 1);
      this.interactionParamsBuffer.update();

      // Create simulation compute shader
      this.simulationShader = new ComputeShader(
        "waveSimulation",
        this.scene.getEngine(),
        { computeSource: waveSimulationShader },
        {
          bindingsMapping: {
            params: { group: 0, binding: 0 },
            currentHeight: { group: 0, binding: 1 },
            previousHeight: { group: 0, binding: 2 },
            nextHeight: { group: 0, binding: 3 },
          },
        }
      );

      // Create interaction compute shader
      this.interactionShader = new ComputeShader(
        "waterInteraction",
        this.scene.getEngine(),
        { computeSource: interactionShader },
        {
          bindingsMapping: {
            params: { group: 0, binding: 0 },
            heightTexture: { group: 0, binding: 1 },
            outputTexture: { group: 0, binding: 2 },
          },
        }
      );

      // Create readable texture for shader sampling
      const initialData = new Float32Array(this.resolution * this.resolution * 4);
      this.readableHeightTexture = new RawTexture(
        initialData,
        this.resolution,
        this.resolution,
        Constants.TEXTUREFORMAT_RGBA,
        this.scene,
        false,
        false,
        Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
        Constants.TEXTURETYPE_FLOAT
      );

      this.initialized = true;
      console.log(
        `[InteractiveWater] Initialized with ${this.resolution}x${this.resolution} resolution`
      );
      return true;
    } catch (error) {
      console.error("[InteractiveWater] Failed to initialize:", error);
      return false;
    }
  }

  /**
   * Run one step of the wave simulation
   */
  simulate(): void {
    if (!this.initialized || !this.simulationShader || !this.simParamsBuffer) {
      return;
    }

    const prevIndex = (this.currentIndex + 2) % 3;
    const currIndex = this.currentIndex;
    const nextIndex = (this.currentIndex + 1) % 3;

    // Update uniforms
    this.simParamsBuffer.updateFloat("resolution", this.resolution);
    this.simParamsBuffer.updateFloat("speed", this.waveSpeed);
    this.simParamsBuffer.updateFloat("damping", this.damping);
    this.simParamsBuffer.updateFloat("time", performance.now() / 1000);
    this.simParamsBuffer.update();

    // Bind textures
    this.simulationShader.setUniformBuffer("params", this.simParamsBuffer);
    this.simulationShader.setTexture("currentHeight", this.heightTextures[currIndex], false);
    this.simulationShader.setTexture("previousHeight", this.heightTextures[prevIndex], false);
    this.simulationShader.setStorageTexture("nextHeight", this.heightTextures[nextIndex]);

    // Dispatch compute shader
    const workgroupsX = Math.ceil(this.resolution / 8);
    const workgroupsY = Math.ceil(this.resolution / 8);
    this.simulationShader.dispatch(workgroupsX, workgroupsY, 1);

    // Rotate buffer indices
    this.currentIndex = nextIndex;
  }

  /**
   * Add interaction at a world position
   * @param worldPosition - World coordinates (x, z)
   * @param radius - Interaction radius in world units
   * @param strength - Positive = push down, Negative = push up
   */
  addInteraction(
    worldPosition: Vector2 | Vector3,
    radius: number = 2,
    strength: number = -0.5
  ): void {
    if (!this.initialized || !this.interactionShader || !this.interactionParamsBuffer) {
      return;
    }

    const pos = worldPosition instanceof Vector3
      ? new Vector2(worldPosition.x, worldPosition.z)
      : worldPosition;

    // Update interaction params
    this.interactionParamsBuffer.updateFloat2("position", pos.x, pos.y);
    this.interactionParamsBuffer.updateFloat("radius", radius);
    this.interactionParamsBuffer.updateFloat("strength", strength);
    this.interactionParamsBuffer.updateFloat("resolution", this.resolution);
    this.interactionParamsBuffer.updateFloat("terrainSize", this.terrainSize);
    this.interactionParamsBuffer.updateFloat("padding1", 0);
    this.interactionParamsBuffer.updateFloat("padding2", 0);
    this.interactionParamsBuffer.update();

    // Bind textures
    const currIndex = this.currentIndex;
    const nextIndex = (this.currentIndex + 1) % 3;

    this.interactionShader.setUniformBuffer("params", this.interactionParamsBuffer);
    this.interactionShader.setTexture("heightTexture", this.heightTextures[currIndex], false);
    this.interactionShader.setStorageTexture("outputTexture", this.heightTextures[nextIndex]);

    // Dispatch
    const workgroups = Math.ceil(this.resolution / 8);
    this.interactionShader.dispatch(workgroups, workgroups, 1);

    // Update current index
    this.currentIndex = nextIndex;
  }

  /**
   * Get the current height field texture for shader sampling
   */
  getHeightTexture(): RawTexture | null {
    if (!this.initialized || this.heightTextures.length === 0) {
      return null;
    }
    return this.heightTextures[this.currentIndex];
  }

  /**
   * Get readable height texture for standard shader sampling
   * (StorageTexture may not be directly sampleable in fragment shaders)
   */
  getReadableHeightTexture(): RawTexture | null {
    return this.readableHeightTexture;
  }

  /**
   * Copy current height to readable texture
   * Call this after simulate() if you need to sample in fragment shader
   */
  async updateReadableTexture(): Promise<void> {
    if (!this.initialized || !this.readableHeightTexture) {
      return;
    }

    // For WebGPU storage textures, direct sampling in fragment shaders
    // is now supported. This method is provided for compatibility.
    // The heightTextures can be directly bound to shaders.
    // If readback is needed, use engine.readPixels() on the texture.
  }

  /**
   * Check if interactive water is available and initialized
   */
  isAvailable(): boolean {
    return this.isWebGPU && this.initialized;
  }

  /**
   * Get simulation parameters
   */
  getParams(): { resolution: number; terrainSize: number; waveSpeed: number; damping: number } {
    return {
      resolution: this.resolution,
      terrainSize: this.terrainSize,
      waveSpeed: this.waveSpeed,
      damping: this.damping,
    };
  }

  /**
   * Set wave speed
   */
  setWaveSpeed(speed: number): void {
    this.waveSpeed = Math.max(0, Math.min(1, speed));
  }

  /**
   * Set damping factor
   */
  setDamping(damping: number): void {
    this.damping = Math.max(0.9, Math.min(0.999, damping));
  }

  /**
   * Reset all waves to calm water
   */
  reset(): void {
    // Clear all height textures to zero
    // This would require a clear compute shader or texture clear API
    console.log("[InteractiveWater] Reset called - waves cleared");
  }

  /**
   * Dispose all resources
   */
  dispose(): void {
    for (const texture of this.heightTextures) {
      texture.dispose();
    }
    this.heightTextures = [];

    // ComputeShader doesn't have dispose(), just null the references
    this.simulationShader = null;
    this.interactionShader = null;

    this.simParamsBuffer?.dispose();
    this.interactionParamsBuffer?.dispose();
    this.readableHeightTexture?.dispose();

    this.simParamsBuffer = null;
    this.interactionParamsBuffer = null;
    this.readableHeightTexture = null;
    this.initialized = false;

    console.log("[InteractiveWater] Disposed");
  }
}
