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
} from "@babylonjs/core";
import * as BABYLON from "@babylonjs/core";

// ============================================
// Wind-enabled vertex shader for foliage (grass, bush, tree leaves)
// ============================================
Effect.ShadersStore["foliageWindVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
attribute vec4 color;  // Vertex color (RGBA)

uniform mat4 worldViewProjection;
uniform mat4 world;
uniform vec3 cameraPosition;
uniform float uTime;
uniform vec2 uWindDirection;  // Normalized XZ direction
uniform float uWindStrength;  // 0.0 ~ 1.0
uniform float uMinWindHeight; // Y threshold where wind starts
uniform float uMaxWindHeight; // Y where wind is at full strength

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;
varying vec4 vColor;  // Pass vertex color to fragment

// Simple noise for wind variation
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

    // Height factor: higher vertices move more
    // Uses configurable min/max height for different asset types
    float heightAboveMin = max(0.0, localPos.y - uMinWindHeight);
    float heightRange = max(0.01, uMaxWindHeight - uMinWindHeight);
    float heightFactor = clamp(heightAboveMin / heightRange, 0.0, 1.0);
    heightFactor = heightFactor * heightFactor;  // Quadratic for natural feel

    // Wind wave: travels through space over time
    vec2 worldPosXZ = worldPos.xz;
    float windPhase = dot(worldPosXZ, uWindDirection) * 0.5 + uTime * 2.0;

    // Primary wave (slow, large movement)
    float primaryWave = sin(windPhase) * 0.5 + 0.5;

    // Secondary wave (faster, smaller, gives rustling effect)
    float secondaryPhase = dot(worldPosXZ, uWindDirection) * 2.0 + uTime * 5.0;
    float secondaryWave = sin(secondaryPhase) * 0.3 + 0.5;

    // Noise for variation (so not all grass moves identically)
    float noiseVal = noise2D(worldPosXZ * 0.3 + uTime * 0.2);

    // Combined wind displacement
    float windAmount = (primaryWave * 0.7 + secondaryWave * 0.3 + noiseVal * 0.2) * heightFactor * uWindStrength;

    // Apply displacement in wind direction (XZ plane)
    localPos.x += uWindDirection.x * windAmount * 0.15;
    localPos.z += uWindDirection.y * windAmount * 0.15;

    // Slight bend backward (opposite to wind for natural look)
    localPos.y -= windAmount * 0.03;

    vec4 finalWorldPos = world * vec4(localPos, 1.0);
    gl_Position = worldViewProjection * vec4(localPos, 1.0);

    vNormal = normalize(mat3(world) * normal);
    vPosition = finalWorldPos.xyz;
    vLocalPosition = localPos;
    vUV = uv;
    vCameraDistance = length(cameraPosition - finalWorldPos.xyz);
    vViewDirection = normalize(cameraPosition - finalWorldPos.xyz);
    vColor = color;  // Pass vertex color
}
`;

Effect.ShadersStore["foliageWindFragmentShader"] = `
#extension GL_OES_standard_derivatives : enable
precision highp float;

uniform vec3 baseColor;
uniform vec3 detailColor;
uniform vec3 sunDirection;
uniform float ambientIntensity;
uniform vec3 fogColor;
uniform float fogDensity;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;
varying vec4 vColor;  // Vertex color from vertex shader

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

    // Use vertex color if available (alpha > 0), otherwise use baseColor
    vec3 meshColor = vColor.a > 0.5 ? vColor.rgb : baseColor;

    // Color variation with noise
    float colorNoise = fbm(vPosition * 2.0);
    vec3 color = mix(meshColor, meshColor * 0.8, colorNoise * 0.3);

    // Height-based color (tips lighter) - only for foliage, not trunk
    float tipFactor = smoothstep(0.0, 0.6, vLocalPosition.y);
    float isLeaf = vColor.g > vColor.r ? 1.0 : 0.3;  // Green = leaf, brown = trunk
    color = mix(color * 0.85, color * 1.1, tipFactor * isLeaf);

    // Half-Lambert diffuse
    float NdotL = dot(normal, sunDirection);
    float halfLambert = NdotL * 0.5 + 0.5;
    halfLambert = halfLambert * halfLambert;

    // Rim lighting
    float rimFactor = 1.0 - max(dot(normal, vViewDirection), 0.0);
    rimFactor = pow(rimFactor, 3.0) * 0.2;

    // Subsurface scattering approximation (light through leaves)
    float sss = max(0.0, dot(-vViewDirection, sunDirection)) * tipFactor * 0.15;

    // Final lighting
    float diffuse = halfLambert * 0.6 + 0.4;
    vec3 ambient = vec3(ambientIntensity);
    vec3 rim = vec3(rimFactor) * vec3(0.8, 0.9, 1.0);

    color = color * (ambient + diffuse) + rim + vec3(0.1, 0.15, 0.05) * sss;

    // Fog
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vCameraDistance * vCameraDistance);
    color = mix(color, fogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(color, 1.0);
}
`;

// ============================================
// Register procedural asset shaders - Per-pixel smooth shading
// ============================================
Effect.ShadersStore["proceduralAssetVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

uniform mat4 worldViewProjection;
uniform mat4 world;
uniform vec3 cameraPosition;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;

void main() {
    vec4 worldPos = world * vec4(position, 1.0);
    gl_Position = worldViewProjection * vec4(position, 1.0);

    vNormal = normalize(mat3(world) * normal);
    vPosition = worldPos.xyz;
    vLocalPosition = position;
    vUV = uv;
    vCameraDistance = length(cameraPosition - worldPos.xyz);
    vViewDirection = normalize(cameraPosition - worldPos.xyz);
}
`;

Effect.ShadersStore["proceduralAssetFragmentShader"] = `
#extension GL_OES_standard_derivatives : enable
precision highp float;

uniform vec3 baseColor;
uniform vec3 detailColor;
uniform vec3 sunDirection;
uniform float ambientIntensity;
uniform vec3 fogColor;
uniform float fogDensity;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;

// 3D noise functions for per-pixel detail
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
    // Screen-space derivatives로 부드러운 노멀 계산
    vec3 dPdx = dFdx(vPosition);
    vec3 dPdy = dFdy(vPosition);
    vec3 geometricNormal = normalize(cross(dPdx, dPdy));

    // 버텍스 노멀
    vec3 smoothNormal = normalize(vNormal);

    // === Edge Detection (노멀 변화량 감지) ===
    vec3 dNdx = dFdx(smoothNormal);
    vec3 dNdy = dFdy(smoothNormal);
    float edgeStrength = length(dNdx) + length(dNdy);

    // 엣지 강도를 0~1로 정규화 (임계값 조정)
    float edgeFactor = smoothstep(0.1, 0.5, edgeStrength);

    // === Edge Blending (Make Seamless 방식) ===
    // 엣지에서는 geometric normal을 더 많이 사용 (부드러운 전환)
    // 비엣지에서는 vertex normal 유지 (디테일 보존)
    float blendRatio = mix(0.9, 0.5, edgeFactor);  // 엣지일수록 geometric 비중 높임
    vec3 normal = normalize(mix(geometricNormal, smoothNormal, blendRatio));

    // Per-pixel 노멀 perturbation (미세한 표면 디테일)
    float noiseScale = 8.0;
    float noiseStrength = 0.12;  // 엣지 블렌딩과 조화롭게 약간 줄임
    vec3 noisePos = vLocalPosition * noiseScale;

    float nx = fbm(noisePos + vec3(0.1, 0.0, 0.0)) - fbm(noisePos - vec3(0.1, 0.0, 0.0));
    float ny = fbm(noisePos + vec3(0.0, 0.1, 0.0)) - fbm(noisePos - vec3(0.0, 0.1, 0.0));
    float nz = fbm(noisePos + vec3(0.0, 0.0, 0.1)) - fbm(noisePos - vec3(0.0, 0.0, 0.1));
    vec3 noisePerturbation = normalize(vec3(nx, ny, nz)) * noiseStrength;

    // 엣지에서는 perturbation 줄이기 (더 부드럽게)
    noisePerturbation *= (1.0 - edgeFactor * 0.5);
    normal = normalize(normal + noisePerturbation);

    // Color variation (per-pixel)
    float colorNoise = fbm(vPosition * 2.0);
    vec3 color = mix(baseColor, detailColor, colorNoise * 0.5);

    // Half-Lambert diffuse (더 부드러운 명암 전환)
    float NdotL = dot(normal, sunDirection);
    float halfLambert = NdotL * 0.5 + 0.5;
    halfLambert = halfLambert * halfLambert;

    // === Edge Softening (엣지에서 조명 부드럽게) ===
    // 엣지 부근에서 diffuse를 살짝 밝게 (급격한 명암 전환 방지)
    halfLambert = mix(halfLambert, halfLambert * 0.7 + 0.3, edgeFactor * 0.4);

    // Rim lighting (가장자리 강조로 형태감 향상)
    float rimFactor = 1.0 - max(dot(normal, vViewDirection), 0.0);
    rimFactor = pow(rimFactor, 3.0) * 0.25;

    // Ambient occlusion 근사 (오목한 부분 어둡게)
    float ao = 0.5 + 0.5 * smoothNormal.y;

    // 최종 조명 계산
    float diffuse = halfLambert * 0.6 + 0.4;
    vec3 ambient = vec3(ambientIntensity) * ao;
    vec3 rim = vec3(rimFactor) * vec3(0.8, 0.85, 1.0);

    color = color * (ambient + diffuse) + rim;

    // Fog
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vCameraDistance * vCameraDistance);
    color = mix(color, fogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(color, 1.0);
}
`;

export type AssetType = "rock" | "tree" | "bush" | "grass_clump";

export interface AssetParams {
  type: AssetType;
  seed: number;
  size: number;           // Base size
  sizeVariation: number;  // 0-1, how much size can vary
  noiseScale: number;     // Noise frequency
  noiseAmplitude: number; // Noise strength
  colorBase: Color3;
  colorDetail: Color3;
}

export const DEFAULT_ASSET_PARAMS: Record<AssetType, AssetParams> = {
  rock: {
    type: "rock",
    seed: Math.random() * 10000,
    size: 1.0,
    sizeVariation: 0.3,
    noiseScale: 3.0,
    noiseAmplitude: 0.2,
    colorBase: new Color3(0.35, 0.33, 0.30),
    colorDetail: new Color3(0.50, 0.48, 0.45),
  },
  tree: {
    type: "tree",
    seed: Math.random() * 10000,
    size: 3.0,
    sizeVariation: 0.4,
    noiseScale: 2.0,
    noiseAmplitude: 0.15,
    colorBase: new Color3(0.25, 0.45, 0.15),
    colorDetail: new Color3(0.35, 0.55, 0.20),
  },
  bush: {
    type: "bush",
    seed: Math.random() * 10000,
    size: 0.8,
    sizeVariation: 0.3,
    noiseScale: 4.0,
    noiseAmplitude: 0.25,
    colorBase: new Color3(0.20, 0.40, 0.12),
    colorDetail: new Color3(0.30, 0.50, 0.18),
  },
  grass_clump: {
    type: "grass_clump",
    seed: Math.random() * 10000,
    size: 0.4,
    sizeVariation: 0.2,
    noiseScale: 5.0,
    noiseAmplitude: 0.1,
    colorBase: new Color3(0.15, 0.35, 0.08),
    colorDetail: new Color3(0.35, 0.55, 0.15),
  },
};

// Size-based subdivision calculation
function calcSubdivision(size: number, base: number = 4): number {
  // size 1.0 → base, size 2.0 → base+1, size 4.0 → base+2
  const subdiv = Math.floor(base + Math.log2(Math.max(size, 0.25)));
  return Math.max(3, Math.min(6, subdiv));  // clamp 3~6
}

// 3D noise functions for mesh generation
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

// Helper to add vertex colors to a mesh
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

export class ProceduralAsset {
  private scene: Scene;
  private mesh: Mesh | null = null;
  private material: ShaderMaterial | null = null;
  private params: AssetParams;

  constructor(scene: Scene, params: AssetParams) {
    this.scene = scene;
    this.params = { ...params };
  }

  generate(): Mesh {
    this.dispose();

    switch (this.params.type) {
      case "rock":
        this.mesh = this.generateRock();
        break;
      case "tree":
        this.mesh = this.generateTree();
        break;
      case "bush":
        this.mesh = this.generateBush();
        break;
      case "grass_clump":
        this.mesh = this.generateGrassClump();
        break;
    }

    this.createMaterial();
    if (this.mesh && this.material) {
      this.mesh.material = this.material;
    }

    return this.mesh!;
  }

  /**
   * 바위 생성 - 형태 공간 탐색:
   *
   * 1. 기본 비율 (elongation): 어느 축으로 늘어나는지
   *    - 기둥형: Y축이 긴 형태
   *    - 판형: Y축이 짧은 납작한 형태
   *    - 구형: 모든 축이 비슷
   *
   * 2. 테이퍼 (taper): 한쪽이 좁아지는 정도
   *    - 역삼각형: 위가 넓고 아래가 좁음
   *    - 쐐기형: 한쪽 방향으로 뾰족해짐
   *
   * 3. 비대칭 (asymmetry): 무게중심이 치우친 정도
   *    - 한쪽으로 볼록하게 튀어나옴
   *
   * 4. 비틀림 (twist): 높이에 따라 회전하는 정도
   *
   * 5. 굴곡 (bend): 전체적으로 휘어진 정도
   *
   * 6. 표면 거칠기: 작은 범프와 홈
   */
  private generateRock(): Mesh {
    const seed = this.params.seed;
    const subdivisions = calcSubdivision(this.params.size, 4);

    const rock = MeshBuilder.CreateIcoSphere(
      "rock_" + seed,
      { radius: 0.5, subdivisions, flat: false, updatable: true },
      this.scene
    );

    // === 형태 파라미터 (seed에서 추출) - 자연스러운 범위 ===

    // 1. 기본 비율 - 각 축의 스케일
    const scaleX = 0.5 + Math.abs(noise3D(seed * 1.0, 0, 0)) * 1.2;      // 0.5 ~ 1.7
    const scaleY = 0.4 + Math.abs(noise3D(0, seed * 1.1, 0)) * 1.6;      // 0.4 ~ 2.0 (납작 ~ 길쭉)
    const scaleZ = 0.5 + Math.abs(noise3D(0, 0, seed * 1.2)) * 1.2;      // 0.5 ~ 1.7

    // 2. 테이퍼 - 높이에 따라 좁아지는 정도
    const taperY = noise3D(seed * 2.0, seed * 0.5, 0) * 0.7;             // -0.7 ~ 0.7
    const taperX = noise3D(seed * 2.1, 0, seed * 0.5) * 0.4;             // X방향 테이퍼
    const taperZ = noise3D(0, seed * 2.2, seed * 0.6) * 0.4;             // Z방향 테이퍼

    // 3. 비대칭 - 무게중심 오프셋
    const asymOffsetX = noise3D(seed * 3.0, seed * 0.3, 0) * 0.35;
    const asymOffsetY = noise3D(seed * 0.3, seed * 3.1, 0) * 0.25;
    const asymOffsetZ = noise3D(0, seed * 0.3, seed * 3.2) * 0.35;

    // 4. 비틀림 - 높이에 따른 회전량
    const twistAmount = noise3D(seed * 4.0, seed * 0.7, seed * 0.3) * 0.6;  // -0.6 ~ 0.6 라디안 (약 ±35도)

    // 5. 굴곡 - 전체 휘어짐
    const bendX = noise3D(seed * 5.0, 0, 0) * 0.4;
    const bendZ = noise3D(0, 0, seed * 5.1) * 0.4;

    // 6. 뾰족함 정도
    const peakDirX = noise3D(seed * 6.0, seed * 0.2, 0);
    const peakDirY = noise3D(seed * 0.2, seed * 6.1, 0);
    const peakDirZ = noise3D(0, seed * 0.2, seed * 6.2);
    const peakLen = Math.sqrt(peakDirX * peakDirX + peakDirY * peakDirY + peakDirZ * peakDirZ);
    const peakStrength = 0.1 + Math.abs(noise3D(seed * 6.5, seed * 6.6, seed * 6.7)) * 0.4;  // 0.1 ~ 0.5



    const positions = rock.getVerticesData(VertexBuffer.PositionKind);
    if (positions) {
      const newPositions = new Float32Array(positions.length);

      for (let i = 0; i < positions.length; i += 3) {
        let x = positions[i];
        let y = positions[i + 1];
        let z = positions[i + 2];

        // 정규화 (구 표면의 방향)
        const len = Math.sqrt(x * x + y * y + z * z);
        const nx = x / len;
        const ny = y / len;
        const nz = z / len;

        // === 형태 변형 적용 ===

        // 1. 기본 비율 적용
        x *= scaleX;
        y *= scaleY;
        z *= scaleZ;

        // 2. 테이퍼 적용 (높이에 따라 좁아짐)
        const taperFactorY = 1.0 - taperY * ny;  // ny가 +1이면 위, -1이면 아래
        const taperFactorX = 1.0 - taperX * nx;
        const taperFactorZ = 1.0 - taperZ * nz;
        x *= taperFactorY * taperFactorX;
        z *= taperFactorY * taperFactorZ;

        // 3. 비틀림 적용 (y 높이에 따라 xz 평면에서 회전)
        const twistAngle = twistAmount * ny;
        const cosT = Math.cos(twistAngle);
        const sinT = Math.sin(twistAngle);
        const rx = x * cosT - z * sinT;
        const rz = x * sinT + z * cosT;
        x = rx;
        z = rz;

        // 4. 굴곡 적용 (높이에 따라 옆으로 휨)
        x += bendX * y * y;
        z += bendZ * y * y;

        // 5. 비대칭 오프셋 (전체적으로 한쪽으로 밀림)
        x += asymOffsetX * (1.0 - Math.abs(ny));  // 중간 높이에서 가장 많이
        y += asymOffsetY;
        z += asymOffsetZ * (1.0 - Math.abs(ny));

        // 6. 뾰족한 부분 (특정 방향으로 튀어나옴)
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

        // === 표면 디테일 ===
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

    rock.scaling.setAll(this.params.size);
    return rock;
  }

  /**
   * 나무 생성 - 다양한 형태의 나무
   *
   * - 줄기: 두께, 높이, 휘어짐, 비틀림 다양성
   * - 가지: 뻗어가는 방향, 길이, 두께 다양성
   * - 잎: 덩어리 크기, 형태 다양성
   */
  private generateTree(): Mesh {
    const seed = this.params.seed;
    const meshes: Mesh[] = [];
    const leafSubdivisions = calcSubdivision(this.params.size, 3);

    // === 줄기 형태 파라미터 ===
    const trunkHeight = 0.8 + Math.abs(noise3D(seed, 0, 0)) * 1.2;                    // 0.8 ~ 2.0
    const trunkThickness = 0.06 + Math.abs(noise3D(0, seed, 0)) * 0.1;               // 0.06 ~ 0.16
    const trunkTaper = 0.25 + Math.abs(noise3D(0, 0, seed)) * 0.45;                   // 0.25 ~ 0.7 (위쪽 비율)
    const trunkBendX = noise3D(seed * 2, 0, 0) * 0.3;                                 // 휘어짐
    const trunkBendZ = noise3D(0, 0, seed * 2) * 0.3;
    const trunkTwist = noise3D(seed * 3, seed * 0.5, 0) * 0.5;                        // 비틀림

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

    // 줄기 변형 적용
    const trunkPositions = trunk.getVerticesData(VertexBuffer.PositionKind);
    if (trunkPositions) {
      const newPositions = new Float32Array(trunkPositions.length);
      const halfHeight = trunkHeight / 2;

      for (let i = 0; i < trunkPositions.length; i += 3) {
        let x = trunkPositions[i];
        let y = trunkPositions[i + 1];
        let z = trunkPositions[i + 2];

        const t = (y + halfHeight) / trunkHeight;  // 0~1

        // 휘어짐 (2차 곡선)
        x += trunkBendX * t * t;
        z += trunkBendZ * t * t;

        // 비틀림
        const twistAngle = trunkTwist * t;
        const cosT = Math.cos(twistAngle);
        const sinT = Math.sin(twistAngle);
        const rx = x * cosT - z * sinT;
        const rz = x * sinT + z * cosT;
        x = rx;
        z = rz;

        // 껍질 울퉁불퉁
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
    setMeshVertexColor(trunk, 0.55, 0.38, 0.22);  // Brighter brown for trunk
    meshes.push(trunk);

    // === 가지 파라미터 ===
    const branchCount = 2 + Math.floor(Math.abs(noise3D(seed * 4, seed, 0)) * 4);    // 2~6개 가지
    const branchStartY = trunkHeight * (0.4 + Math.abs(noise3D(seed * 4.5, 0, 0)) * 0.3);  // 가지 시작 높이

    for (let i = 0; i < branchCount; i++) {
      const bSeed = seed + i * 73.1;

      const branchLength = 0.15 + Math.abs(noise3D(bSeed, 0, 0)) * 0.25;             // 0.15 ~ 0.4
      const branchThick = 0.02 + Math.abs(noise3D(0, bSeed, 0)) * 0.03;              // 0.02 ~ 0.05
      const branchAngleH = (noise3D(0, 0, bSeed) + 0.5) * Math.PI * 2;               // 수평 방향
      const branchAngleV = 0.3 + Math.abs(noise3D(bSeed * 2, 0, 0)) * 0.6;           // 0.3 ~ 0.9 rad (위로)
      const branchY = branchStartY + (i / branchCount) * (trunkHeight - branchStartY) * 0.7;

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

      // 가지 방향 설정
      branch.rotation.z = Math.PI / 2 - branchAngleV;
      branch.rotation.y = branchAngleH;

      // 가지 위치 (줄기에서 시작)
      const bendOffset = trunkBendX * Math.pow(branchY / trunkHeight, 2);
      const bendOffsetZ = trunkBendZ * Math.pow(branchY / trunkHeight, 2);
      branch.position.x = bendOffset + Math.cos(branchAngleH) * branchLength * 0.4;
      branch.position.z = bendOffsetZ + Math.sin(branchAngleH) * branchLength * 0.4;
      branch.position.y = branchY;
      setMeshVertexColor(branch, 0.5, 0.35, 0.2);  // Brighter brown for branch

      meshes.push(branch);

      // 가지 끝에 잎사귀
      const leafSize = 0.1 + Math.abs(noise3D(bSeed * 3, 0, 0)) * 0.15;              // 0.1 ~ 0.25
      const leafScaleX = 0.7 + Math.abs(noise3D(bSeed * 4, 0, 0)) * 0.5;
      const leafScaleY = 0.5 + Math.abs(noise3D(0, bSeed * 4, 0)) * 0.4;
      const leafScaleZ = 0.7 + Math.abs(noise3D(0, 0, bSeed * 4)) * 0.5;

      const leaf = MeshBuilder.CreateIcoSphere(
        "leaf_" + i,
        { radius: leafSize, subdivisions: leafSubdivisions, updatable: true },
        this.scene
      );

      // 잎사귀 변형
      const lPositions = leaf.getVerticesData(VertexBuffer.PositionKind);
      if (lPositions) {
        const newLPos = new Float32Array(lPositions.length);
        for (let j = 0; j < lPositions.length; j += 3) {
          let lx = lPositions[j] * leafScaleX;
          let ly = lPositions[j + 1] * leafScaleY;
          let lz = lPositions[j + 2] * leafScaleZ;

          const llen = Math.sqrt(lx * lx + ly * ly + lz * lz);
          if (llen > 0.001) {
            const bump = fbm3D(lx * 6 + bSeed, ly * 6, lz * 6 + bSeed * 0.5, 2) * 0.08;
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

      // 잎사귀 위치 (가지 끝)
      leaf.position.x = bendOffset + Math.cos(branchAngleH) * branchLength * 0.9;
      leaf.position.z = bendOffsetZ + Math.sin(branchAngleH) * branchLength * 0.9;
      leaf.position.y = branchY + Math.sin(branchAngleV) * branchLength * 0.5;
      setMeshVertexColor(leaf, 0.35, 0.65, 0.25);  // Brighter green for leaf

      meshes.push(leaf);
    }

    // === 꼭대기 잎사귀 ===
    const topLeafCount = 2 + Math.floor(Math.abs(noise3D(seed * 7, seed, 0)) * 3);   // 2~5개
    for (let i = 0; i < topLeafCount; i++) {
      const tSeed = seed + i * 51.7 + 1000;
      const topLeafSize = 0.15 + Math.abs(noise3D(tSeed, 0, 0)) * 0.2;
      const topLeafScaleX = 0.6 + Math.abs(noise3D(tSeed * 2, 0, 0)) * 0.6;
      const topLeafScaleY = 0.5 + Math.abs(noise3D(0, tSeed * 2, 0)) * 0.5;
      const topLeafScaleZ = 0.6 + Math.abs(noise3D(0, 0, tSeed * 2)) * 0.6;

      const topLeaf = MeshBuilder.CreateIcoSphere(
        "topLeaf_" + i,
        { radius: topLeafSize, subdivisions: leafSubdivisions, updatable: true },
        this.scene
      );

      // 꼭대기 잎사귀 변형
      const tlPositions = topLeaf.getVerticesData(VertexBuffer.PositionKind);
      if (tlPositions) {
        const newTLPos = new Float32Array(tlPositions.length);
        for (let j = 0; j < tlPositions.length; j += 3) {
          let tlx = tlPositions[j] * topLeafScaleX;
          let tly = tlPositions[j + 1] * topLeafScaleY;
          let tlz = tlPositions[j + 2] * topLeafScaleZ;

          const tllen = Math.sqrt(tlx * tlx + tly * tly + tlz * tlz);
          if (tllen > 0.001) {
            const bump = fbm3D(tlx * 5 + tSeed, tly * 5, tlz * 5, 2) * 0.1;
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

      // 꼭대기 위치
      const topTheta = (noise3D(0, tSeed * 3, 0) + 0.5) * Math.PI * 2;
      const topDist = Math.abs(noise3D(tSeed * 4, 0, 0)) * 0.15;
      const topBendX = trunkBendX * 1.0;
      const topBendZ = trunkBendZ * 1.0;
      topLeaf.position.x = topBendX + Math.cos(topTheta) * topDist;
      topLeaf.position.z = topBendZ + Math.sin(topTheta) * topDist;
      topLeaf.position.y = trunkHeight + topLeafSize * 0.3 + i * 0.05;
      setMeshVertexColor(topLeaf, 0.3, 0.7, 0.22);  // Brighter green for top leaf

      meshes.push(topLeaf);
    }

    const merged = Mesh.MergeMeshes(meshes, true, true, undefined, false, true);
    if (merged) {
      merged.name = "tree_" + seed;
      merged.scaling.setAll(this.params.size);
      return merged;
    }

    return new Mesh("tree_" + seed, this.scene);
  }

  /**
   * 덤불 생성 - 땅에 붙어서 옆으로 퍼지는 형태
   *
   * - 가지들이 다양한 방향으로 뻗어나감
   * - 두께와 길이의 다양성
   * - 위로 뜨지 않고 땅에 밀착
   */
  private generateBush(): Mesh {
    const seed = this.params.seed;
    const meshes: Mesh[] = [];
    const bushSubdivisions = calcSubdivision(this.params.size, 3);

    // === 전체 형태 파라미터 ===
    const overallSpread = 0.25 + Math.abs(noise3D(0, seed, 0)) * 0.35;        // 0.25 ~ 0.6 퍼짐 반경
    const branchCount = 6 + Math.floor(Math.abs(noise3D(seed * 4, seed, 0)) * 6);  // 6~12개 가지

    for (let i = 0; i < branchCount; i++) {
      const iSeed = seed + i * 97.3;

      // === 가지 파라미터 ===
      const branchLength = 0.08 + Math.abs(noise3D(iSeed, 0, 0)) * 0.12;      // 0.08 ~ 0.2 길이
      const branchThickness = 0.04 + Math.abs(noise3D(0, iSeed, 0)) * 0.06;   // 0.04 ~ 0.1 두께
      const branchFlatness = 0.4 + Math.abs(noise3D(0, 0, iSeed)) * 0.5;      // 0.4 ~ 0.9 납작함

      // 뻗어가는 방향 (주로 옆으로, 약간 위로)
      const theta = (noise3D(0, iSeed * 2, 0) + 0.5) * Math.PI * 2;           // 수평 방향
      const elevationAngle = Math.abs(noise3D(iSeed * 2.5, 0, 0)) * 0.4;      // 0 ~ 0.4 rad (0~23도, 낮게)

      const sphere = MeshBuilder.CreateIcoSphere(
        "bush_" + i,
        { radius: branchLength, subdivisions: bushSubdivisions, updatable: true },
        this.scene
      );

      // 가지 변형 적용
      const positions = sphere.getVerticesData(VertexBuffer.PositionKind);
      if (positions) {
        const newPositions = new Float32Array(positions.length);

        for (let j = 0; j < positions.length; j += 3) {
          let x = positions[j];
          let y = positions[j + 1];
          let z = positions[j + 2];

          // 뻗어가는 방향으로 늘리기
          const dirX = Math.cos(theta) * Math.cos(elevationAngle);
          const dirY = Math.sin(elevationAngle);
          const dirZ = Math.sin(theta) * Math.cos(elevationAngle);

          // 방향 기준 변형 (해당 방향으로 길게)
          const dot = (x * dirX + y * dirY + z * dirZ) / branchLength;
          const stretch = 1.0 + Math.max(0, dot) * 1.5;  // 뻗어가는 방향으로 늘림

          // 두께 적용 (수직 방향은 납작하게)
          x *= branchThickness / branchLength * stretch;
          y *= branchThickness / branchLength * branchFlatness * stretch;
          z *= branchThickness / branchLength * stretch;

          // 뻗어가는 방향으로 이동
          x += dirX * branchLength * 0.5;
          y += dirY * branchLength * 0.3;
          z += dirZ * branchLength * 0.5;

          // 표면 울퉁불퉁
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

      // 배치: 중심 근처에서 시작, 땅에 붙임
      const radialDist = Math.abs(noise3D(iSeed * 3, 0, 0)) * overallSpread * 0.3;
      const posTheta = (noise3D(iSeed * 3.5, 0, 0) + 0.5) * Math.PI * 2;
      sphere.position.x = Math.cos(posTheta) * radialDist;
      sphere.position.z = Math.sin(posTheta) * radialDist;
      sphere.position.y = branchThickness * 0.3;  // 땅에 붙임

      meshes.push(sphere);
    }

    const merged = Mesh.MergeMeshes(meshes, true, true, undefined, false, true);
    if (merged) {
      merged.name = "bush_" + seed;
      merged.scaling.setAll(this.params.size);
      return merged;
    }

    return new Mesh("bush_" + seed, this.scene);
  }

  /**
   * 잔디 뭉치 생성 - 다양성 강화:
   * - 높낮이: 짧은 잔디 ~ 긴 잔디
   * - 두께: 가는 잎 ~ 두꺼운 잎
   * - 분포 밀도: 밀집 ~ 퍼짐
   * - 휘어짐: 직선 ~ 강하게 휘어짐
   * - 기울기: 다양한 방향
   */
  private generateGrassClump(): Mesh {
    const seed = this.params.seed;
    const blades: Mesh[] = [];

    // === 전체 뭉치 파라미터 ===
    const clumpDensity = 0.3 + Math.abs(noise3D(seed * 0.5, 0, 0)) * 0.7;           // 0.3 ~ 1.0 밀도
    const clumpSpread = 0.04 + Math.abs(noise3D(0, seed * 0.5, 0)) * 0.16;          // 0.04 ~ 0.2 퍼짐 반경
    const avgHeight = 0.2 + Math.abs(noise3D(0, 0, seed * 0.5)) * 0.5;              // 0.2 ~ 0.7 평균 높이
    const avgWidth = 0.012 + Math.abs(noise3D(seed * 0.6, seed * 0.3, 0)) * 0.028;  // 0.012 ~ 0.04 평균 두께

    // 잎 개수 (밀도 기반)
    const bladeCount = Math.floor(4 + clumpDensity * 12);                            // 4 ~ 16개

    for (let i = 0; i < bladeCount; i++) {
      const iSeed = seed + i * 73.7;

      // === 개별 잎 파라미터 (뭉치 평균 기준 변동) ===
      const heightVar = 0.6 + Math.abs(noise3D(iSeed, 0, 0)) * 0.8;                 // 0.6 ~ 1.4 배율
      const widthVar = 0.7 + Math.abs(noise3D(0, iSeed, 0)) * 0.6;                  // 0.7 ~ 1.3 배율
      const bladeHeight = avgHeight * heightVar;                                     // 실제 높이
      const bladeWidth = avgWidth * widthVar;                                        // 실제 두께

      // 휘어짐 (높이에 비례 + 랜덤)
      const curveBase = 0.02 + Math.abs(noise3D(0, 0, iSeed)) * 0.12;               // 0.02 ~ 0.14
      const bladeCurve = curveBase * (bladeHeight / 0.4);                            // 높이에 비례

      // 곡선 잎 생성 (4단계 높이)
      const h1 = bladeHeight * 0.35;
      const h2 = bladeHeight * 0.65;
      const h3 = bladeHeight * 0.9;
      const h4 = bladeHeight;

      const c1 = bladeCurve * 0.25;
      const c2 = bladeCurve * 0.6;
      const c3 = bladeCurve * 0.9;
      const c4 = bladeCurve;

      // 두께 테이퍼 (위로 갈수록 가늘어짐)
      const taperRate = 0.6 + Math.abs(noise3D(iSeed * 1.5, 0, 0)) * 0.35;          // 0.6 ~ 0.95

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

      // 법선 계산
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

      // 배치 (밀도에 따른 분포)
      const angle = (noise3D(iSeed * 2, 0, 0) + 0.5) * Math.PI * 2;
      const distFactor = Math.pow(Math.abs(noise3D(0, iSeed * 2, 0)), 1.0 / clumpDensity);  // 밀도 높으면 중심에 몰림
      const dist = distFactor * clumpSpread;

      blade.position.x = Math.cos(angle) * dist;
      blade.position.z = Math.sin(angle) * dist;

      // 회전과 기울기 (살짝만 기울어짐)
      blade.rotation.y = (noise3D(iSeed, iSeed, 0) + 0.5) * Math.PI * 2;
      blade.rotation.x = noise3D(iSeed * 3, 0, 0) * 0.12;                            // -0.12 ~ 0.12 rad (~±7°)
      blade.rotation.z = noise3D(0, iSeed * 3, 0) * 0.1;                             // -0.1 ~ 0.1 rad (~±6°)

      blades.push(blade);
    }

    // Set bright green vertex color for each blade before merging
    for (const blade of blades) {
      setMeshVertexColor(blade, 0.45, 0.75, 0.3);  // Bright grass green
    }

    const merged = Mesh.MergeMeshes(blades, true, true, undefined, false, true);
    if (merged) {
      merged.name = "grass_" + seed;
      merged.scaling.setAll(this.params.size);
      return merged;
    }

    const fallback = new Mesh("grass_" + seed, this.scene);
    return fallback;
  }

  private createMaterial(): void {
    // Determine if this asset needs wind animation
    const needsWind = this.params.type === "grass_clump" ||
                      this.params.type === "bush" ||
                      this.params.type === "tree";

    if (needsWind) {
      this.material = new ShaderMaterial(
        "foliageMaterial_" + this.params.seed,
        this.scene,
        {
          vertex: "foliageWind",
          fragment: "foliageWind",
        },
        {
          attributes: ["position", "normal", "uv", "color"],
          uniforms: [
            "worldViewProjection",
            "world",
            "cameraPosition",
            "uTime",
            "uWindDirection",
            "uWindStrength",
            "uMinWindHeight",
            "uMaxWindHeight",
            "baseColor",
            "detailColor",
            "sunDirection",
            "ambientIntensity",
            "fogColor",
            "fogDensity",
          ],
        }
      );

      // Wind settings
      const windAngle = Math.PI * 0.25;  // 45 degrees
      this.material.setVector2("uWindDirection", new Vector2(
        Math.cos(windAngle),
        Math.sin(windAngle)
      ));

      // Wind settings vary by type
      let windStrength = 0.5;
      let minWindHeight = 0.0;
      let maxWindHeight = 0.8;

      if (this.params.type === "grass_clump") {
        windStrength = 0.8;   // Grass sways more
        minWindHeight = 0.0;  // Wind starts at ground
        maxWindHeight = 0.7;  // Full effect at tip
      } else if (this.params.type === "bush") {
        windStrength = 0.4;   // Bush sways moderately
        minWindHeight = 0.0;  // Wind starts at ground
        maxWindHeight = 0.3;  // Bush is low, full effect at top
      } else if (this.params.type === "tree") {
        windStrength = 0.35;  // Tree leaves sway gently
        minWindHeight = 0.5;  // Wind only affects parts above trunk base
        maxWindHeight = 2.0;  // Leaves are at various heights
      }

      this.material.setFloat("uWindStrength", windStrength);
      this.material.setFloat("uMinWindHeight", minWindHeight);
      this.material.setFloat("uMaxWindHeight", maxWindHeight);
      this.material.setFloat("uTime", 0);

    } else {
      // Rock uses the static shader
      this.material = new ShaderMaterial(
        "assetMaterial_" + this.params.seed,
        this.scene,
        {
          vertex: "proceduralAsset",
          fragment: "proceduralAsset",
        },
        {
          attributes: ["position", "normal", "uv"],
          uniforms: [
            "worldViewProjection",
            "world",
            "cameraPosition",
            "baseColor",
            "detailColor",
            "sunDirection",
            "ambientIntensity",
            "fogColor",
            "fogDensity",
          ],
        }
      );
    }

    // Common uniforms
    this.material.setColor3("baseColor", this.params.colorBase);
    this.material.setColor3("detailColor", this.params.colorDetail);
    this.material.setVector3("sunDirection", new Vector3(0.5, 0.8, 0.3).normalize());
    this.material.setFloat("ambientIntensity", 0.4);
    this.material.setColor3("fogColor", new Color3(0.6, 0.75, 0.9));
    this.material.setFloat("fogDensity", 0.008);

    this.material.backFaceCulling = false;

    // Update camera position and time on each render
    const startTime = performance.now();
    this.material.onBindObservable.add(() => {
      const camera = this.scene.activeCamera;
      if (camera && this.material) {
        this.material.setVector3("cameraPosition", camera.position);

        // Update time for wind animation
        if (needsWind) {
          const elapsed = (performance.now() - startTime) / 1000;  // seconds
          this.material.setFloat("uTime", elapsed);
        }
      }
    });
  }

  getMesh(): Mesh | null {
    return this.mesh;
  }

  getParams(): AssetParams {
    return { ...this.params };
  }

  updateParams(params: Partial<AssetParams>): void {
    this.params = { ...this.params, ...params };
  }

  randomizeSeed(): void {
    this.params.seed = Math.random() * 10000;
  }

  dispose(): void {
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
    if (this.mesh) {
      this.mesh.dispose();
      this.mesh = null;
    }
  }
}
