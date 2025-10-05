import type { MaterialType } from "../types/EditorTypes";

export class SplatMap {
  private resolution: number;
  private data: Float32Array; // RGBA: grass, dirt, rock, sand
  private waterMask: Float32Array; // Separate water mask (0-1)
  private wetnessMask: Float32Array; // Wetness/moisture mask (0-1) for puddles, rain effects
  private roadMask: Float32Array; // Road/path mask (0-1) for trails, roads

  constructor(resolution: number) {
    this.resolution = resolution;
    // 4 channels per pixel
    this.data = new Float32Array(resolution * resolution * 4);
    // Separate masks
    this.waterMask = new Float32Array(resolution * resolution);
    this.wetnessMask = new Float32Array(resolution * resolution);
    this.roadMask = new Float32Array(resolution * resolution);
    // Initialize with 100% grass
    this.fillWithMaterial("grass");
  }

  getResolution(): number {
    return this.resolution;
  }

  getData(): Float32Array {
    return this.data;
  }

  getWeights(x: number, z: number): [number, number, number, number] {
    if (x < 0 || x >= this.resolution || z < 0 || z >= this.resolution) {
      return [1, 0, 0, 0];
    }
    const idx = (z * this.resolution + x) * 4;
    return [
      this.data[idx],
      this.data[idx + 1],
      this.data[idx + 2],
      this.data[idx + 3],
    ];
  }

  setWeights(x: number, z: number, weights: [number, number, number, number]): void {
    if (x < 0 || x >= this.resolution || z < 0 || z >= this.resolution) {
      return;
    }
    const idx = (z * this.resolution + x) * 4;
    this.data[idx] = weights[0];
    this.data[idx + 1] = weights[1];
    this.data[idx + 2] = weights[2];
    this.data[idx + 3] = weights[3];
  }

  getMaterialChannel(material: MaterialType): number {
    switch (material) {
      case "grass": return 0;
      case "dirt": return 1;
      case "rock": return 2;
      case "sand": return 3;
      case "water": return -1; // Water uses separate mask, not splat channels
      default: return 0;
    }
  }

  // Get water mask value at position
  getWaterWeight(x: number, z: number): number {
    if (x < 0 || x >= this.resolution || z < 0 || z >= this.resolution) {
      return 0;
    }
    return this.waterMask[z * this.resolution + x];
  }

  // Get water mask array for BiomeDecorator
  getWaterMask(): Float32Array {
    return this.waterMask;
  }

  // Get wetness mask value at position
  getWetnessWeight(x: number, z: number): number {
    if (x < 0 || x >= this.resolution || z < 0 || z >= this.resolution) {
      return 0;
    }
    return this.wetnessMask[z * this.resolution + x];
  }

  // Set wetness mask value
  setWetnessWeight(x: number, z: number, value: number): void {
    if (x < 0 || x >= this.resolution || z < 0 || z >= this.resolution) {
      return;
    }
    this.wetnessMask[z * this.resolution + x] = Math.max(0, Math.min(1, value));
  }

  // Get wetness mask array
  getWetnessMask(): Float32Array {
    return this.wetnessMask;
  }

  // Get road mask value at position
  getRoadWeight(x: number, z: number): number {
    if (x < 0 || x >= this.resolution || z < 0 || z >= this.resolution) {
      return 0;
    }
    return this.roadMask[z * this.resolution + x];
  }

  // Set road mask value
  setRoadWeight(x: number, z: number, value: number): void {
    if (x < 0 || x >= this.resolution || z < 0 || z >= this.resolution) {
      return;
    }
    this.roadMask[z * this.resolution + x] = Math.max(0, Math.min(1, value));
  }

  // Get road mask array
  getRoadMask(): Float32Array {
    return this.roadMask;
  }

  fillWithMaterial(material: MaterialType): void {
    const channel = this.getMaterialChannel(material);
    for (let i = 0; i < this.resolution * this.resolution; i++) {
      this.data[i * 4] = channel === 0 ? 1 : 0;
      this.data[i * 4 + 1] = channel === 1 ? 1 : 0;
      this.data[i * 4 + 2] = channel === 2 ? 1 : 0;
      this.data[i * 4 + 3] = channel === 3 ? 1 : 0;
    }
  }

  paint(
    centerX: number,
    centerZ: number,
    radius: number,
    material: MaterialType,
    strength: number,
    falloff: number
  ): boolean {
    const channel = this.getMaterialChannel(material);
    const minX = Math.max(0, Math.floor(centerX - radius));
    const maxX = Math.min(this.resolution - 1, Math.ceil(centerX + radius));
    const minZ = Math.max(0, Math.floor(centerZ - radius));
    const maxZ = Math.min(this.resolution - 1, Math.ceil(centerZ + radius));

    let modified = false;
    let paintedCount = 0;

    // Handle water separately using water mask
    if (material === "water") {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          const dx = x - centerX;
          const dz = z - centerZ;
          const distance = Math.sqrt(dx * dx + dz * dz);

          if (distance <= radius) {
            const normalizedDist = distance / radius;
            const falloffAmount = Math.pow(1 - normalizedDist, 2 - falloff * 2);
            const paintStrength = strength * falloffAmount * 0.1;

            const maskIdx = z * this.resolution + x;
            this.waterMask[maskIdx] = Math.min(1, this.waterMask[maskIdx] + paintStrength);
            modified = true;
            paintedCount++;
          }
        }
      }
      return modified;
    }

    // Normal material painting
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - centerX;
        const dz = z - centerZ;
        const distance = Math.sqrt(dx * dx + dz * dz);

        if (distance <= radius) {
          const normalizedDist = distance / radius;
          const falloffAmount = Math.pow(1 - normalizedDist, 2 - falloff * 2);
          const paintStrength = strength * falloffAmount * 0.1;

          const idx = (z * this.resolution + x) * 4;

          // Increase target channel
          this.data[idx + channel] = Math.min(1, this.data[idx + channel] + paintStrength);

          // Normalize all channels
          this.normalize(idx);
          modified = true;
        }
      }
    }

    return modified;
  }

  private normalize(idx: number): void {
    const sum = this.data[idx] + this.data[idx + 1] + this.data[idx + 2] + this.data[idx + 3];
    if (sum > 0) {
      this.data[idx] /= sum;
      this.data[idx + 1] /= sum;
      this.data[idx + 2] /= sum;
      this.data[idx + 3] /= sum;
    }
  }

  toBase64(): string {
    // Combine all masks into single buffer
    // Format: data + waterMask + wetnessMask + roadMask
    const maskSize = this.resolution * this.resolution;
    const totalLength = this.data.length + maskSize * 3; // water + wetness + road
    const buffer = new ArrayBuffer(totalLength * 4);
    const view = new Float32Array(buffer);
    
    let offset = 0;
    view.set(this.data, offset);
    offset += this.data.length;
    view.set(this.waterMask, offset);
    offset += maskSize;
    view.set(this.wetnessMask, offset);
    offset += maskSize;
    view.set(this.roadMask, offset);
    
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  fromBase64(base64: string): void {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const view = new Float32Array(bytes.buffer);
    
    const maskSize = this.resolution * this.resolution;
    const expectedLengthV3 = this.data.length + maskSize * 3; // v3: all masks
    const expectedLengthV2 = this.data.length + maskSize;     // v2: water only
    
    if (view.length === expectedLengthV3) {
      // V3 format: includes all masks
      let offset = 0;
      this.data.set(view.subarray(offset, offset + this.data.length));
      offset += this.data.length;
      this.waterMask.set(view.subarray(offset, offset + maskSize));
      offset += maskSize;
      this.wetnessMask.set(view.subarray(offset, offset + maskSize));
      offset += maskSize;
      this.roadMask.set(view.subarray(offset, offset + maskSize));
    } else if (view.length === expectedLengthV2) {
      // V2 format: water only
      this.data.set(view.subarray(0, this.data.length));
      this.waterMask.set(view.subarray(this.data.length));
      this.wetnessMask.fill(0);
      this.roadMask.fill(0);
    } else {
      // V1 format: only data
      this.data.set(view);
      this.waterMask.fill(0);
      this.wetnessMask.fill(0);
      this.roadMask.fill(0);
    }
  }
}
