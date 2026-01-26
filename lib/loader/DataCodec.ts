/**
 * DataCodec - Pure encoding/decoding utilities
 *
 * Features:
 * - No Babylon.js runtime dependency
 * - Browser/Node.js compatible
 * - Static methods for easy use
 */
export class DataCodec {
  // ============================================
  // Core Float32Array <-> Base64
  // ============================================

  /**
   * Encode Float32Array to Base64 string
   */
  static encodeFloat32Array(arr: Float32Array): string {
    const uint8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    let binary = "";
    for (let i = 0; i < uint8.length; i++) {
      binary += String.fromCharCode(uint8[i]);
    }
    // Browser: btoa, Node.js: Buffer
    if (typeof btoa !== "undefined") {
      return btoa(binary);
    }
    return Buffer.from(binary, "binary").toString("base64");
  }

  /**
   * Decode Base64 string to Float32Array
   */
  static decodeFloat32Array(base64: string): Float32Array {
    // Browser: atob, Node.js: Buffer
    let binary: string;
    if (typeof atob !== "undefined") {
      binary = atob(base64);
    } else {
      binary = Buffer.from(base64, "base64").toString("binary");
    }

    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Float32Array(bytes.buffer);
  }

  // ============================================
  // Heightmap Specialization
  // ============================================

  /**
   * Encode heightmap data
   */
  static encodeHeightmap(data: Float32Array): string {
    return this.encodeFloat32Array(data);
  }

  /**
   * Decode heightmap data
   */
  static decodeHeightmap(base64: string): Float32Array {
    return this.decodeFloat32Array(base64);
  }

  // ============================================
  // SplatMap Specialization (with masks)
  // ============================================

  /**
   * Encode splatmap with optional masks
   * V3 format: data + waterMask + wetnessMask + roadMask
   * V2 format: data + waterMask
   * V1 format: data only
   */
  static encodeSplatmap(
    data: Float32Array,
    waterMask: Float32Array,
    wetnessMask?: Float32Array,
    roadMask?: Float32Array
  ): string {
    const maskSize = waterMask.length;
    const hasExtendedMasks =
      wetnessMask && roadMask && wetnessMask.length > 0 && roadMask.length > 0;

    const totalLength = data.length + maskSize * (hasExtendedMasks ? 3 : 1);
    const combined = new Float32Array(totalLength);

    let offset = 0;
    combined.set(data, offset);
    offset += data.length;
    combined.set(waterMask, offset);

    if (hasExtendedMasks) {
      offset += maskSize;
      combined.set(wetnessMask!, offset);
      offset += maskSize;
      combined.set(roadMask!, offset);
    }

    return this.encodeFloat32Array(combined);
  }

  /**
   * Decode splatmap with version detection
   * Automatically detects V1/V2/V3 format
   */
  static decodeSplatmap(
    base64: string,
    resolution: number
  ): {
    data: Float32Array;
    waterMask: Float32Array;
    wetnessMask: Float32Array;
    roadMask: Float32Array;
  } {
    const view = this.decodeFloat32Array(base64);
    const res = resolution + 1;
    const maskSize = res * res;
    const dataLength = maskSize * 4; // 4 RGBA channels

    const result = {
      data: new Float32Array(dataLength),
      waterMask: new Float32Array(maskSize),
      wetnessMask: new Float32Array(maskSize),
      roadMask: new Float32Array(maskSize),
    };

    const expectedV3 = dataLength + maskSize * 3;
    const expectedV2 = dataLength + maskSize;

    if (view.length === expectedV3) {
      // V3: all masks included
      let offset = 0;
      result.data.set(view.subarray(offset, offset + dataLength));
      offset += dataLength;
      result.waterMask.set(view.subarray(offset, offset + maskSize));
      offset += maskSize;
      result.wetnessMask.set(view.subarray(offset, offset + maskSize));
      offset += maskSize;
      result.roadMask.set(view.subarray(offset, offset + maskSize));
    } else if (view.length === expectedV2) {
      // V2: water mask only
      result.data.set(view.subarray(0, dataLength));
      result.waterMask.set(view.subarray(dataLength));
    } else if (view.length === dataLength) {
      // V1: data only
      result.data.set(view);
    } else {
      // Try to recover: assume splatmap data takes priority
      const copyLen = Math.min(view.length, dataLength);
      result.data.set(view.subarray(0, copyLen));
    }

    return result;
  }

  // ============================================
  // Foliage Instances
  // ============================================

  /**
   * Encode foliage instance matrices
   * Each instance is a 4x4 matrix (16 floats)
   */
  static encodeFoliageInstances(matrices: Float32Array): string {
    return this.encodeFloat32Array(matrices);
  }

  /**
   * Decode foliage instance matrices
   */
  static decodeFoliageInstances(base64: string): Float32Array {
    return this.decodeFloat32Array(base64);
  }

  // ============================================
  // JSON Utilities
  // ============================================

  /**
   * Safely parse JSON
   */
  static parseJSON<T>(json: string): T | null {
    try {
      return JSON.parse(json) as T;
    } catch {
      return null;
    }
  }

  /**
   * Validate array size matches expected resolution
   */
  static validateArraySize(
    arr: Float32Array,
    resolution: number,
    channels: number = 1
  ): boolean {
    const res = resolution + 1; // Heightmap uses resolution + 1
    const expectedSize = res * res * channels;
    return arr.length === expectedSize;
  }

  /**
   * Get instance count from matrices array
   * Each instance = 16 floats (4x4 matrix)
   */
  static getInstanceCount(matrices: Float32Array): number {
    return Math.floor(matrices.length / 16);
  }
}
