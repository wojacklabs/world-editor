import type { BrushSettings, HeightmapTool } from "../types/EditorTypes";

export class Heightmap {
  private resolution: number; // Number of vertices per side
  private scale: number; // World size in units
  private data: Float32Array;
  private minHeight: number = 0;
  private maxHeight: number = 0;

  constructor(resolution: number, scale: number) {
    // Resolution should be power of 2 + 1 (e.g., 65, 129, 257)
    this.resolution = resolution + 1;
    this.scale = scale;
    this.data = new Float32Array(this.resolution * this.resolution);
  }

  getResolution(): number {
    return this.resolution;
  }

  getScale(): number {
    return this.scale;
  }

  getData(): Float32Array {
    return this.data;
  }

  getMinHeight(): number {
    return this.minHeight;
  }

  getMaxHeight(): number {
    return this.maxHeight;
  }

  getHeight(x: number, z: number): number {
    if (x < 0 || x >= this.resolution || z < 0 || z >= this.resolution) {
      return 0;
    }
    return this.data[z * this.resolution + x];
  }

  setHeight(x: number, z: number, value: number): void {
    if (x < 0 || x >= this.resolution || z < 0 || z >= this.resolution) {
      return;
    }
    this.data[z * this.resolution + x] = value;
    this.updateMinMax(value);
  }

  private updateMinMax(value: number): void {
    if (value < this.minHeight) this.minHeight = value;
    if (value > this.maxHeight) this.maxHeight = value;
  }

  private recalculateMinMax(): void {
    this.minHeight = Infinity;
    this.maxHeight = -Infinity;
    for (let i = 0; i < this.data.length; i++) {
      if (this.data[i] < this.minHeight) this.minHeight = this.data[i];
      if (this.data[i] > this.maxHeight) this.maxHeight = this.data[i];
    }
    if (this.minHeight === Infinity) this.minHeight = 0;
    if (this.maxHeight === -Infinity) this.maxHeight = 0;
  }

  // Get interpolated height for world coordinates
  getInterpolatedHeight(worldX: number, worldZ: number): number {
    const cellSize = this.scale / (this.resolution - 1);
    const x = worldX / cellSize;
    const z = worldZ / cellSize;

    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const x1 = x0 + 1;
    const z1 = z0 + 1;

    const xFrac = x - x0;
    const zFrac = z - z0;

    const h00 = this.getHeight(x0, z0);
    const h10 = this.getHeight(x1, z0);
    const h01 = this.getHeight(x0, z1);
    const h11 = this.getHeight(x1, z1);

    // Bilinear interpolation
    const h0 = h00 * (1 - xFrac) + h10 * xFrac;
    const h1 = h01 * (1 - xFrac) + h11 * xFrac;

    return h0 * (1 - zFrac) + h1 * zFrac;
  }

  // Initialize with flat height
  generateFlat(height: number): void {
    this.data.fill(height);
    this.minHeight = height;
    this.maxHeight = height;
  }

  // Generate from multi-octave noise
  generateFromNoise(seed: number, amplitude: number = 10): void {
    for (let z = 0; z < this.resolution; z++) {
      for (let x = 0; x < this.resolution; x++) {
        // Multi-octave noise for natural-looking terrain
        let height = 0;
        let freq = 0.015;
        let amp = amplitude;

        for (let octave = 0; octave < 4; octave++) {
          const nx = x * freq + seed;
          const nz = z * freq + seed * 0.7;
          height += this.smoothNoise(nx, nz) * amp;
          freq *= 2;
          amp *= 0.5;
        }

        this.data[z * this.resolution + x] = height;
      }
    }

    this.recalculateMinMax();
  }

  private hash(x: number, y: number): number {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  }

  private smoothNoise(x: number, y: number): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = x0 + 1;
    const y1 = y0 + 1;

    const sx = x - x0;
    const sy = y - y0;

    // Smooth interpolation
    const u = sx * sx * (3 - 2 * sx);
    const v = sy * sy * (3 - 2 * sy);

    const n00 = this.hash(x0, y0) * 2 - 1;
    const n10 = this.hash(x1, y0) * 2 - 1;
    const n01 = this.hash(x0, y1) * 2 - 1;
    const n11 = this.hash(x1, y1) * 2 - 1;

    const nx0 = n00 * (1 - u) + n10 * u;
    const nx1 = n01 * (1 - u) + n11 * u;

    return nx0 * (1 - v) + nx1 * v;
  }

  // Apply brush at world coordinates
  applyBrush(
    worldX: number,
    worldZ: number,
    tool: HeightmapTool,
    settings: BrushSettings,
    deltaTime: number
  ): boolean {
    const cellSize = this.scale / (this.resolution - 1);
    const centerX = worldX / cellSize;
    const centerZ = worldZ / cellSize;
    const radius = settings.size / cellSize;

    const minX = Math.max(0, Math.floor(centerX - radius));
    const maxX = Math.min(this.resolution - 1, Math.ceil(centerX + radius));
    const minZ = Math.max(0, Math.floor(centerZ - radius));
    const maxZ = Math.min(this.resolution - 1, Math.ceil(centerZ + radius));

    let modified = false;

    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - centerX;
        const dz = z - centerZ;
        const distance = Math.sqrt(dx * dx + dz * dz);

        if (distance <= radius) {
          // Calculate falloff
          const normalizedDist = distance / radius;
          const falloff = this.calculateFalloff(normalizedDist, settings.falloff);

          const idx = z * this.resolution + x;
          const currentHeight = this.data[idx];
          let newHeight = currentHeight;

          const amount = settings.strength * falloff * deltaTime * 10;

          switch (tool) {
            case "raise":
              newHeight = currentHeight + amount;
              break;
            case "lower":
              newHeight = currentHeight - amount;
              break;
            case "flatten":
              // Flatten to center height
              const targetHeight = this.getInterpolatedHeight(worldX, worldZ);
              newHeight = currentHeight + (targetHeight - currentHeight) * falloff * 0.1;
              break;
            case "smooth":
              // Average with neighbors
              newHeight = this.getSmoothedHeight(x, z, falloff);
              break;
          }

          if (newHeight !== currentHeight) {
            this.data[idx] = newHeight;
            modified = true;
          }
        }
      }
    }

    if (modified) {
      this.recalculateMinMax();
    }

    return modified;
  }

  private calculateFalloff(normalizedDist: number, falloffStrength: number): number {
    // Smooth falloff using cosine interpolation
    const t = Math.pow(1 - normalizedDist, 2 - falloffStrength * 2);
    return Math.max(0, Math.min(1, t));
  }

  private getSmoothedHeight(x: number, z: number, falloff: number): number {
    let sum = 0;
    let count = 0;

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const nz = z + dz;
        if (nx >= 0 && nx < this.resolution && nz >= 0 && nz < this.resolution) {
          sum += this.data[nz * this.resolution + nx];
          count++;
        }
      }
    }

    const avgHeight = sum / count;
    const currentHeight = this.data[z * this.resolution + x];

    return currentHeight + (avgHeight - currentHeight) * falloff * 0.5;
  }

  // Make tile seamless (edges match for infinite tiling) with smooth blending
  makeSeamless(): void {
    const res = this.resolution;
    const blendWidth = Math.max(3, Math.floor(res * 0.15)); // 15% of resolution for blend zone

    // Smooth interpolation function (ease in-out)
    const smoothstep = (t: number): number => t * t * (3 - 2 * t);

    // First pass: Calculate target edge values (average of opposite edges)
    const leftRightAvg = new Float32Array(res);
    const topBottomAvg = new Float32Array(res);

    for (let z = 0; z < res; z++) {
      const leftVal = this.data[z * res];
      const rightVal = this.data[z * res + (res - 1)];
      leftRightAvg[z] = (leftVal + rightVal) / 2;
    }

    for (let x = 0; x < res; x++) {
      const topVal = this.data[x];
      const bottomVal = this.data[(res - 1) * res + x];
      topBottomAvg[x] = (topVal + bottomVal) / 2;
    }

    // Corner average
    const cornerAvg = (leftRightAvg[0] + leftRightAvg[res - 1] + topBottomAvg[0] + topBottomAvg[res - 1]) / 4;

    // Second pass: Apply gradual blending from edges inward
    const newData = new Float32Array(this.data);

    for (let z = 0; z < res; z++) {
      for (let x = 0; x < res; x++) {
        const idx = z * res + x;
        let value = this.data[idx];

        // Calculate blend factors for each edge (0 at edge, 1 at blend boundary)
        const leftDist = x;
        const rightDist = res - 1 - x;
        const topDist = z;
        const bottomDist = res - 1 - z;

        // Left-right blending
        if (leftDist < blendWidth) {
          const t = smoothstep(leftDist / blendWidth);
          const targetVal = leftRightAvg[z];
          value = targetVal + (value - targetVal) * t;
        } else if (rightDist < blendWidth) {
          const t = smoothstep(rightDist / blendWidth);
          const targetVal = leftRightAvg[z];
          value = targetVal + (value - targetVal) * t;
        }

        // Top-bottom blending (applied on top of left-right)
        if (topDist < blendWidth) {
          const t = smoothstep(topDist / blendWidth);
          const targetVal = topBottomAvg[x];
          value = targetVal + (value - targetVal) * t;
        } else if (bottomDist < blendWidth) {
          const t = smoothstep(bottomDist / blendWidth);
          const targetVal = topBottomAvg[x];
          value = targetVal + (value - targetVal) * t;
        }

        // Corner blending (for the 4 corners, blend towards corner average)
        const cornerDist = Math.min(
          Math.sqrt(leftDist * leftDist + topDist * topDist),
          Math.sqrt(rightDist * rightDist + topDist * topDist),
          Math.sqrt(leftDist * leftDist + bottomDist * bottomDist),
          Math.sqrt(rightDist * rightDist + bottomDist * bottomDist)
        );
        if (cornerDist < blendWidth) {
          const t = smoothstep(cornerDist / blendWidth);
          value = cornerAvg + (value - cornerAvg) * t;
        }

        newData[idx] = value;
      }
    }

    // Apply the blended data
    this.data.set(newData);

    // Ensure exact edge matching (edges must be identical for tiling)
    for (let z = 0; z < res; z++) {
      const avg = (this.data[z * res] + this.data[z * res + (res - 1)]) / 2;
      this.data[z * res] = avg;
      this.data[z * res + (res - 1)] = avg;
    }

    for (let x = 0; x < res; x++) {
      const avg = (this.data[x] + this.data[(res - 1) * res + x]) / 2;
      this.data[x] = avg;
      this.data[(res - 1) * res + x] = avg;
    }

    // Corners must all be identical
    this.data[0] = cornerAvg;
    this.data[res - 1] = cornerAvg;
    this.data[(res - 1) * res] = cornerAvg;
    this.data[(res - 1) * res + (res - 1)] = cornerAvg;

    this.recalculateMinMax();
  }

  // Export to PNG (8-bit grayscale)
  toPNGDataURL(): string {
    const canvas = document.createElement("canvas");
    canvas.width = this.resolution;
    canvas.height = this.resolution;
    const ctx = canvas.getContext("2d")!;
    const imageData = ctx.createImageData(this.resolution, this.resolution);

    const range = this.maxHeight - this.minHeight || 1;

    for (let i = 0; i < this.data.length; i++) {
      const normalizedHeight = (this.data[i] - this.minHeight) / range;
      const value = Math.floor(normalizedHeight * 255);

      imageData.data[i * 4] = value;
      imageData.data[i * 4 + 1] = value;
      imageData.data[i * 4 + 2] = value;
      imageData.data[i * 4 + 3] = 255;
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL("image/png");
  }

  // Export to Base64 (for project save)
  toBase64(): string {
    const buffer = new ArrayBuffer(this.data.length * 4);
    const view = new Float32Array(buffer);
    view.set(this.data);
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // Import from Base64
  fromBase64(base64: string): void {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const view = new Float32Array(bytes.buffer);
    this.data.set(view);
    this.recalculateMinMax();
  }
}
