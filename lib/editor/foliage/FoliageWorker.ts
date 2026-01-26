/**
 * FoliageWorker - Offloads heavy foliage instance matrix generation to a Web Worker
 *
 * This module provides a worker-based approach to generate foliage instances
 * without blocking the main thread.
 */

// Worker message types
export interface FoliageWorkerRequest {
  type: "generateInstances";
  id: number;  // Request ID for matching responses
  data: {
    startX: number;
    startZ: number;
    endX: number;
    endZ: number;
    terrainScale: number;
    config: {
      baseDensity: number;
      minScale: number;
      maxScale: number;
      biomeChannel: number;
      biomeThreshold: number;
      slopeMax: number;
      yOffset: number;
    };
    heightmapData: Float32Array;  // Transferred
    heightmapResolution: number;
    splatmapData: Uint8Array;     // Transferred (R,G,B,A per pixel)
    splatmapResolution: number;
    waterMaskData: Uint8Array;    // Transferred
    seed: number;
    variationCount: number;
    foliageType: "grass" | "rock";
  };
}

export interface FoliageWorkerResponse {
  type: "instancesGenerated";
  id: number;
  data: {
    variationMatrices: Float32Array[];  // One per variation
  };
}

// Inline worker code as a string (will be converted to Blob)
const workerCode = `
// Seeded random number generator
let seed = 12345;

function resetSeed(s) {
  seed = s;
}

function seededRandom() {
  seed = (seed * 9301 + 49297) % 233280;
  return seed / 233280;
}

// Get height from heightmap data
function getHeight(heightmapData, resolution, x, z, terrainScale) {
  const fx = (x / terrainScale) * (resolution - 1);
  const fz = (z / terrainScale) * (resolution - 1);

  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const dx = fx - ix;
  const dz = fz - iz;

  const ix0 = Math.max(0, Math.min(resolution - 1, ix));
  const ix1 = Math.max(0, Math.min(resolution - 1, ix + 1));
  const iz0 = Math.max(0, Math.min(resolution - 1, iz));
  const iz1 = Math.max(0, Math.min(resolution - 1, iz + 1));

  const h00 = heightmapData[iz0 * resolution + ix0];
  const h10 = heightmapData[iz0 * resolution + ix1];
  const h01 = heightmapData[iz1 * resolution + ix0];
  const h11 = heightmapData[iz1 * resolution + ix1];

  const h0 = h00 * (1 - dx) + h10 * dx;
  const h1 = h01 * (1 - dx) + h11 * dx;

  return h0 * (1 - dz) + h1 * dz;
}

// Get splat weights (returns [r, g, b, a])
function getSplatWeights(splatmapData, resolution, x, z, terrainScale) {
  const fx = (x / terrainScale) * (resolution - 1);
  const fz = (z / terrainScale) * (resolution - 1);

  const ix = Math.max(0, Math.min(resolution - 1, Math.floor(fx)));
  const iz = Math.max(0, Math.min(resolution - 1, Math.floor(fz)));

  const idx = (iz * resolution + ix) * 4;
  return [
    splatmapData[idx] / 255,
    splatmapData[idx + 1] / 255,
    splatmapData[idx + 2] / 255,
    splatmapData[idx + 3] / 255,
  ];
}

// Get water weight
function getWaterWeight(waterMaskData, resolution, x, z, terrainScale) {
  const fx = (x / terrainScale) * (resolution - 1);
  const fz = (z / terrainScale) * (resolution - 1);

  const ix = Math.max(0, Math.min(resolution - 1, Math.floor(fx)));
  const iz = Math.max(0, Math.min(resolution - 1, Math.floor(fz)));

  return waterMaskData[iz * resolution + ix] / 255;
}

// Calculate slope
function calculateSlope(heightmapData, resolution, x, z, terrainScale) {
  const delta = 0.5;
  const hL = getHeight(heightmapData, resolution, Math.max(0, x - delta), z, terrainScale);
  const hR = getHeight(heightmapData, resolution, Math.min(terrainScale, x + delta), z, terrainScale);
  const hD = getHeight(heightmapData, resolution, x, Math.max(0, z - delta), terrainScale);
  const hU = getHeight(heightmapData, resolution, x, Math.min(terrainScale, z + delta), terrainScale);

  const dx = (hR - hL) / (2 * delta);
  const dz = (hU - hD) / (2 * delta);

  const nx = -dx;
  const ny = 1;
  const nz = -dz;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);

  return 1 - (ny / len);
}

// Create transformation matrix (column-major for Babylon.js)
function createMatrix(scaleX, scaleY, scaleZ, rotY, rotX, rotZ, posX, posY, posZ) {
  // Rotation matrices
  const cy = Math.cos(rotY), sy = Math.sin(rotY);
  const cx = Math.cos(rotX), sx = Math.sin(rotX);
  const cz = Math.cos(rotZ), sz = Math.sin(rotZ);

  // Combined rotation: Z * X * Y
  const r00 = cy * cz + sy * sx * sz;
  const r01 = cz * sy * sx - cy * sz;
  const r02 = cx * sy;
  const r10 = cx * sz;
  const r11 = cx * cz;
  const r12 = -sx;
  const r20 = -cz * sy + cy * sx * sz;
  const r21 = sy * sz + cy * cz * sx;
  const r22 = cy * cx;

  // Scale and rotation combined
  return new Float32Array([
    r00 * scaleX, r10 * scaleX, r20 * scaleX, 0,
    r01 * scaleY, r11 * scaleY, r21 * scaleY, 0,
    r02 * scaleZ, r12 * scaleZ, r22 * scaleZ, 0,
    posX, posY, posZ, 1
  ]);
}

// Generate instances
function generateInstances(request) {
  const { startX, startZ, endX, endZ, terrainScale, config,
          heightmapData, heightmapResolution, splatmapData, splatmapResolution,
          waterMaskData, seed: baseSeed, variationCount, foliageType } = request;

  const variationMatrices = [];
  for (let i = 0; i < variationCount; i++) {
    variationMatrices.push([]);
  }

  resetSeed(Math.floor(startX * 1000 + startZ + (foliageType === 'grass' ? 500 : 0)));

  const area = (endX - startX) * (endZ - startZ);
  const targetInstances = Math.floor(area * config.baseDensity);
  const maxInstances = 5000;
  const instanceCount = Math.min(targetInstances, maxInstances);

  for (let i = 0; i < instanceCount; i++) {
    const x = startX + seededRandom() * (endX - startX);
    const z = startZ + seededRandom() * (endZ - startZ);

    // Get splat weights
    const weights = getSplatWeights(splatmapData, splatmapResolution, x, z, terrainScale);
    const biomeWeight = weights[config.biomeChannel];

    if (biomeWeight < config.biomeThreshold) continue;

    // Check water
    const waterWeight = getWaterWeight(waterMaskData, splatmapResolution, x, z, terrainScale);
    if (waterWeight > 0.1) continue;

    // Probability
    if (seededRandom() > biomeWeight) continue;

    // Height and slope
    const y = getHeight(heightmapData, heightmapResolution, x, z, terrainScale);
    const slope = calculateSlope(heightmapData, heightmapResolution, x, z, terrainScale);

    if (slope > config.slopeMax) continue;

    // Scale
    let sizeRandom = seededRandom();
    if (foliageType === 'rock') {
      sizeRandom = Math.pow(sizeRandom, 2.5);
    }
    const scaleBase = config.minScale + sizeRandom * (config.maxScale - config.minScale);
    const scale = scaleBase * (0.8 + seededRandom() * 0.4);

    // Rotation
    const rotY = seededRandom() * Math.PI * 2;
    let rotX = 0, rotZ = 0;
    if (foliageType === 'rock') {
      rotX = (seededRandom() - 0.5) * 0.2;
      rotZ = (seededRandom() - 0.5) * 0.2;
    }

    // Create matrix
    const matrix = createMatrix(scale, scale, scale, rotY, rotX, rotZ, x, y + config.yOffset, z);

    // Select variation
    const variationIndex = Math.floor(seededRandom() * variationCount);

    // Add to variation array
    for (let j = 0; j < 16; j++) {
      variationMatrices[variationIndex].push(matrix[j]);
    }
  }

  // Convert to Float32Arrays
  return variationMatrices.map(arr => new Float32Array(arr));
}

// Message handler
self.onmessage = function(e) {
  const request = e.data;

  if (request.type === 'generateInstances') {
    const result = generateInstances(request.data);

    // Transfer Float32Arrays back (zero-copy)
    const transferables = result.filter(arr => arr.length > 0).map(arr => arr.buffer);

    self.postMessage({
      type: 'instancesGenerated',
      id: request.id,
      data: {
        variationMatrices: result
      }
    }, transferables);
  }
};
`;

/**
 * FoliageWorkerPool - Manages a pool of foliage generation workers
 */
export class FoliageWorkerPool {
  private workers: Worker[] = [];
  private workerIndex = 0;
  private requestId = 0;
  private pendingRequests: Map<number, {
    resolve: (result: Float32Array[]) => void;
    reject: (error: Error) => void;
  }> = new Map();

  constructor(poolSize: number = 2) {
    // Create workers from inline code
    const blob = new Blob([workerCode], { type: "application/javascript" });
    const workerUrl = URL.createObjectURL(blob);

    for (let i = 0; i < poolSize; i++) {
      const worker = new Worker(workerUrl);
      worker.onmessage = this.handleMessage.bind(this);
      worker.onerror = this.handleError.bind(this);
      this.workers.push(worker);
    }

    console.log(`[FoliageWorkerPool] Created ${poolSize} workers`);
  }

  private handleMessage(e: MessageEvent<FoliageWorkerResponse>): void {
    const { id, data } = e.data;
    const pending = this.pendingRequests.get(id);

    if (pending) {
      pending.resolve(data.variationMatrices);
      this.pendingRequests.delete(id);
    }
  }

  private handleError(e: ErrorEvent): void {
    console.error("[FoliageWorkerPool] Worker error:", e);
  }

  /**
   * Generate foliage instances using a worker
   */
  async generateInstances(
    startX: number,
    startZ: number,
    endX: number,
    endZ: number,
    terrainScale: number,
    config: FoliageWorkerRequest["data"]["config"],
    heightmapData: Float32Array,
    heightmapResolution: number,
    splatmapData: Uint8Array,
    splatmapResolution: number,
    waterMaskData: Uint8Array,
    seed: number,
    variationCount: number,
    foliageType: "grass" | "rock"
  ): Promise<Float32Array[]> {
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      this.pendingRequests.set(id, { resolve, reject });

      // Round-robin worker selection
      const worker = this.workers[this.workerIndex];
      this.workerIndex = (this.workerIndex + 1) % this.workers.length;

      const request: FoliageWorkerRequest = {
        type: "generateInstances",
        id,
        data: {
          startX,
          startZ,
          endX,
          endZ,
          terrainScale,
          config,
          heightmapData,
          heightmapResolution,
          splatmapData,
          splatmapResolution,
          waterMaskData,
          seed,
          variationCount,
          foliageType,
        },
      };

      // Transfer arrays to worker (zero-copy)
      worker.postMessage(request, [
        heightmapData.buffer,
        splatmapData.buffer,
        waterMaskData.buffer,
      ]);
    });
  }

  /**
   * Terminate all workers
   */
  dispose(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.pendingRequests.clear();
    console.log("[FoliageWorkerPool] Disposed");
  }
}
