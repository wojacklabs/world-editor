import { Matrix, Vector3, Quaternion } from "@babylonjs/core";

/**
 * Generic object pool for reusable objects
 * Reduces GC pressure by reusing frequently allocated objects
 */
class GenericPool<T> {
  private pool: T[] = [];
  private createFn: () => T;
  private resetFn: (obj: T) => void;

  constructor(createFn: () => T, resetFn: (obj: T) => void, initialSize: number = 0) {
    this.createFn = createFn;
    this.resetFn = resetFn;

    // Pre-allocate initial pool
    for (let i = 0; i < initialSize; i++) {
      this.pool.push(createFn());
    }
  }

  acquire(): T {
    if (this.pool.length > 0) {
      return this.pool.pop()!;
    }
    return this.createFn();
  }

  release(obj: T): void {
    this.resetFn(obj);
    this.pool.push(obj);
  }

  get size(): number {
    return this.pool.length;
  }

  clear(): void {
    this.pool.length = 0;
  }
}

/**
 * Singleton object pools for Babylon.js math objects
 * Usage:
 *   const mat = MathPools.matrix.acquire();
 *   // use mat...
 *   MathPools.matrix.release(mat);
 */
export const MathPools = {
  matrix: new GenericPool<Matrix>(
    () => new Matrix(),
    (m) => m.reset(),
    32  // Pre-allocate 32 matrices
  ),

  vector3: new GenericPool<Vector3>(
    () => new Vector3(),
    (v) => v.set(0, 0, 0),
    64  // Pre-allocate 64 vectors
  ),

  quaternion: new GenericPool<Quaternion>(
    () => new Quaternion(),
    (q) => q.set(0, 0, 0, 1),
    16  // Pre-allocate 16 quaternions
  ),

  /**
   * Helper: Execute function with pooled Matrix, auto-release
   */
  withMatrix<R>(fn: (mat: Matrix) => R): R {
    const mat = MathPools.matrix.acquire();
    try {
      return fn(mat);
    } finally {
      MathPools.matrix.release(mat);
    }
  },

  /**
   * Helper: Execute function with pooled Vector3, auto-release
   */
  withVector3<R>(fn: (vec: Vector3) => R): R {
    const vec = MathPools.vector3.acquire();
    try {
      return fn(vec);
    } finally {
      MathPools.vector3.release(vec);
    }
  },

  /**
   * Helper: Execute function with pooled Quaternion, auto-release
   */
  withQuaternion<R>(fn: (quat: Quaternion) => R): R {
    const quat = MathPools.quaternion.acquire();
    try {
      return fn(quat);
    } finally {
      MathPools.quaternion.release(quat);
    }
  },

  /**
   * Get pool statistics
   */
  getStats(): { matrix: number; vector3: number; quaternion: number } {
    return {
      matrix: MathPools.matrix.size,
      vector3: MathPools.vector3.size,
      quaternion: MathPools.quaternion.size,
    };
  },

  /**
   * Clear all pools (call on scene dispose)
   */
  clearAll(): void {
    MathPools.matrix.clear();
    MathPools.vector3.clear();
    MathPools.quaternion.clear();
  },
};

/**
 * Float32Array pool for reusing typed arrays
 * Key is the size of the array
 */
class Float32ArrayPool {
  private pools: Map<number, Float32Array[]> = new Map();

  acquire(size: number): Float32Array {
    const pool = this.pools.get(size);
    if (pool && pool.length > 0) {
      return pool.pop()!;
    }
    return new Float32Array(size);
  }

  release(arr: Float32Array): void {
    const size = arr.length;
    let pool = this.pools.get(size);
    if (!pool) {
      pool = [];
      this.pools.set(size, pool);
    }
    // Limit pool size per size category to avoid memory bloat
    if (pool.length < 16) {
      pool.push(arr);
    }
  }

  clear(): void {
    this.pools.clear();
  }

  getStats(): Map<number, number> {
    const stats = new Map<number, number>();
    for (const [size, pool] of this.pools) {
      stats.set(size, pool.length);
    }
    return stats;
  }
}

export const ArrayPools = {
  float32: new Float32ArrayPool(),

  clearAll(): void {
    ArrayPools.float32.clear();
  },
};
