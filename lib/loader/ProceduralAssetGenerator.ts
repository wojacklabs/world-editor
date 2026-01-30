/**
 * ProceduralAssetGenerator - Generates procedural meshes matching the editor
 *
 * This is a port of the editor's ProceduralAsset.ts mesh generation logic
 * for use in the game loader. It creates identical meshes using the same
 * noise functions, vertex colors, and shape deformations.
 */

import {
  Scene,
  Mesh,
  MeshBuilder,
  ShaderMaterial,
  Effect,
  Vector3,
  Vector2,
  Color3,
  VertexData,
  VertexBuffer,
  Quaternion,
  Texture,
} from "@babylonjs/core";

// ============================================
// Register Shaders
// ============================================

// Wind-enabled vertex shader for foliage (grass, bush, tree leaves)
Effect.ShadersStore["loaderFoliageWindVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
attribute vec4 color;

uniform mat4 worldViewProjection;
uniform mat4 world;
uniform vec3 cameraPosition;
uniform float uTime;
uniform vec2 uWindDirection;
uniform float uWindStrength;
uniform float uMinWindHeight;
uniform float uMaxWindHeight;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;
varying vec4 vColor;

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise2D(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
    vec4 worldPos = world * vec4(position, 1.0);
    vec3 localPos = position;

    float heightAboveMin = max(0.0, localPos.y - uMinWindHeight);
    float heightRange = max(0.01, uMaxWindHeight - uMinWindHeight);
    float heightFactor = clamp(heightAboveMin / heightRange, 0.0, 1.0);
    heightFactor = heightFactor * heightFactor;

    vec2 worldPosXZ = worldPos.xz;
    float windPhase = dot(worldPosXZ, uWindDirection) * 0.5 + uTime * 2.0;
    float primaryWave = sin(windPhase) * 0.5 + 0.5;
    float secondaryPhase = dot(worldPosXZ, uWindDirection) * 2.0 + uTime * 5.0;
    float secondaryWave = sin(secondaryPhase) * 0.3 + 0.5;
    float noiseVal = noise2D(worldPosXZ * 0.3 + uTime * 0.2);
    float windAmount = (primaryWave * 0.7 + secondaryWave * 0.3 + noiseVal * 0.2) * heightFactor * uWindStrength;

    localPos.x += uWindDirection.x * windAmount * 0.15;
    localPos.z += uWindDirection.y * windAmount * 0.15;
    localPos.y -= windAmount * 0.03;

    vec4 finalWorldPos = world * vec4(localPos, 1.0);
    gl_Position = worldViewProjection * vec4(localPos, 1.0);

    vNormal = normalize(mat3(world) * normal);
    vPosition = finalWorldPos.xyz;
    vLocalPosition = localPos;
    vUV = uv;
    vCameraDistance = length(cameraPosition - finalWorldPos.xyz);
    vViewDirection = normalize(cameraPosition - finalWorldPos.xyz);
    vColor = color;
}
`;

Effect.ShadersStore["loaderFoliageWindFragmentShader"] = `
precision highp float;

uniform vec3 baseColor;
uniform vec3 detailColor;
uniform vec3 sunDirection;
uniform float ambientIntensity;
uniform vec3 fogColor;
uniform float fogDensity;
uniform sampler2D dirtTexture;
uniform float dirtTextureScale;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;
varying vec4 vColor;

float hash3D(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
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

float fbm(vec3 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 3; i++) {
        value += amplitude * noise3D(p);
        p *= 2.0;
        amplitude *= 0.5;
    }
    return value;
}

void main() {
    vec3 normal = normalize(vNormal);
    vec3 meshColor = vColor.a > 0.5 ? vColor.rgb : baseColor;
    float colorNoise = fbm(vPosition * 2.0);
    vec3 color = mix(meshColor, meshColor * 0.8, colorNoise * 0.3);

    // Triplanar bark texture sampling (for tree trunks/branches)
    vec3 barkBlend = abs(normal);
    barkBlend = barkBlend / (barkBlend.x + barkBlend.y + barkBlend.z);
    vec3 dirtTexX = texture2D(dirtTexture, vPosition.yz * dirtTextureScale).rgb;
    vec3 dirtTexY = texture2D(dirtTexture, vPosition.xz * dirtTextureScale).rgb;
    vec3 dirtTexZ = texture2D(dirtTexture, vPosition.xy * dirtTextureScale).rgb;
    vec3 dirtSample = dirtTexX * barkBlend.x + dirtTexY * barkBlend.y + dirtTexZ * barkBlend.z;

    // Apply bark texture where R > G (bark vertices)
    float isBark = step(vColor.g, vColor.r);
    color = mix(color, mix(color, dirtSample, 0.4), isBark);

    float tipFactor = smoothstep(0.0, 0.6, vLocalPosition.y);
    float isLeaf = vColor.g > vColor.r ? 1.0 : 0.3;
    color = mix(color * 0.85, color * 1.1, tipFactor * isLeaf);

    float NdotL = dot(normal, sunDirection);
    float halfLambert = NdotL * 0.5 + 0.5;
    halfLambert = halfLambert * halfLambert;

    float rimFactor = 1.0 - max(dot(normal, vViewDirection), 0.0);
    rimFactor = pow(rimFactor, 3.0) * 0.08;

    float sss = max(0.0, dot(-vViewDirection, sunDirection)) * tipFactor * 0.15;

    float diffuse = halfLambert * 0.6 + 0.4;
    vec3 ambient = vec3(ambientIntensity);
    vec3 rim = vec3(rimFactor) * vec3(0.8, 0.9, 1.0);

    color = color * (ambient + diffuse) + rim + vec3(0.1, 0.15, 0.05) * sss;

    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vCameraDistance * vCameraDistance);
    color = mix(color, fogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(color, 1.0);
}
`;

// Procedural asset shader (for rocks)
Effect.ShadersStore["loaderProceduralAssetVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
attribute vec4 color;

uniform mat4 worldViewProjection;
uniform mat4 world;
uniform vec3 cameraPosition;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;
varying vec4 vColor;

void main() {
    vec4 worldPos = world * vec4(position, 1.0);
    gl_Position = worldViewProjection * vec4(position, 1.0);

    vNormal = normalize(mat3(world) * normal);
    vPosition = worldPos.xyz;
    vLocalPosition = position;
    vUV = uv;
    vCameraDistance = length(cameraPosition - worldPos.xyz);
    vViewDirection = normalize(cameraPosition - worldPos.xyz);
    vColor = color;
}
`;

Effect.ShadersStore["loaderProceduralAssetFragmentShader"] = `
precision highp float;

uniform vec3 baseColor;
uniform vec3 detailColor;
uniform vec3 sunDirection;
uniform float ambientIntensity;
uniform vec3 fogColor;
uniform float fogDensity;
uniform sampler2D rockTexture;
uniform float textureScale;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;
varying vec4 vColor;

float hash3D(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
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

float fbm(vec3 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 3; i++) {
        value += amplitude * noise3D(p);
        p *= 2.0;
        amplitude *= 0.5;
    }
    return value;
}

void main() {
    // Screen-space derivatives for smooth normals
    vec3 dPdx = dFdx(vPosition);
    vec3 dPdy = dFdy(vPosition);
    vec3 geometricNormal = normalize(cross(dPdx, dPdy));
    vec3 smoothNormal = normalize(vNormal);

    // Edge detection (normal variation)
    vec3 dNdx = dFdx(smoothNormal);
    vec3 dNdy = dFdy(smoothNormal);
    float edgeStrength = length(dNdx) + length(dNdy);
    float edgeFactor = smoothstep(0.1, 0.5, edgeStrength);

    // Edge blending
    float blendRatio = mix(0.9, 0.5, edgeFactor);
    vec3 normal = normalize(mix(geometricNormal, smoothNormal, blendRatio));

    // Per-pixel normal perturbation
    float noiseScale2 = 8.0;
    float noiseStrength = 0.12;
    vec3 noisePos = vLocalPosition * noiseScale2;

    float nx = fbm(noisePos + vec3(0.1, 0.0, 0.0)) - fbm(noisePos - vec3(0.1, 0.0, 0.0));
    float ny = fbm(noisePos + vec3(0.0, 0.1, 0.0)) - fbm(noisePos - vec3(0.0, 0.1, 0.0));
    float nz = fbm(noisePos + vec3(0.0, 0.0, 0.1)) - fbm(noisePos - vec3(0.0, 0.0, 0.1));
    vec3 noisePerturbation = normalize(vec3(nx, ny, nz)) * noiseStrength;
    noisePerturbation *= (1.0 - edgeFactor * 0.5);
    normal = normalize(normal + noisePerturbation);

    // Triplanar texture sampling (world-space projection)
    vec3 blending = abs(normal);
    blending = blending / (blending.x + blending.y + blending.z);

    vec3 texX = texture2D(rockTexture, vPosition.yz * textureScale).rgb;
    vec3 texY = texture2D(rockTexture, vPosition.xz * textureScale).rgb;
    vec3 texZ = texture2D(rockTexture, vPosition.xy * textureScale).rgb;
    vec3 texColor = texX * blending.x + texY * blending.y + texZ * blending.z;

    // Procedural color variation
    float colorNoise = fbm(vPosition * 2.0);
    vec3 procColor = mix(baseColor, detailColor, colorNoise * 0.5);

    // Blend: 70% texture, 30% procedural
    vec3 color = mix(procColor, texColor, 0.7);

    // Diffuse lighting
    float NdotL = max(dot(normal, sunDirection), 0.0);
    float diffuse = NdotL * 0.6 + 0.4;

    // Edge softening
    diffuse = mix(diffuse, diffuse * 0.7 + 0.3, edgeFactor * 0.4);

    // Rim lighting
    float rimFactor = 1.0 - max(dot(normal, vViewDirection), 0.0);
    rimFactor = pow(rimFactor, 3.0) * 0.1;

    // Ambient occlusion
    float ao = 0.5 + 0.5 * smoothNormal.y;

    // Final lighting
    vec3 ambient = vec3(ambientIntensity) * ao;
    vec3 rim = vec3(rimFactor) * vec3(0.8, 0.85, 1.0);

    color = color * (ambient + diffuse) + rim;

    // Fog
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vCameraDistance * vCameraDistance);
    color = mix(color, fogColor, clamp(fogFactor, 0.0, 1.0));

    // Tone mapping
    color = color / (color + vec3(1.0)) * 1.1;
    color = pow(color, vec3(0.95));

    gl_FragColor = vec4(color, 1.0);
}
`;

// ============================================
// Noise Functions (CPU-side)
// ============================================

function hash3D(x: number, y: number, z: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

function noise3D(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;

  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const n000 = hash3D(ix, iy, iz);
  const n100 = hash3D(ix + 1, iy, iz);
  const n010 = hash3D(ix, iy + 1, iz);
  const n110 = hash3D(ix + 1, iy + 1, iz);
  const n001 = hash3D(ix, iy, iz + 1);
  const n101 = hash3D(ix + 1, iy, iz + 1);
  const n011 = hash3D(ix, iy + 1, iz + 1);
  const n111 = hash3D(ix + 1, iy + 1, iz + 1);

  const n00 = n000 * (1 - ux) + n100 * ux;
  const n01 = n001 * (1 - ux) + n101 * ux;
  const n10 = n010 * (1 - ux) + n110 * ux;
  const n11 = n011 * (1 - ux) + n111 * ux;

  const n0 = n00 * (1 - uy) + n10 * uy;
  const n1 = n01 * (1 - uy) + n11 * uy;

  return (n0 * (1 - uz) + n1 * uz) * 2 - 1;
}

function fbm3D(x: number, y: number, z: number, octaves: number = 4): number {
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

function calcSubdivision(size: number, base: number = 4, override?: number): number {
  if (override !== undefined) {
    return Math.max(1, Math.min(6, override));
  }
  const subdiv = Math.floor(base + Math.log2(Math.max(size, 0.25)));
  return Math.max(3, Math.min(6, subdiv));
}

// ============================================
// Vertex Color Helpers
// ============================================

function setMeshVertexColor(mesh: Mesh, r: number, g: number, b: number): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return;

  const vertexCount = positions.length / 3;
  const colors = new Float32Array(vertexCount * 4);

  for (let i = 0; i < vertexCount; i++) {
    colors[i * 4] = r;
    colors[i * 4 + 1] = g;
    colors[i * 4 + 2] = b;
    colors[i * 4 + 3] = 1.0;
  }

  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}

function setRockVertexColors(mesh: Mesh, seed: number): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return;

  const vertexCount = positions.length / 3;
  const colors = new Float32Array(vertexCount * 4);

  const baseRock = { r: 0.45, g: 0.42, b: 0.38 };
  const darkRock = { r: 0.25, g: 0.23, b: 0.20 };
  const lightRock = { r: 0.60, g: 0.58, b: 0.52 };
  const mossColor = { r: 0.35, g: 0.45, b: 0.30 };
  const lichColor = { r: 0.55, g: 0.58, b: 0.45 };

  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const y = positions[i + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const heightRange = maxY - minY || 1;

  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];

    const heightT = (y - minY) / heightRange;
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    const ny = y / len;

    const noise1 = noise3D(x * 8 + seed, y * 8, z * 8) * 0.5 + 0.5;
    const noise2 = noise3D(x * 15 + seed * 2, y * 15, z * 15) * 0.5 + 0.5;
    const noise3Val = fbm3D(x * 3 + seed * 0.5, y * 3, z * 3, 2) * 0.5 + 0.5;

    const mossStrength = Math.max(0, ny * 0.5 + 0.3) * noise3Val * (heightT > 0.4 ? 1 : heightT / 0.4);
    const lichStrength = Math.max(0, ny * 0.3 + 0.2) * noise1 * 0.5;

    let r = baseRock.r;
    let g = baseRock.g;
    let b = baseRock.b;

    const darkFactor = Math.pow(1 - heightT, 1.5) * 0.4;
    r = r * (1 - darkFactor) + darkRock.r * darkFactor;
    g = g * (1 - darkFactor) + darkRock.g * darkFactor;
    b = b * (1 - darkFactor) + darkRock.b * darkFactor;

    const lightFactor = Math.pow(heightT, 2) * 0.3 * noise2;
    r = r * (1 - lightFactor) + lightRock.r * lightFactor;
    g = g * (1 - lightFactor) + lightRock.g * lightFactor;
    b = b * (1 - lightFactor) + lightRock.b * lightFactor;

    r = r * (1 - mossStrength) + mossColor.r * mossStrength;
    g = g * (1 - mossStrength) + mossColor.g * mossStrength;
    b = b * (1 - mossStrength) + mossColor.b * mossStrength;

    r = r * (1 - lichStrength) + lichColor.r * lichStrength;
    g = g * (1 - lichStrength) + lichColor.g * lichStrength;
    b = b * (1 - lichStrength) + lichColor.b * lichStrength;

    const microNoise = (noise2 - 0.5) * 0.08;
    r = Math.max(0, Math.min(1, r + microNoise));
    g = Math.max(0, Math.min(1, g + microNoise * 0.8));
    b = Math.max(0, Math.min(1, b + microNoise * 0.6));

    colors[i * 4] = r;
    colors[i * 4 + 1] = g;
    colors[i * 4 + 2] = b;
    colors[i * 4 + 3] = 1.0;
  }

  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}

function setBarkVertexColors(mesh: Mesh, seed: number, isBranch: boolean = false): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return;

  const vertexCount = positions.length / 3;
  const colors = new Float32Array(vertexCount * 4);

  const darkBark = { r: 0.38, g: 0.30, b: 0.20 };
  const midBark = { r: 0.52, g: 0.42, b: 0.28 };
  const lightBark = { r: 0.62, g: 0.52, b: 0.36 };
  const mossBark = { r: 0.35, g: 0.40, b: 0.25 };

  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const y = positions[i + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const heightRange = maxY - minY || 1;

  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];

    const heightT = (y - minY) / heightRange;

    const barkNoise = noise3D(x * 20 + seed, y * 5, z * 20 + seed * 0.5) * 0.5 + 0.5;
    const stripNoise = Math.sin(y * 30 + noise3D(x * 10, y * 2, z * 10) * 3) * 0.5 + 0.5;
    const mossNoise = fbm3D(x * 6 + seed, y * 6, z * 6, 2) * 0.5 + 0.5;

    let r, g, b;
    if (heightT < 0.3) {
      const t = heightT / 0.3;
      r = darkBark.r * (1 - t) + midBark.r * t;
      g = darkBark.g * (1 - t) + midBark.g * t;
      b = darkBark.b * (1 - t) + midBark.b * t;
    } else {
      const t = (heightT - 0.3) / 0.7;
      r = midBark.r * (1 - t) + lightBark.r * t;
      g = midBark.g * (1 - t) + lightBark.g * t;
      b = midBark.b * (1 - t) + lightBark.b * t;
    }

    const grooveFactor = (1 - barkNoise) * stripNoise * 0.25;
    r *= (1 - grooveFactor);
    g *= (1 - grooveFactor);
    b *= (1 - grooveFactor);

    const mossStrength = (isBranch ? 0.1 : 0.3) * (1 - heightT) * mossNoise;
    r = r * (1 - mossStrength) + mossBark.r * mossStrength;
    g = g * (1 - mossStrength) + mossBark.g * mossStrength;
    b = b * (1 - mossStrength) + mossBark.b * mossStrength;

    colors[i * 4] = Math.max(0, Math.min(1, r));
    colors[i * 4 + 1] = Math.max(0, Math.min(1, g));
    colors[i * 4 + 2] = Math.max(0, Math.min(1, b));
    colors[i * 4 + 3] = 1.0;
  }

  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}

function setBushVertexColors(mesh: Mesh, seed: number): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return;

  const vertexCount = positions.length / 3;
  const colors = new Float32Array(vertexCount * 4);

  const sunBush = { r: 0.38, g: 0.55, b: 0.22 };
  const shadeBush = { r: 0.15, g: 0.32, b: 0.10 };
  const midBush = { r: 0.28, g: 0.45, b: 0.16 };
  const yellowTint = { r: 0.42, g: 0.52, b: 0.18 };

  let minY = Infinity, maxY = -Infinity;
  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const heightRange = maxY - minY || 1;
  const xRange = maxX - minX || 1;
  const zRange = maxZ - minZ || 1;

  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];

    const heightT = (y - minY) / heightRange;
    const xT = (x - minX) / xRange;
    const zT = (z - minZ) / zRange;

    const centerDistX = Math.abs(xT - 0.5) * 2;
    const centerDistZ = Math.abs(zT - 0.5) * 2;
    const edgeFactor = Math.max(centerDistX, centerDistZ);

    const bushNoise = noise3D(x * 15 + seed, y * 15, z * 15 + seed * 0.7) * 0.5 + 0.5;
    const varNoise = fbm3D(x * 6 + seed * 2, y * 6, z * 6, 2) * 0.5 + 0.5;

    const sunExposure = (heightT * 0.6 + edgeFactor * 0.3 + varNoise * 0.2);

    let r, g, b;
    if (sunExposure > 0.6) {
      const t = (sunExposure - 0.6) / 0.4;
      r = midBush.r * (1 - t) + sunBush.r * t;
      g = midBush.g * (1 - t) + sunBush.g * t;
      b = midBush.b * (1 - t) + sunBush.b * t;
    } else if (sunExposure > 0.3) {
      const t = (sunExposure - 0.3) / 0.3;
      r = shadeBush.r * (1 - t) + midBush.r * t;
      g = shadeBush.g * (1 - t) + midBush.g * t;
      b = shadeBush.b * (1 - t) + midBush.b * t;
    } else {
      r = shadeBush.r;
      g = shadeBush.g;
      b = shadeBush.b;
    }

    const yellowFactor = bushNoise * bushNoise * 0.2;
    r = r * (1 - yellowFactor) + yellowTint.r * yellowFactor;
    g = g * (1 - yellowFactor) + yellowTint.g * yellowFactor;
    b = b * (1 - yellowFactor) + yellowTint.b * yellowFactor;

    const microVar = (bushNoise - 0.5) * 0.06;
    r = Math.max(0, Math.min(1, r + microVar * 0.5));
    g = Math.max(0, Math.min(1, g + microVar));
    b = Math.max(0, Math.min(1, b + microVar * 0.3));

    colors[i * 4] = r;
    colors[i * 4 + 1] = g;
    colors[i * 4 + 2] = b;
    colors[i * 4 + 3] = 1.0;
  }

  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}

function setLeafVertexColors(mesh: Mesh, seed: number, isTop: boolean = false): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return;

  const vertexCount = positions.length / 3;
  const colors = new Float32Array(vertexCount * 4);

  const sunLeaf = { r: 0.40, g: 0.52, b: 0.24 };
  const shadeLeaf = { r: 0.18, g: 0.30, b: 0.12 };
  const yellowLeaf = { r: 0.45, g: 0.50, b: 0.20 };
  const freshLeaf = { r: 0.32, g: 0.45, b: 0.20 };

  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const y = positions[i + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const heightRange = maxY - minY || 1;

  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];

    const heightT = (y - minY) / heightRange;

    const leafNoise = noise3D(x * 12 + seed, y * 12, z * 12 + seed * 0.7) * 0.5 + 0.5;
    const varNoise = fbm3D(x * 5 + seed * 2, y * 5, z * 5, 2) * 0.5 + 0.5;

    let r, g, b;
    const sunFactor = heightT * 0.7 + varNoise * 0.3;

    if (sunFactor > 0.6) {
      const t = (sunFactor - 0.6) / 0.4;
      r = freshLeaf.r * (1 - t) + sunLeaf.r * t;
      g = freshLeaf.g * (1 - t) + sunLeaf.g * t;
      b = freshLeaf.b * (1 - t) + sunLeaf.b * t;
    } else if (sunFactor > 0.3) {
      const t = (sunFactor - 0.3) / 0.3;
      r = shadeLeaf.r * (1 - t) + freshLeaf.r * t;
      g = shadeLeaf.g * (1 - t) + freshLeaf.g * t;
      b = shadeLeaf.b * (1 - t) + freshLeaf.b * t;
    } else {
      r = shadeLeaf.r;
      g = shadeLeaf.g;
      b = shadeLeaf.b;
    }

    if (isTop) {
      const yellowFactor = leafNoise * 0.25;
      r = r * (1 - yellowFactor) + yellowLeaf.r * yellowFactor;
      g = g * (1 - yellowFactor) + yellowLeaf.g * yellowFactor;
      b = b * (1 - yellowFactor) + yellowLeaf.b * yellowFactor;
    }

    const microVar = (leafNoise - 0.5) * 0.08;
    r = Math.max(0, Math.min(1, r + microVar * 0.5));
    g = Math.max(0, Math.min(1, g + microVar));
    b = Math.max(0, Math.min(1, b + microVar * 0.3));

    colors[i * 4] = r;
    colors[i * 4 + 1] = g;
    colors[i * 4 + 2] = b;
    colors[i * 4 + 3] = 1.0;
  }

  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}

// ============================================
// Generator Params Interface
// ============================================

export interface GeneratorParams {
  type: string;
  seed: number;
  size: number;
  sizeVariation: number;
  noiseScale: number;
  noiseAmplitude: number;
  colorBase: { r: number; g: number; b: number };
  colorDetail: { r: number; g: number; b: number };
}

// ============================================
// ProceduralAssetGenerator Class
// ============================================

export class ProceduralAssetGenerator {
  private scene: Scene;
  private time: number = 0;
  private windDirection: Vector2 = new Vector2(Math.cos(Math.PI * 0.25), Math.sin(Math.PI * 0.25));
  private windStrength: number = 0.5;
  private fogColor: Color3 = new Color3(0.6, 0.75, 0.9);  // Matching editor
  private fogDensity: number = 0.008;  // Matching editor

  constructor(scene: Scene) {
    this.scene = scene;
    // Use scene fog settings if available
    if (scene.fogColor) {
      this.fogColor = new Color3(scene.fogColor.r, scene.fogColor.g, scene.fogColor.b);
    }
    if (scene.fogDensity) {
      this.fogDensity = scene.fogDensity;
    }
  }

  /**
   * Update wind animation time
   */
  updateTime(deltaTime: number): void {
    this.time += deltaTime;
  }

  /**
   * Set wind parameters
   */
  setWind(direction: Vector2, strength: number): void {
    this.windDirection = direction.normalize();
    this.windStrength = strength;
  }

  /**
   * Set fog parameters
   */
  setFog(color: Color3, density: number): void {
    this.fogColor = color;
    this.fogDensity = density;
  }

  /**
   * Generate a procedural mesh based on params
   */
  generate(params: GeneratorParams): Mesh | null {
    switch (params.type) {
      case "rock":
        return this.generateRock(params);
      case "tree":
        return this.generateTree(params);
      case "bush":
        return this.generateBush(params);
      case "grass_clump":
        return this.generateGrassClump(params);
      default:
        console.warn(`[ProceduralAssetGenerator] Unknown type: ${params.type}`);
        return null;
    }
  }

  /**
   * Create material for the mesh
   */
  createMaterial(params: GeneratorParams): ShaderMaterial {
    const needsWind = params.type === "grass_clump" || params.type === "bush" || params.type === "tree";

    if (needsWind) {
      const material = new ShaderMaterial(
        `loaderFoliageMat_${params.seed}`,
        this.scene,
        {
          vertex: "loaderFoliageWind",
          fragment: "loaderFoliageWind",
        },
        {
          attributes: ["position", "normal", "uv", "color"],
          uniforms: [
            "worldViewProjection", "world", "cameraPosition",
            "uTime", "uWindDirection", "uWindStrength",
            "uMinWindHeight", "uMaxWindHeight",
            "baseColor", "detailColor", "sunDirection",
            "ambientIntensity", "fogColor", "fogDensity",
            "dirtTextureScale",
          ],
          samplers: ["dirtTexture"],
        }
      );

      material.setVector2("uWindDirection", this.windDirection);

      let windStr = 0.5, minHeight = 0.0, maxHeight = 0.8;
      if (params.type === "grass_clump") {
        windStr = 0.8;
        minHeight = 0.0;
        maxHeight = 0.5;
      } else if (params.type === "bush") {
        windStr = 0.4;
        minHeight = 0.05;
        maxHeight = 0.4;
      } else if (params.type === "tree") {
        windStr = 0.3;
        minHeight = 0.4;
        maxHeight = 2.0;
      }

      material.setFloat("uWindStrength", windStr * this.windStrength);
      material.setFloat("uMinWindHeight", minHeight);
      material.setFloat("uMaxWindHeight", maxHeight);
      material.setFloat("uTime", this.time);

      material.setColor3("baseColor", new Color3(params.colorBase.r, params.colorBase.g, params.colorBase.b));
      material.setColor3("detailColor", new Color3(params.colorDetail.r, params.colorDetail.g, params.colorDetail.b));
      material.setVector3("sunDirection", new Vector3(0.5, 0.8, 0.3).normalize());
      material.setFloat("ambientIntensity", 0.4);
      material.setColor3("fogColor", this.fogColor);
      material.setFloat("fogDensity", this.fogDensity);
      material.setFloat("dirtTextureScale", 0.5);

      // Load dirt texture for bark triplanar mapping
      const dirtTex = new Texture("/textures/dirt_diffuse.jpg", this.scene);
      dirtTex.wrapU = Texture.WRAP_ADDRESSMODE;
      dirtTex.wrapV = Texture.WRAP_ADDRESSMODE;
      material.setTexture("dirtTexture", dirtTex);

      // Register update for wind animation
      this.scene.registerBeforeRender(() => {
        material.setFloat("uTime", this.time);
      });

      return material;
    } else {
      // Rock shader with triplanar texture
      const material = new ShaderMaterial(
        `loaderRockMat_${params.seed}`,
        this.scene,
        {
          vertex: "loaderProceduralAsset",
          fragment: "loaderProceduralAsset",
        },
        {
          attributes: ["position", "normal", "uv", "color"],
          uniforms: [
            "worldViewProjection", "world", "cameraPosition",
            "baseColor", "detailColor", "sunDirection",
            "ambientIntensity", "fogColor", "fogDensity",
            "textureScale",
          ],
          samplers: ["rockTexture"],
        }
      );

      material.setColor3("baseColor", new Color3(params.colorBase.r, params.colorBase.g, params.colorBase.b));
      material.setColor3("detailColor", new Color3(params.colorDetail.r, params.colorDetail.g, params.colorDetail.b));
      material.setVector3("sunDirection", new Vector3(0.5, 0.8, 0.3).normalize());
      material.setFloat("ambientIntensity", 0.4);
      material.setColor3("fogColor", this.fogColor);
      material.setFloat("fogDensity", this.fogDensity);
      material.setFloat("textureScale", 0.5);

      // Load rock diffuse texture for triplanar mapping
      const rockTex = new Texture("/textures/rock_diff.jpg", this.scene);
      rockTex.wrapU = Texture.WRAP_ADDRESSMODE;
      rockTex.wrapV = Texture.WRAP_ADDRESSMODE;
      material.setTexture("rockTexture", rockTex);

      return material;
    }
  }

  // ============================================
  // Rock Generation
  // ============================================

  private generateRock(params: GeneratorParams): Mesh {
    const seed = params.seed;
    const subdivisions = calcSubdivision(params.size, 4);

    const rock = MeshBuilder.CreateIcoSphere(
      "rock_" + seed,
      { radius: 0.5, subdivisions, flat: false, updatable: true },
      this.scene
    );

    // Shape parameters from seed
    const scaleX = 0.5 + Math.abs(noise3D(seed * 1.0, 0, 0)) * 1.2;
    const scaleY = 0.4 + Math.abs(noise3D(0, seed * 1.1, 0)) * 1.6;
    const scaleZ = 0.5 + Math.abs(noise3D(0, 0, seed * 1.2)) * 1.2;

    const taperY = noise3D(seed * 2.0, seed * 0.5, 0) * 0.7;
    const taperX = noise3D(seed * 2.1, 0, seed * 0.5) * 0.4;
    const taperZ = noise3D(0, seed * 2.2, seed * 0.6) * 0.4;

    const asymOffsetX = noise3D(seed * 3.0, seed * 0.3, 0) * 0.35;
    const asymOffsetY = noise3D(seed * 0.3, seed * 3.1, 0) * 0.25;
    const asymOffsetZ = noise3D(0, seed * 0.3, seed * 3.2) * 0.35;

    const twistAmount = noise3D(seed * 4.0, seed * 0.7, seed * 0.3) * 0.6;

    const bendX = noise3D(seed * 5.0, 0, 0) * 0.4;
    const bendZ = noise3D(0, 0, seed * 5.1) * 0.4;

    const peakDirX = noise3D(seed * 6.0, seed * 0.2, 0);
    const peakDirY = noise3D(seed * 0.2, seed * 6.1, 0);
    const peakDirZ = noise3D(0, seed * 0.2, seed * 6.2);
    const peakLen = Math.sqrt(peakDirX * peakDirX + peakDirY * peakDirY + peakDirZ * peakDirZ);
    const peakStrength = 0.1 + Math.abs(noise3D(seed * 6.5, seed * 6.6, seed * 6.7)) * 0.4;

    const positions = rock.getVerticesData(VertexBuffer.PositionKind);
    if (positions) {
      const newPositions = new Float32Array(positions.length);

      for (let i = 0; i < positions.length; i += 3) {
        let x = positions[i];
        let y = positions[i + 1];
        let z = positions[i + 2];

        const len = Math.sqrt(x * x + y * y + z * z);
        const nx = x / len;
        const ny = y / len;
        const nz = z / len;

        // Apply scale
        x *= scaleX;
        y *= scaleY;
        z *= scaleZ;

        // Apply taper
        const taperFactorY = 1.0 - taperY * ny;
        const taperFactorX = 1.0 - taperX * nx;
        const taperFactorZ = 1.0 - taperZ * nz;
        x *= taperFactorY * taperFactorX;
        z *= taperFactorY * taperFactorZ;

        // Apply twist
        const twistAngle = twistAmount * ny;
        const cosT = Math.cos(twistAngle);
        const sinT = Math.sin(twistAngle);
        const rx = x * cosT - z * sinT;
        const rz = x * sinT + z * cosT;
        x = rx;
        z = rz;

        // Apply bend
        x += bendX * y * y;
        z += bendZ * y * y;

        // Apply asymmetry
        x += asymOffsetX * (1.0 - Math.abs(ny));
        y += asymOffsetY;
        z += asymOffsetZ * (1.0 - Math.abs(ny));

        // Apply peak
        if (peakLen > 0.1) {
          const pdx = peakDirX / peakLen;
          const pdy = peakDirY / peakLen;
          const pdz = peakDirZ / peakLen;
          const dot = nx * pdx + ny * pdy + nz * pdz;
          if (dot > 0) {
            const peakFactor = Math.pow(dot, 3) * peakStrength;
            x += pdx * peakFactor;
            y += pdy * peakFactor;
            z += pdz * peakFactor;
          }
        }

        // Surface detail
        const largeDetail = fbm3D(nx * 3 + seed, ny * 3 + seed * 0.7, nz * 3 + seed * 0.3, 2) * 0.12;
        const mediumDetail = fbm3D(nx * 6 + seed * 2, ny * 6 + seed * 1.5, nz * 6 + seed, 2) * 0.06;
        const smallDetail = noise3D(nx * 12 + seed * 3, ny * 12 + seed * 2.5, nz * 12) * 0.03;
        const surfaceDisp = largeDetail + mediumDetail + smallDetail;
        x += nx * surfaceDisp;
        y += ny * surfaceDisp;
        z += nz * surfaceDisp;

        newPositions[i] = x;
        newPositions[i + 1] = y;
        newPositions[i + 2] = z;
      }

      rock.updateVerticesData(VertexBuffer.PositionKind, newPositions);

      const indices = rock.getIndices();
      const normals = rock.getVerticesData(VertexBuffer.NormalKind);
      if (indices && normals) {
        VertexData.ComputeNormals(newPositions, indices, normals);
        rock.updateVerticesData(VertexBuffer.NormalKind, normals);
      }
    }

    setRockVertexColors(rock, seed);
    rock.scaling.setAll(params.size);
    return rock;
  }

  // ============================================
  // Tree Generation
  // ============================================

  private generateTree(params: GeneratorParams): Mesh {
    const seed = params.seed;
    const meshes: Mesh[] = [];
    const leafSubdivisions = calcSubdivision(params.size, 3);

    // Trunk parameters
    const trunkHeight = 0.8 + Math.abs(noise3D(seed, 0, 0)) * 1.2;
    const trunkThickness = 0.025 + Math.abs(noise3D(0, seed, 0)) * 0.04;
    const trunkTaper = 0.25 + Math.abs(noise3D(0, 0, seed)) * 0.45;
    const trunkBendX = noise3D(seed * 2, 0, 0) * 0.3;
    const trunkBendZ = noise3D(0, 0, seed * 2) * 0.3;
    const trunkTwist = noise3D(seed * 3, seed * 0.5, 0) * 0.5;

    const trunk = MeshBuilder.CreateCylinder(
      "trunk",
      {
        height: trunkHeight,
        diameterTop: trunkThickness * 2 * trunkTaper,
        diameterBottom: trunkThickness * 2,
        tessellation: 8,
        subdivisions: 8,
        updatable: true,
      },
      this.scene
    );

    // Deform trunk
    const trunkPositions = trunk.getVerticesData(VertexBuffer.PositionKind);
    if (trunkPositions) {
      const newPositions = new Float32Array(trunkPositions.length);
      const halfHeight = trunkHeight / 2;

      for (let i = 0; i < trunkPositions.length; i += 3) {
        let x = trunkPositions[i];
        let y = trunkPositions[i + 1];
        let z = trunkPositions[i + 2];

        const t = (y + halfHeight) / trunkHeight;

        x += trunkBendX * t * t;
        z += trunkBendZ * t * t;

        const twistAngle = trunkTwist * t;
        const cosT = Math.cos(twistAngle);
        const sinT = Math.sin(twistAngle);
        const rx = x * cosT - z * sinT;
        const rz = x * sinT + z * cosT;
        x = rx;
        z = rz;

        const bark = fbm3D(x * 20 + seed, y * 10, z * 20 + seed, 2) * 0.015;
        x += bark;
        z += bark;

        newPositions[i] = x;
        newPositions[i + 1] = y;
        newPositions[i + 2] = z;
      }
      trunk.updateVerticesData(VertexBuffer.PositionKind, newPositions);
    }

    trunk.position.y = trunkHeight / 2;
    setBarkVertexColors(trunk, seed, false);
    meshes.push(trunk);

    // Branches
    const branchCount = 3 + Math.floor(Math.abs(noise3D(seed * 4, seed, 0)) * 4);
    const branchStartY = trunkHeight * (0.35 + Math.abs(noise3D(seed * 4.5, 0, 0)) * 0.2);

    for (let i = 0; i < branchCount; i++) {
      const bSeed = seed + i * 73.1;

      const heightRatio = i / Math.max(branchCount - 1, 1);
      const branchLength = (0.2 + Math.abs(noise3D(bSeed, 0, 0)) * 0.25) * (1.15 - heightRatio * 0.4);
      const branchThick = (0.025 + Math.abs(noise3D(0, bSeed, 0)) * 0.02) * (1.2 - heightRatio * 0.3);

      const goldenAngle = Math.PI * (3 - Math.sqrt(5));
      const branchAngleH = i * goldenAngle + noise3D(0, 0, bSeed) * 0.4;
      const branchAngleV = (0.35 + heightRatio * 0.35) + Math.abs(noise3D(bSeed * 2, 0, 0)) * 0.25;

      const branchY = branchStartY + heightRatio * (trunkHeight * 0.85 - branchStartY);

      const t = branchY / trunkHeight;
      const trunkRadiusAtY = trunkThickness * (1 - t * (1 - trunkTaper));

      const bendOffsetX = trunkBendX * t * t;
      const bendOffsetZ = trunkBendZ * t * t;

      const branchStartOffset = trunkRadiusAtY * 0.3;
      const branchStartX = bendOffsetX + Math.cos(branchAngleH) * branchStartOffset;
      const branchStartZ = bendOffsetZ + Math.sin(branchAngleH) * branchStartOffset;

      const cosV = Math.cos(branchAngleV);
      const sinV = Math.sin(branchAngleV);
      const branchDirX = Math.cos(branchAngleH) * cosV;
      const branchDirY = sinV;
      const branchDirZ = Math.sin(branchAngleH) * cosV;

      const branchEndX = branchStartX + branchDirX * branchLength;
      const branchEndY = branchY + branchDirY * branchLength;
      const branchEndZ = branchStartZ + branchDirZ * branchLength;

      const branchCenterX = (branchStartX + branchEndX) / 2;
      const branchCenterY = (branchY + branchEndY) / 2;
      const branchCenterZ = (branchStartZ + branchEndZ) / 2;

      const branch = MeshBuilder.CreateCylinder(
        "branch_" + i,
        {
          height: branchLength,
          diameterTop: branchThick * 0.5,
          diameterBottom: branchThick,
          tessellation: 6,
          updatable: true,
        },
        this.scene
      );

      // Rotate branch
      const branchDirVec = new Vector3(branchDirX, branchDirY, branchDirZ).normalize();
      const upVec = Vector3.Up();
      const dot = Vector3.Dot(upVec, branchDirVec);

      if (Math.abs(dot + 1) < 0.0001) {
        branch.rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), Math.PI);
      } else if (Math.abs(dot - 1) < 0.0001) {
        branch.rotationQuaternion = Quaternion.Identity();
      } else {
        const axis = Vector3.Cross(upVec, branchDirVec).normalize();
        const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
        branch.rotationQuaternion = Quaternion.RotationAxis(axis, angle);
      }

      branch.position.x = branchCenterX;
      branch.position.y = branchCenterY;
      branch.position.z = branchCenterZ;
      setBarkVertexColors(branch, bSeed, true);

      meshes.push(branch);

      // Leaf clusters at branch end
      const leafClusterCount = 1 + Math.floor(Math.abs(noise3D(bSeed * 5, 0, 0)) * 1.5);

      for (let lc = 0; lc < leafClusterCount; lc++) {
        const lcSeed = bSeed + lc * 31.7;
        const leafSize = (0.1 + Math.abs(noise3D(lcSeed, 0, 0)) * 0.1) * (1.1 - heightRatio * 0.25);
        const leafScaleX = 0.8 + Math.abs(noise3D(lcSeed * 2, 0, 0)) * 0.4;
        const leafScaleY = 0.55 + Math.abs(noise3D(0, lcSeed * 2, 0)) * 0.3;
        const leafScaleZ = 0.8 + Math.abs(noise3D(0, 0, lcSeed * 2)) * 0.4;

        const leaf = MeshBuilder.CreateIcoSphere(
          "leaf_" + i + "_" + lc,
          { radius: leafSize, subdivisions: leafSubdivisions, updatable: true },
          this.scene
        );

        // Deform leaf
        const lPositions = leaf.getVerticesData(VertexBuffer.PositionKind);
        if (lPositions) {
          const newLPos = new Float32Array(lPositions.length);
          for (let j = 0; j < lPositions.length; j += 3) {
            let lx = lPositions[j] * leafScaleX;
            let ly = lPositions[j + 1] * leafScaleY;
            let lz = lPositions[j + 2] * leafScaleZ;

            if (ly < 0) {
              ly *= 0.4;
            }

            const llen = Math.sqrt(lx * lx + ly * ly + lz * lz);
            if (llen > 0.001) {
              const bump = fbm3D(lx * 5 + lcSeed, ly * 5, lz * 5, 2) * 0.05;
              lx += (lx / llen) * bump;
              ly += (ly / llen) * bump;
              lz += (lz / llen) * bump;
            }

            newLPos[j] = lx;
            newLPos[j + 1] = ly;
            newLPos[j + 2] = lz;
          }
          leaf.updateVerticesData(VertexBuffer.PositionKind, newLPos);

          const lIndices = leaf.getIndices();
          const lNormals = leaf.getVerticesData(VertexBuffer.NormalKind);
          if (lIndices && lNormals) {
            VertexData.ComputeNormals(newLPos, lIndices, lNormals);
            leaf.updateVerticesData(VertexBuffer.NormalKind, lNormals);
          }
        }

        const leafOffsetAngle = lc * Math.PI + noise3D(lcSeed * 3, 0, 0) * 0.8;
        const leafOffsetDist = lc === 0 ? 0 : leafSize * 0.25;
        leaf.position.x = branchEndX + Math.cos(leafOffsetAngle) * leafOffsetDist;
        leaf.position.y = branchEndY + leafSize * leafScaleY * 0.15;
        leaf.position.z = branchEndZ + Math.sin(leafOffsetAngle) * leafOffsetDist;

        setLeafVertexColors(leaf, lcSeed, false);
        meshes.push(leaf);
      }
    }

    // Top leaves
    const topLeafCount = 2 + Math.floor(Math.abs(noise3D(seed * 7, seed, 0)) * 2);
    const trunkTopX = trunkBendX;
    const trunkTopZ = trunkBendZ;
    const trunkTopY = trunkHeight;
    const trunkTopRadius = trunkThickness * trunkTaper;

    for (let i = 0; i < topLeafCount; i++) {
      const tSeed = seed + i * 51.7 + 1000;
      const topLeafSize = 0.12 + Math.abs(noise3D(tSeed, 0, 0)) * 0.15;
      const topLeafScaleX = 0.75 + Math.abs(noise3D(tSeed * 2, 0, 0)) * 0.4;
      const topLeafScaleY = 0.55 + Math.abs(noise3D(0, tSeed * 2, 0)) * 0.35;
      const topLeafScaleZ = 0.75 + Math.abs(noise3D(0, 0, tSeed * 2)) * 0.4;

      const topLeaf = MeshBuilder.CreateIcoSphere(
        "topLeaf_" + i,
        { radius: topLeafSize, subdivisions: leafSubdivisions, updatable: true },
        this.scene
      );

      const tlPositions = topLeaf.getVerticesData(VertexBuffer.PositionKind);
      if (tlPositions) {
        const newTLPos = new Float32Array(tlPositions.length);
        for (let j = 0; j < tlPositions.length; j += 3) {
          let tlx = tlPositions[j] * topLeafScaleX;
          let tly = tlPositions[j + 1] * topLeafScaleY;
          let tlz = tlPositions[j + 2] * topLeafScaleZ;

          if (tly < 0) {
            tly *= 0.35;
          }

          const tllen = Math.sqrt(tlx * tlx + tly * tly + tlz * tlz);
          if (tllen > 0.001) {
            const bump = fbm3D(tlx * 5 + tSeed, tly * 5, tlz * 5, 2) * 0.07;
            tlx += (tlx / tllen) * bump;
            tly += (tly / tllen) * bump;
            tlz += (tlz / tllen) * bump;
          }

          newTLPos[j] = tlx;
          newTLPos[j + 1] = tly;
          newTLPos[j + 2] = tlz;
        }
        topLeaf.updateVerticesData(VertexBuffer.PositionKind, newTLPos);

        const tlIndices = topLeaf.getIndices();
        const tlNormals = topLeaf.getVerticesData(VertexBuffer.NormalKind);
        if (tlIndices && tlNormals) {
          VertexData.ComputeNormals(newTLPos, tlIndices, tlNormals);
          topLeaf.updateVerticesData(VertexBuffer.NormalKind, tlNormals);
        }
      }

      const topTheta = i * (Math.PI * 2 / topLeafCount) + noise3D(0, tSeed * 3, 0) * 0.6;
      const topDist = trunkTopRadius * 0.3 + Math.abs(noise3D(tSeed * 4, 0, 0)) * 0.08;
      const layerHeight = i * 0.03;

      topLeaf.position.x = trunkTopX + Math.cos(topTheta) * topDist;
      topLeaf.position.z = trunkTopZ + Math.sin(topTheta) * topDist;
      topLeaf.position.y = trunkTopY + topLeafSize * topLeafScaleY * 0.15 + layerHeight;

      setLeafVertexColors(topLeaf, tSeed, true);
      meshes.push(topLeaf);
    }

    const merged = Mesh.MergeMeshes(meshes, true, true, undefined, false, true);
    if (merged) {
      merged.name = "tree_" + seed;
      merged.scaling.setAll(params.size);
      return merged;
    }

    return new Mesh("tree_" + seed, this.scene);
  }

  // ============================================
  // Bush Generation
  // ============================================

  private generateBush(params: GeneratorParams): Mesh {
    const seed = params.seed;
    const meshes: Mesh[] = [];
    const bushSubdivisions = calcSubdivision(params.size, 3);

    const overallSpread = 0.25 + Math.abs(noise3D(0, seed, 0)) * 0.35;
    const branchCount = 6 + Math.floor(Math.abs(noise3D(seed * 4, seed, 0)) * 6);

    for (let i = 0; i < branchCount; i++) {
      const iSeed = seed + i * 97.3;

      const branchLength = 0.08 + Math.abs(noise3D(iSeed, 0, 0)) * 0.12;
      const branchThickness = 0.04 + Math.abs(noise3D(0, iSeed, 0)) * 0.06;
      const branchFlatness = 0.4 + Math.abs(noise3D(0, 0, iSeed)) * 0.5;

      const theta = (noise3D(0, iSeed * 2, 0) + 0.5) * Math.PI * 2;
      const elevationAngle = Math.abs(noise3D(iSeed * 2.5, 0, 0)) * 0.4;

      const sphere = MeshBuilder.CreateIcoSphere(
        "bush_" + i,
        { radius: branchLength, subdivisions: bushSubdivisions, updatable: true },
        this.scene
      );

      const positions = sphere.getVerticesData(VertexBuffer.PositionKind);
      if (positions) {
        const newPositions = new Float32Array(positions.length);

        for (let j = 0; j < positions.length; j += 3) {
          let x = positions[j];
          let y = positions[j + 1];
          let z = positions[j + 2];

          const dirX = Math.cos(theta) * Math.cos(elevationAngle);
          const dirY = Math.sin(elevationAngle);
          const dirZ = Math.sin(theta) * Math.cos(elevationAngle);

          const dot = (x * dirX + y * dirY + z * dirZ) / branchLength;
          const stretch = 1.0 + Math.max(0, dot) * 1.5;

          x *= branchThickness / branchLength * stretch;
          y *= branchThickness / branchLength * branchFlatness * stretch;
          z *= branchThickness / branchLength * stretch;

          x += dirX * branchLength * 0.5;
          y += dirY * branchLength * 0.3;
          z += dirZ * branchLength * 0.5;

          const len = Math.sqrt(x * x + y * y + z * z);
          if (len > 0.001) {
            const bump = fbm3D(x * 8 + iSeed, y * 8, z * 8 + iSeed * 0.5, 2) * 0.02;
            x += (x / len) * bump;
            y += (y / len) * bump;
            z += (z / len) * bump;
          }

          newPositions[j] = x;
          newPositions[j + 1] = y;
          newPositions[j + 2] = z;
        }

        sphere.updateVerticesData(VertexBuffer.PositionKind, newPositions);

        const indices = sphere.getIndices();
        const normals = sphere.getVerticesData(VertexBuffer.NormalKind);
        if (indices && normals) {
          VertexData.ComputeNormals(newPositions, indices, normals);
          sphere.updateVerticesData(VertexBuffer.NormalKind, normals);
        }
      }

      const radialDist = Math.abs(noise3D(iSeed * 3, 0, 0)) * overallSpread * 0.3;
      const posTheta = (noise3D(iSeed * 3.5, 0, 0) + 0.5) * Math.PI * 2;
      sphere.position.x = Math.cos(posTheta) * radialDist;
      sphere.position.z = Math.sin(posTheta) * radialDist;
      sphere.position.y = branchThickness * 0.3;

      setBushVertexColors(sphere, iSeed);
      meshes.push(sphere);
    }

    const merged = Mesh.MergeMeshes(meshes, true, true, undefined, false, true);
    if (merged) {
      merged.name = "bush_" + seed;
      merged.scaling.setAll(params.size);
      return merged;
    }

    return new Mesh("bush_" + seed, this.scene);
  }

  // ============================================
  // Grass Clump Generation
  // ============================================

  private generateGrassClump(params: GeneratorParams): Mesh {
    const seed = params.seed;
    const blades: Mesh[] = [];

    const clumpDensity = 0.3 + Math.abs(noise3D(seed * 0.5, 0, 0)) * 0.7;
    const clumpSpread = 0.04 + Math.abs(noise3D(0, seed * 0.5, 0)) * 0.16;
    const avgHeight = 0.2 + Math.abs(noise3D(0, 0, seed * 0.5)) * 0.5;
    const avgWidth = 0.012 + Math.abs(noise3D(seed * 0.6, seed * 0.3, 0)) * 0.028;

    const bladeCount = Math.floor(4 + clumpDensity * 12);

    for (let i = 0; i < bladeCount; i++) {
      const iSeed = seed + i * 73.7;

      const heightVar = 0.6 + Math.abs(noise3D(iSeed, 0, 0)) * 0.8;
      const widthVar = 0.7 + Math.abs(noise3D(0, iSeed, 0)) * 0.6;
      const bladeHeight = avgHeight * heightVar;
      const bladeWidth = avgWidth * widthVar;

      const curveBase = 0.02 + Math.abs(noise3D(0, 0, iSeed)) * 0.12;
      const bladeCurve = curveBase * (bladeHeight / 0.4);

      const h1 = bladeHeight * 0.35;
      const h2 = bladeHeight * 0.65;
      const h3 = bladeHeight * 0.9;
      const h4 = bladeHeight;

      const c1 = bladeCurve * 0.25;
      const c2 = bladeCurve * 0.6;
      const c3 = bladeCurve * 0.9;
      const c4 = bladeCurve;

      const taperRate = 0.6 + Math.abs(noise3D(iSeed * 1.5, 0, 0)) * 0.35;

      const positions = [
        -bladeWidth, 0, 0,
        bladeWidth, 0, 0,
        -bladeWidth * taperRate, h1, c1,
        bladeWidth * taperRate, h1, c1,
        -bladeWidth * taperRate * 0.7, h2, c2,
        bladeWidth * taperRate * 0.7, h2, c2,
        -bladeWidth * taperRate * 0.35, h3, c3,
        bladeWidth * taperRate * 0.35, h3, c3,
        0, h4, c4,
      ];

      const indices = [
        0, 1, 2, 1, 3, 2,
        2, 3, 4, 3, 5, 4,
        4, 5, 6, 5, 7, 6,
        6, 7, 8,
      ];

      const normals: number[] = [];
      for (let j = 0; j < positions.length; j += 3) {
        const y = positions[j + 1];
        const progress = y / h4;
        const nz = 0.4 + progress * 0.4;
        const ny = 0.3 * (1 - progress);
        const len = Math.sqrt(nz * nz + ny * ny);
        normals.push(0, ny / len, nz / len);
      }

      const uvs = [0, 0, 1, 0, 0.1, 0.35, 0.9, 0.35, 0.2, 0.65, 0.8, 0.65, 0.35, 0.9, 0.65, 0.9, 0.5, 1];

      const blade = new Mesh("blade_" + i, this.scene);
      const vertexData = new VertexData();
      vertexData.positions = positions;
      vertexData.indices = indices;
      vertexData.normals = normals;
      vertexData.uvs = uvs;
      vertexData.applyToMesh(blade);

      const angle = (noise3D(iSeed * 2, 0, 0) + 0.5) * Math.PI * 2;
      const distFactor = Math.pow(Math.abs(noise3D(0, iSeed * 2, 0)), 1.0 / clumpDensity);
      const dist = distFactor * clumpSpread;

      blade.position.x = Math.cos(angle) * dist;
      blade.position.z = Math.sin(angle) * dist;

      blade.rotation.y = (noise3D(iSeed, iSeed, 0) + 0.5) * Math.PI * 2;
      blade.rotation.x = noise3D(iSeed * 3, 0, 0) * 0.12;
      blade.rotation.z = noise3D(0, iSeed * 3, 0) * 0.1;

      blades.push(blade);
    }

    // Set grass vertex colors
    for (const blade of blades) {
      setMeshVertexColor(blade, 0.35, 0.45, 0.22);
    }

    const merged = Mesh.MergeMeshes(blades, true, true, undefined, false, true);
    if (merged) {
      merged.name = "grass_" + seed;
      merged.scaling.setAll(params.size);
      return merged;
    }

    return new Mesh("grass_" + seed, this.scene);
  }
}
