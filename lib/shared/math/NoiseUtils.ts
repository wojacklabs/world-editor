/**
 * Shared noise utilities for procedural generation
 * Used by both editor and loader systems
 */

// Noise seed constants (standard Perlin noise magic numbers)
export const NOISE_SEED_X = 127.1;
export const NOISE_SEED_Y = 311.7;
export const NOISE_SEED_Z = 74.7;
export const NOISE_HASH_SCALE = 43758.5453;

/**
 * 3D hash function for noise generation
 */
export function hash3D(x: number, y: number, z: number): number {
  const n = Math.sin(x * NOISE_SEED_X + y * NOISE_SEED_Y + z * NOISE_SEED_Z) * NOISE_HASH_SCALE;
  return n - Math.floor(n);
}

/**
 * 2D hash function for noise generation
 */
export function hash2D(x: number, y: number): number {
  const n = Math.sin(x * NOISE_SEED_X + y * NOISE_SEED_Y) * NOISE_HASH_SCALE;
  return n - Math.floor(n);
}

/**
 * Seeded random function (0-1 range)
 */
export function seeded01(seed: number): number {
  const n = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * 3D Perlin-style noise
 */
export function noise3D(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;

  // Smoothstep interpolation
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  // Sample 8 corners of the cube
  const n000 = hash3D(ix, iy, iz);
  const n100 = hash3D(ix + 1, iy, iz);
  const n010 = hash3D(ix, iy + 1, iz);
  const n110 = hash3D(ix + 1, iy + 1, iz);
  const n001 = hash3D(ix, iy, iz + 1);
  const n101 = hash3D(ix + 1, iy, iz + 1);
  const n011 = hash3D(ix, iy + 1, iz + 1);
  const n111 = hash3D(ix + 1, iy + 1, iz + 1);

  // Trilinear interpolation
  const n00 = n000 * (1 - ux) + n100 * ux;
  const n01 = n001 * (1 - ux) + n101 * ux;
  const n10 = n010 * (1 - ux) + n110 * ux;
  const n11 = n011 * (1 - ux) + n111 * ux;

  const n0 = n00 * (1 - uy) + n10 * uy;
  const n1 = n01 * (1 - uy) + n11 * uy;

  return (n0 * (1 - uz) + n1 * uz) * 2 - 1;
}

/**
 * 2D Perlin-style noise
 */
export function noise2D(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;

  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);

  const n00 = hash2D(ix, iy);
  const n10 = hash2D(ix + 1, iy);
  const n01 = hash2D(ix, iy + 1);
  const n11 = hash2D(ix + 1, iy + 1);

  const nx0 = n00 * (1 - ux) + n10 * ux;
  const nx1 = n01 * (1 - ux) + n11 * ux;

  return nx0 * (1 - uy) + nx1 * uy;
}

/**
 * Fractal Brownian Motion (3D)
 */
export function fbm3D(x: number, y: number, z: number, octaves: number = 4): number {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;

  for (let i = 0; i < octaves; i++) {
    value += amplitude * noise3D(x * frequency, y * frequency, z * frequency);
    frequency *= 2;
    amplitude *= 0.5;
  }

  return value;
}

/**
 * Fractal Brownian Motion (2D)
 */
export function fbm2D(x: number, y: number, octaves: number = 3): number {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;

  for (let i = 0; i < octaves; i++) {
    value += amplitude * noise2D(x * frequency, y * frequency);
    frequency *= 2;
    amplitude *= 0.5;
  }

  return value;
}

/**
 * GLSL noise functions for shaders
 * Include this in vertex/fragment shaders that need noise
 */
export const GLSL_NOISE_FUNCTIONS = `
// Noise seed constants
#define NOISE_SEED_X 127.1
#define NOISE_SEED_Y 311.7
#define NOISE_SEED_Z 74.7
#define NOISE_HASH_SCALE 43758.5453

float hash2D(vec2 p) {
    return fract(sin(dot(p, vec2(NOISE_SEED_X, NOISE_SEED_Y))) * NOISE_HASH_SCALE);
}

float hash3D(vec3 p) {
    return fract(sin(dot(p, vec3(NOISE_SEED_X, NOISE_SEED_Y, NOISE_SEED_Z))) * NOISE_HASH_SCALE);
}

float noise2D(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float a = hash2D(i);
    float b = hash2D(i + vec2(1.0, 0.0));
    float c = hash2D(i + vec2(0.0, 1.0));
    float d = hash2D(i + vec2(1.0, 1.0));

    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float noise3D(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float n000 = hash3D(i);
    float n100 = hash3D(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash3D(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash3D(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash3D(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash3D(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash3D(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash3D(i + vec3(1.0, 1.0, 1.0));

    vec4 n_z0 = vec4(n000, n100, n010, n110);
    vec4 n_z1 = vec4(n001, n101, n011, n111);
    vec4 n_zz = mix(n_z0, n_z1, f.z);
    vec2 n_y = mix(n_zz.xy, n_zz.zw, f.y);
    return mix(n_y.x, n_y.y, f.x);
}

float fbm2D(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 3; i++) {
        value += amplitude * noise2D(p);
        p = p * 2.02 + vec2(13.1, 7.7);
        amplitude *= 0.5;
    }
    return value;
}

float fbm3D(vec3 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 3; i++) {
        value += amplitude * noise3D(p);
        p *= 2.0;
        amplitude *= 0.5;
    }
    return value;
}
`;
