import type { MaterialType } from "../types/EditorTypes";

// Simple tileable noise for natural boundaries
function hash(x: number, y: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

function smoothNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;

  // Smoothstep interpolation
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  const n00 = hash(ix, iy);
  const n10 = hash(ix + 1, iy);
  const n01 = hash(ix, iy + 1);
  const n11 = hash(ix + 1, iy + 1);

  const nx0 = n00 * (1 - sx) + n10 * sx;
  const nx1 = n01 * (1 - sx) + n11 * sx;

  return nx0 * (1 - sy) + nx1 * sy;
}

// Fractal noise with multiple octaves
function fractalNoise(x: number, y: number, octaves: number = 3): number {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxValue = 0;

  for (let i = 0; i < octaves; i++) {
    value += smoothNoise(x * frequency, y * frequency) * amplitude;
    maxValue += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }

  return value / maxValue;
}

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

          // Lerp each channel toward target (1.0 for painted, 0.0 for others)
          for (let c = 0; c < 4; c++) {
            const target = c === channel ? 1.0 : 0.0;
            this.data[idx + c] += (target - this.data[idx + c]) * paintStrength;
          }
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

  /**
   * Load splatmap and water mask data, resampling with bilinear interpolation
   * if the source resolution differs from the current resolution.
   */
  loadFromData(srcSplatData: Float32Array, srcWaterMask: Float32Array, srcResolution: number): void {
    if (srcResolution === this.resolution) {
      this.data.set(srcSplatData);
      this.waterMask.set(srcWaterMask);
      return;
    }

    const dst = this.resolution;
    const src = srcResolution;
    const scale = (src - 1) / (dst - 1);

    for (let z = 0; z < dst; z++) {
      for (let x = 0; x < dst; x++) {
        const srcX = x * scale;
        const srcZ = z * scale;
        const x0 = Math.floor(srcX);
        const z0 = Math.floor(srcZ);
        const x1 = Math.min(x0 + 1, src - 1);
        const z1 = Math.min(z0 + 1, src - 1);
        const fx = srcX - x0;
        const fz = srcZ - z0;

        const dstIdx = (z * dst + x) * 4;

        // Bilinear interpolation for 4-channel splatmap
        for (let c = 0; c < 4; c++) {
          const v00 = srcSplatData[(z0 * src + x0) * 4 + c];
          const v10 = srcSplatData[(z0 * src + x1) * 4 + c];
          const v01 = srcSplatData[(z1 * src + x0) * 4 + c];
          const v11 = srcSplatData[(z1 * src + x1) * 4 + c];
          this.data[dstIdx + c] = (v00 * (1 - fx) + v10 * fx) * (1 - fz) + (v01 * (1 - fx) + v11 * fx) * fz;
        }

        // Bilinear interpolation for water mask
        const mIdx = z * dst + x;
        const w00 = srcWaterMask[z0 * src + x0];
        const w10 = srcWaterMask[z0 * src + x1];
        const w01 = srcWaterMask[z1 * src + x0];
        const w11 = srcWaterMask[z1 * src + x1];
        this.waterMask[mIdx] = (w00 * (1 - fx) + w10 * fx) * (1 - fz) + (w01 * (1 - fx) + w11 * fx) * fz;
      }
    }
  }

  /**
   * Make splat map seamless for infinite tiling.
   * EXTENDS biomes from one edge to the opposite edge so same biomes connect.
   * Steps:
   * 1. Make edges exactly match by taking MAX of both edges
   * 2. Blend edge values into the interior with smooth transition
   */
  makeSeamless(): void {
    const res = this.resolution;
    const blendWidth = Math.max(8, Math.floor(res * 0.15)); // 15% blend zone

    // Process main splat data (4 channels: grass, dirt, rock, sand)
    this.makeDataSeamless(this.data, 4, res, blendWidth);

    // Add noisy dissolve to biome boundaries for natural look
    this.dissolveBiomeBoundaries();

    // Process water mask - special handling with noisy boundaries
    this.makeWaterMaskSeamless(this.waterMask, res, blendWidth);

    // Process wetness mask
    this.makeMaskSeamless(this.wetnessMask, res, blendWidth);

    // Process road mask
    this.makeMaskSeamless(this.roadMask, res, blendWidth);
  }

  /**
   * Add noise-based dissolve effect to biome boundaries.
   * Makes transitions between biomes look natural and irregular.
   */
  private dissolveBiomeBoundaries(): void {
    const res = this.resolution;
    const channels = 4;
    const noiseScale = 0.08; // Smaller = larger noise features
    const dissolveStrength = 0.4; // How much to shift boundaries
    const edgeThreshold = 0.15; // Detect biome boundaries

    const newData = new Float32Array(this.data);

    for (let z = 1; z < res - 1; z++) {
      for (let x = 1; x < res - 1; x++) {
        const idx = (z * res + x) * channels;

        // Get current pixel's dominant biome
        let maxWeight = 0;
        let dominantChannel = 0;
        for (let c = 0; c < channels; c++) {
          if (this.data[idx + c] > maxWeight) {
            maxWeight = this.data[idx + c];
            dominantChannel = c;
          }
        }

        // Check if this pixel is near a biome boundary
        // by comparing with neighbors
        let isNearBoundary = false;
        const neighbors = [
          [-1, 0], [1, 0], [0, -1], [0, 1],
          [-1, -1], [1, -1], [-1, 1], [1, 1]
        ];

        for (const [dx, dz] of neighbors) {
          const nIdx = ((z + dz) * res + (x + dx)) * channels;
          let nMaxWeight = 0;
          let nDominant = 0;
          for (let c = 0; c < channels; c++) {
            if (this.data[nIdx + c] > nMaxWeight) {
              nMaxWeight = this.data[nIdx + c];
              nDominant = c;
            }
          }
          if (nDominant !== dominantChannel) {
            isNearBoundary = true;
            break;
          }
        }

        if (!isNearBoundary) continue;

        // Get noise value for this position
        const noise = fractalNoise(x * noiseScale, z * noiseScale, 4);

        // Sample a neighbor based on noise
        // This creates the irregular boundary effect
        const angle = noise * Math.PI * 2;
        const sampleDist = 1 + Math.floor(noise * 2);
        const sampleX = Math.round(x + Math.cos(angle) * sampleDist);
        const sampleZ = Math.round(z + Math.sin(angle) * sampleDist);

        if (sampleX >= 0 && sampleX < res && sampleZ >= 0 && sampleZ < res) {
          const sampleIdx = (sampleZ * res + sampleX) * channels;

          // Blend current pixel towards the sampled neighbor based on noise
          const blendAmount = dissolveStrength * (noise > 0.5 ? noise - 0.5 : 0.5 - noise) * 2;

          for (let c = 0; c < channels; c++) {
            newData[idx + c] = this.data[idx + c] * (1 - blendAmount) +
                               this.data[sampleIdx + c] * blendAmount;
          }
        }
      }
    }

    // Copy back
    this.data.set(newData);

    // Normalize weights
    for (let i = 0; i < res * res; i++) {
      const idx = i * channels;
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        sum += this.data[idx + c];
      }
      if (sum > 0) {
        for (let c = 0; c < channels; c++) {
          this.data[idx + c] /= sum;
        }
      }
    }

    // Ensure edges still match after dissolve
    // Copy left edge to right and top edge to bottom
    for (let z = 0; z < res; z++) {
      for (let c = 0; c < channels; c++) {
        const leftVal = this.data[(z * res + 0) * channels + c];
        const rightVal = this.data[(z * res + (res - 1)) * channels + c];
        const avgVal = (leftVal + rightVal) / 2;
        this.data[(z * res + 0) * channels + c] = avgVal;
        this.data[(z * res + (res - 1)) * channels + c] = avgVal;
      }
    }

    for (let x = 0; x < res; x++) {
      for (let c = 0; c < channels; c++) {
        const topVal = this.data[(0 * res + x) * channels + c];
        const bottomVal = this.data[((res - 1) * res + x) * channels + c];
        const avgVal = (topVal + bottomVal) / 2;
        this.data[(0 * res + x) * channels + c] = avgVal;
        this.data[((res - 1) * res + x) * channels + c] = avgVal;
      }
    }
  }

  /**
   * Make multi-channel data (biomes) seamless with noisy natural boundaries.
   * Uses fractal noise to create irregular, natural-looking transitions.
   */
  private makeDataSeamless(
    data: Float32Array,
    channels: number,
    res: number,
    blendWidth: number
  ): void {
    const smoothstep = (t: number): number => t * t * (3 - 2 * t);
    const noiseScale = 0.15; // Controls noise frequency
    const noiseStrength = 0.5; // How much noise affects blend boundary (0-1)

    // Step 1: Calculate unified edge values (MAX of both edges for each position)
    const leftRightEdge: Float32Array[] = [];
    const topBottomEdge: Float32Array[] = [];

    for (let c = 0; c < channels; c++) {
      leftRightEdge[c] = new Float32Array(res);
      topBottomEdge[c] = new Float32Array(res);

      for (let z = 0; z < res; z++) {
        const leftIdx = (z * res + 0) * channels + c;
        const rightIdx = (z * res + (res - 1)) * channels + c;
        leftRightEdge[c][z] = Math.max(data[leftIdx], data[rightIdx]);
      }

      for (let x = 0; x < res; x++) {
        const topIdx = (0 * res + x) * channels + c;
        const bottomIdx = ((res - 1) * res + x) * channels + c;
        topBottomEdge[c][x] = Math.max(data[topIdx], data[bottomIdx]);
      }
    }

    // Step 2: Apply with noisy blend boundaries
    const newData = new Float32Array(data);

    for (let z = 0; z < res; z++) {
      for (let x = 0; x < res; x++) {
        const idx = (z * res + x) * channels;

        // Get noise value for this position (tileable)
        const noise = fractalNoise(x * noiseScale, z * noiseScale, 3);
        const noiseOffset = (noise - 0.5) * 2 * noiseStrength * blendWidth;

        // Distance from each edge with noise-modulated blend width
        const distFromLeft = x;
        const distFromRight = res - 1 - x;
        const distFromTop = z;
        const distFromBottom = res - 1 - z;

        // Effective blend width varies with noise
        const effectiveBlendLeft = Math.max(4, blendWidth + noiseOffset);
        const effectiveBlendRight = Math.max(4, blendWidth - noiseOffset);
        const effectiveBlendTop = Math.max(4, blendWidth + noiseOffset);
        const effectiveBlendBottom = Math.max(4, blendWidth - noiseOffset);

        // Blend factors with noisy boundaries
        const leftBlend = distFromLeft < effectiveBlendLeft
          ? smoothstep(1 - distFromLeft / effectiveBlendLeft) : 0;
        const rightBlend = distFromRight < effectiveBlendRight
          ? smoothstep(1 - distFromRight / effectiveBlendRight) : 0;
        const topBlend = distFromTop < effectiveBlendTop
          ? smoothstep(1 - distFromTop / effectiveBlendTop) : 0;
        const bottomBlend = distFromBottom < effectiveBlendBottom
          ? smoothstep(1 - distFromBottom / effectiveBlendBottom) : 0;

        for (let c = 0; c < channels; c++) {
          let value = data[idx + c];

          if (leftBlend > 0 || rightBlend > 0) {
            const edgeVal = leftRightEdge[c][z];
            const blend = Math.max(leftBlend, rightBlend);
            value = value * (1 - blend) + edgeVal * blend;
          }

          if (topBlend > 0 || bottomBlend > 0) {
            const edgeVal = topBottomEdge[c][x];
            const blend = Math.max(topBlend, bottomBlend);
            value = value * (1 - blend) + edgeVal * blend;
          }

          newData[idx + c] = value;
        }
      }
    }

    // Step 3: Copy back and ensure exact edge equality
    data.set(newData);

    // Force edges to be exactly equal (necessary for seamless tiling)
    for (let z = 0; z < res; z++) {
      for (let c = 0; c < channels; c++) {
        const edgeVal = leftRightEdge[c][z];
        data[(z * res + 0) * channels + c] = edgeVal;
        data[(z * res + (res - 1)) * channels + c] = edgeVal;
      }
    }

    for (let x = 0; x < res; x++) {
      for (let c = 0; c < channels; c++) {
        const edgeVal = topBottomEdge[c][x];
        data[(0 * res + x) * channels + c] = edgeVal;
        data[((res - 1) * res + x) * channels + c] = edgeVal;
      }
    }

    // Normalize weights
    for (let i = 0; i < res * res; i++) {
      const idx = i * channels;
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        sum += data[idx + c];
      }
      if (sum > 0) {
        for (let c = 0; c < channels; c++) {
          data[idx + c] /= sum;
        }
      }
    }
  }

  /**
   * Make single-channel mask (water, wetness, road) seamless.
   * Same strategy: make edges match with MAX, then blend into interior.
   */
  private makeMaskSeamless(
    mask: Float32Array,
    res: number,
    blendWidth: number
  ): void {
    const smoothstep = (t: number): number => t * t * (3 - 2 * t);

    // Step 1: Calculate unified edge values (MAX of both edges)
    const leftRightEdge = new Float32Array(res);
    const topBottomEdge = new Float32Array(res);

    for (let z = 0; z < res; z++) {
      const leftVal = mask[z * res + 0];
      const rightVal = mask[z * res + (res - 1)];
      leftRightEdge[z] = Math.max(leftVal, rightVal);
    }

    for (let x = 0; x < res; x++) {
      const topVal = mask[0 * res + x];
      const bottomVal = mask[(res - 1) * res + x];
      topBottomEdge[x] = Math.max(topVal, bottomVal);
    }

    // Step 2: Blend edge values into interior
    const newMask = new Float32Array(mask);

    for (let z = 0; z < res; z++) {
      for (let x = 0; x < res; x++) {
        const idx = z * res + x;

        const distFromLeft = x;
        const distFromRight = res - 1 - x;
        const distFromTop = z;
        const distFromBottom = res - 1 - z;

        const leftBlend = distFromLeft < blendWidth ? smoothstep(1 - distFromLeft / blendWidth) : 0;
        const rightBlend = distFromRight < blendWidth ? smoothstep(1 - distFromRight / blendWidth) : 0;
        const topBlend = distFromTop < blendWidth ? smoothstep(1 - distFromTop / blendWidth) : 0;
        const bottomBlend = distFromBottom < blendWidth ? smoothstep(1 - distFromBottom / blendWidth) : 0;

        let value = mask[idx];

        // Blend with left-right unified edge
        if (leftBlend > 0 || rightBlend > 0) {
          const edgeVal = leftRightEdge[z];
          const blend = Math.max(leftBlend, rightBlend);
          value = value * (1 - blend) + edgeVal * blend;
        }

        // Blend with top-bottom unified edge
        if (topBlend > 0 || bottomBlend > 0) {
          const edgeVal = topBottomEdge[x];
          const blend = Math.max(topBlend, bottomBlend);
          value = value * (1 - blend) + edgeVal * blend;
        }

        newMask[idx] = Math.max(0, Math.min(1, value));
      }
    }

    // Step 3: Copy back and force exact edge equality
    mask.set(newMask);

    for (let z = 0; z < res; z++) {
      const edgeVal = leftRightEdge[z];
      mask[z * res + 0] = edgeVal;
      mask[z * res + (res - 1)] = edgeVal;
    }

    for (let x = 0; x < res; x++) {
      const edgeVal = topBottomEdge[x];
      mask[0 * res + x] = edgeVal;
      mask[(res - 1) * res + x] = edgeVal;
    }
  }

  /**
   * Make water mask seamless.
   * Water basins are already created by EditorEngine.mirrorWaterAtEdges(),
   * so here we just ensure edges match exactly.
   */
  private makeWaterMaskSeamless(
    mask: Float32Array,
    res: number,
    blendWidth: number
  ): void {
    // Simply average the edges and ensure they match
    // Left-Right edges
    for (let z = 0; z < res; z++) {
      const leftVal = mask[z * res + 0];
      const rightVal = mask[z * res + (res - 1)];
      const avgVal = (leftVal + rightVal) / 2;
      mask[z * res + 0] = avgVal;
      mask[z * res + (res - 1)] = avgVal;
    }

    // Top-Bottom edges
    for (let x = 0; x < res; x++) {
      const topVal = mask[0 * res + x];
      const bottomVal = mask[(res - 1) * res + x];
      const avgVal = (topVal + bottomVal) / 2;
      mask[0 * res + x] = avgVal;
      mask[(res - 1) * res + x] = avgVal;
    }
  }

  /**
   * Get edge data for debugging tile boundary connections
   */
  getEdgeDebugData(): {
    left: { biome: number[]; water: number }[];
    right: { biome: number[]; water: number }[];
    top: { biome: number[]; water: number }[];
    bottom: { biome: number[]; water: number }[];
  } {
    const res = this.resolution;
    const sampleCount = Math.min(10, res);
    const step = Math.floor(res / sampleCount);

    const sample = (x: number, z: number) => ({
      biome: Array.from(this.getWeights(x, z)),
      water: this.getWaterWeight(x, z),
    });

    const left: { biome: number[]; water: number }[] = [];
    const right: { biome: number[]; water: number }[] = [];
    const top: { biome: number[]; water: number }[] = [];
    const bottom: { biome: number[]; water: number }[] = [];

    for (let i = 0; i < sampleCount; i++) {
      const pos = i * step;
      left.push(sample(0, pos));
      right.push(sample(res - 1, pos));
      top.push(sample(pos, 0));
      bottom.push(sample(pos, res - 1));
    }

    return { left, right, top, bottom };
  }
}
