import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { disposeMesh } from "../../shared/rendering/threeHelpers";
import { Heightmap } from "../terrain/Heightmap";
import { SplatMap } from "../terrain/SplatMap";
import { DataCodec } from "../../loader";
import { loadTextureWithFallbackSync } from "../../shared/rendering/TextureLoader.three";
import { DEFAULT_FOLIAGE_QUALITY_PROFILE } from "../../shared/foliage/FoliageQualityProfile";
import { fbm3D, noise3D } from "../../shared/math/NoiseUtils";

// Helper to set vertex colors on a geometry
function setGeometryVertexColor(geometry: THREE.BufferGeometry, r: number, g: number, b: number): void {
  const positions = geometry.getAttribute("position");
  if (!positions) return;

  const vertexCount = positions.count;
  const colors = new Float32Array(vertexCount * 4);

  for (let i = 0; i < vertexCount; i++) {
    colors[i * 4] = r;
    colors[i * 4 + 1] = g;
    colors[i * 4 + 2] = b;
    colors[i * 4 + 3] = 1.0;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
}

// Compute normals from positions and indices (equivalent to VertexData.ComputeNormals)
function computeNormals(positions: ArrayLike<number>, indices: ArrayLike<number>, normals: number[] | Float32Array): void {
  for (let i = 0; i < normals.length; i++) normals[i] = 0;

  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const faceNormal = new THREE.Vector3();

  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i];
    const i1 = indices[i + 1];
    const i2 = indices[i + 2];

    v1.set(positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]);
    v2.set(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
    v3.set(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);

    edge1.subVectors(v2, v1);
    edge2.subVectors(v3, v1);
    faceNormal.crossVectors(edge1, edge2);

    for (const idx of [i0, i1, i2]) {
      normals[idx * 3] += faceNormal.x;
      normals[idx * 3 + 1] += faceNormal.y;
      normals[idx * 3 + 2] += faceNormal.z;
    }
  }

  // Normalize
  const n = new THREE.Vector3();
  for (let i = 0; i < normals.length; i += 3) {
    n.set(normals[i], normals[i + 1], normals[i + 2]).normalize();
    normals[i] = n.x;
    normals[i + 1] = n.y;
    normals[i + 2] = n.z;
  }
}

// Foliage type configuration
interface FoliageTypeConfig {
  name: string;
  baseDensity: number;      // instances per unit area
  minScale: number;
  maxScale: number;
  biomeChannel: number;     // 0=grass, 1=dirt, 2=rock, 3=sand
  biomeThreshold: number;   // minimum weight to spawn
  slopeMax: number;         // maximum slope (0-1) to spawn
  yOffset: number;          // vertical offset from terrain
  color: THREE.Color;
  colorVariation: number;
}

// LOD level for density control
export enum FoliageLOD {
  Near = 0,     // 100% density (3D meshes)
  Mid = 1,      // 50% density (3D meshes)
  Impostor = 2, // Billboard impostors (far distance)
  Far = 3,      // Unloaded
}

// Chunk for spatial organization
interface FoliageChunk {
  x: number;
  z: number;
  instances: Map<string, Float32Array>;  // type -> matrix buffer (full density)
  mesh: Map<string, THREE.InstancedMesh>;  // type -> instanced mesh
  impostorMesh: THREE.InstancedMesh | null;  // Impostor billboard mesh for this chunk
  visible: boolean;
  currentLOD: FoliageLOD;                // Current LOD level for density
}

// ============================================
// Shader source strings (module-level consts)
// ============================================

const grassVertexShader = `
precision highp float;

// Three.js auto-injects: position, normal, uv
// We need color as explicit attribute
attribute vec4 color;

// Three.js InstancedMesh auto-injects instanceMatrix
uniform float uTime;
uniform float uWindStrength;
uniform float uWindScale;
uniform float uWindSecondaryStrength;
uniform float uWindMacroSpeed;
uniform float uWindMicroSpeed;
uniform float uBladeThickness;
uniform vec2 uWindDirection;
// cameraPosition is auto-injected by Three.js
uniform float uLodFar;
uniform float uVariationStrength;

// Grass color uniforms (matching original infinite-terrain)
uniform vec3 uGrassBaseColor;
uniform vec3 uGrassTopColor;

// Wind noise texture (pre-computed fbm for performance)
uniform sampler2D uWindTexture;
uniform float uWindTextureScale;  // terrain scale for UV mapping

// Grass blade constants (matching original infinite-terrain)
#define GRASS_SEGMENTS 4
#define GRASS_VERTICES 10
#define GRASS_WIDTH 0.15
#define GRASS_HEIGHT 1.15

varying vec3 vNormal;
varying vec3 vColor;
varying float vHeight;
varying vec3 vWorldPosition;
varying float vVariation;
varying float vGrassX;
varying float vHeightPercent;

// EaseOut function for blade width tapering (isosceles triangle shape)
float easeOut(float x, float t) {
    float clamped = clamp(1.0 - x, 0.0, 1.0);
    return 1.0 - pow(clamped, t);
}

float hash2D(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
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

// Bezier curve functions for natural blade bending
vec3 bezier(vec3 P0, vec3 P1, vec3 P2, vec3 P3, float t) {
    float mt = 1.0 - t;
    return mt*mt*mt*P0 + 3.0*mt*mt*t*P1 + 3.0*mt*t*t*P2 + t*t*t*P3;
}

vec3 bezierGrad(vec3 P0, vec3 P1, vec3 P2, vec3 P3, float t) {
    float mt = 1.0 - t;
    return 3.0*mt*mt*(P1-P0) + 6.0*mt*t*(P2-P1) + 3.0*t*t*(P3-P2);
}

// Rotation matrix around Y axis
mat3 rotateY(float theta) {
    float c = cos(theta);
    float s = sin(theta);
    return mat3(vec3(c, 0, s), vec3(0, 1, 0), vec3(-s, 0, c));
}

// Rotation matrix around arbitrary axis
mat3 rotateAxis(vec3 axis, float angle) {
    float s = sin(angle);
    float c = cos(angle);
    float oc = 1.0 - c;
    return mat3(
        oc*axis.x*axis.x+c,         oc*axis.x*axis.y-axis.z*s, oc*axis.z*axis.x+axis.y*s,
        oc*axis.x*axis.y+axis.z*s,  oc*axis.y*axis.y+c,        oc*axis.y*axis.z-axis.x*s,
        oc*axis.z*axis.x-axis.y*s,  oc*axis.y*axis.z+axis.x*s, oc*axis.z*axis.z+c
    );
}

void main() {
    mat4 worldMatrix = instanceMatrix;
    // worldPos is the blade base position (from instance matrix position)
    vec4 worldPos = worldMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec3 grassBase = worldPos.xyz;

    // Blade geometry from pre-calculated position (WebGPU compatible)
    // position.x: -halfWidth to +halfWidth, position.y: 0 to bladeHeight
    float heightPercent = position.y / GRASS_HEIGHT;
    float xSide = step(0.0, position.x);  // 0 = left, 1 = right
    float zSide = -1.0;  // front face only (backFaceCulling = false)

    // Camera height extends LOD distance (higher view = see further)
    float cameraHeight = max(0.0, cameraPosition.y - 10.0);
    float heightBonus = cameraHeight * 1.5;
    float effectiveLodFar = uLodFar + heightBonus;

    // Distance for wind attenuation (no size scaling - perspective handles it naturally)
    float distanceToCamera = length(grassBase.xz - cameraPosition.xz);
    float distanceRatio = distanceToCamera / effectiveLodFar;
    float lodScale = 1.0;
    float variation = (hash2D(grassBase.xz * 0.12) - 0.5) * uVariationStrength;

    // Per-blade random height variation
    float randomHeight = (hash2D(grassBase.xz * 0.19) * 2.0 - 1.0) * 0.2;

    // Blade dimensions
    float grassHeight = 1.0;
    float bladeWidth = GRASS_WIDTH * easeOut(1.08 - heightPercent, 2.0) * grassHeight;
    float bladeHeight = GRASS_HEIGHT * grassHeight + randomHeight;

    // Local x position - use pre-calculated position.x (already has easeOut taper)
    float x = position.x;

    // Wind attenuation: synced with grass LOD visibility
    float windScaleAtten = 1.0 - smoothstep(0.6, 0.9, distanceRatio);
    float heightWindAtten = 1.0 / (1.0 + cameraHeight * 0.03);
    vec2 windDir = normalize(uWindDirection);

    // Texture-based wind (infinite-terrain style) - single sample, slow scroll
    vec2 windUV = grassBase.xz * 0.035 + windDir * uTime * 0.1;
    float windNoise = texture2D(uWindTexture, windUV).r * 2.0 - 1.0;
    // Secondary flutter (higher frequency, very subtle)
    vec2 flutterUV = grassBase.xz * 0.08 + windDir * uTime * 0.15;
    float flutter = texture2D(uWindTexture, flutterUV).r * 0.15;
    float combinedWind = windNoise + flutter;

    // Base lean factor (random per blade, range +/-0.2 like original)
    float baseLean = (hash2D(grassBase.xz * 0.31) - 0.5) * 0.4;

    // Wind animation
    float windStrengthNorm = combinedWind * uWindStrength * windScaleAtten * heightWindAtten;
    float leanAnimation = windStrengthNorm * 0.5;
    float leanFactor = baseLean + leanAnimation;

    // Random rotation angle for each blade (range -PI/4 to PI/4)
    float angle = (hash2D(grassBase.xz * 0.23) - 0.5) * 1.5708;

    // Wind axis and lean angle
    float windAngle = 0.6;
    vec3 windAxis = vec3(cos(windAngle), 0.0, sin(windAngle));
    float windLeanAngle = windStrengthNorm * heightPercent;

    // Bezier control points with cos/sin curve for natural drooping
    vec3 p0 = vec3(0.0, 0.0, 0.0);
    vec3 p1 = vec3(0.0, 0.33, 0.0);
    vec3 p2 = vec3(0.0, 0.66, 0.0);
    vec3 p3 = vec3(0.0, cos(leanFactor), sin(leanFactor));

    // Sample bezier curve
    vec3 curvePoint = bezier(p0, p1, p2, p3, heightPercent);
    vec3 curveGrad = bezierGrad(p0, p1, p2, p3, heightPercent);

    // y and z from bezier curve
    float y = curvePoint.y * bladeHeight;
    float z = curvePoint.z * bladeHeight;

    // Apply rotation matrices: wind lean + random Y rotation
    mat3 grassMat = rotateAxis(windAxis, windLeanAngle) * rotateY(angle);
    vec3 grassLocalPosition = grassMat * vec3(x, y, z);

    // Normal from bezier gradient (rotate 90 degrees in YZ plane)
    mat2 curveRot90 = mat2(0.0, 1.0, -1.0, 0.0) * -zSide;
    vec3 grassLocalNormal = grassMat * vec3(0.0, curveRot90 * curveGrad.yz);

    // Final world position
    vec3 finalPos = grassBase + grassLocalPosition * lodScale;

    // View-space thickening for grazing angles
    vec3 viewDir = normalize(cameraPosition - grassBase);
    vec3 grassFaceNormal = grassMat * vec3(0.0, 0.0, -zSide);
    float viewDotNormal = clamp(dot(grassFaceNormal, viewDir), 0.0, 1.0);
    float viewSpaceThickenFactor = easeOut(1.0 - viewDotNormal, 4.0) * smoothstep(0.0, 0.2, viewDotNormal);

    vec3 viewRight = cross(vec3(0.0, 1.0, 0.0), viewDir);
    if (length(viewRight) < 0.0001) {
        viewRight = vec3(1.0, 0.0, 0.0);
    } else {
        viewRight = normalize(viewRight);
    }
    finalPos += viewRight * viewSpaceThickenFactor * (xSide - 0.5) * bladeWidth * 0.5 * -zSide * lodScale;

    vWorldPosition = finalPos;
    vHeight = heightPercent * bladeHeight * lodScale * (1.0 + variation * 0.15);
    vVariation = variation;

    gl_Position = projectionMatrix * viewMatrix * vec4(finalPos, 1.0);

    // Distance normal blend: fade curve normal to up vector at distance
    float distanceBlend = smoothstep(0.0, 10.0, distanceToCamera);
    vec3 blendedNormal = mix(grassLocalNormal, vec3(0.0, 1.0, 0.0), distanceBlend * 0.5);
    vNormal = normalize(blendedNormal);

    // Color gradient from base to top (matching original infinite-terrain)
    vColor = mix(uGrassBaseColor, uGrassTopColor, heightPercent);
    vGrassX = x;
    vHeightPercent = heightPercent;
}
`;

const grassFragmentShader = `
precision highp float;

varying vec3 vNormal;
varying vec3 vColor;
varying float vHeight;
varying vec3 vWorldPosition;
varying float vVariation;
varying float vGrassX;
varying float vHeightPercent;

uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uAmbient;
// cameraPosition is auto-injected by Three.js

// Fog uniforms
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFadeStart;
uniform float uFadeEnd;
uniform float uDitherPixelSize;
uniform int uDitherMode;

// Noise functions (matching propThinWindFragmentShader)
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

// Hemisphere lighting: blend between ground and sky color based on normal Y
vec3 hemiLight(vec3 normal, vec3 groundColor, vec3 skyColor) {
    return mix(groundColor, skyColor, 0.5 * normal.y + 0.5);
}

float hash2D(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float getDiamondThreshold(vec2 fragCoord, float pixelSize) {
    vec2 uv = mod(fragCoord + 0.01, pixelSize);
    vec2 centered = (uv / pixelSize) * 2.0 - 1.0;
    float dist = abs(centered.x) + abs(centered.y);
    return clamp(dist * 0.5, 0.0, 1.0);
}

float getBayer4Threshold(vec2 fragCoord, float pixelSize) {
    vec2 pixelCoord = floor(fragCoord / max(pixelSize, 1.0));
    float x = mod(pixelCoord.x, 4.0);
    float y = mod(pixelCoord.y, 4.0);

    float idx = 0.0;
    if (y < 0.5) {
        if (x < 0.5) idx = 0.0;
        else if (x < 1.5) idx = 8.0;
        else if (x < 2.5) idx = 2.0;
        else idx = 10.0;
    } else if (y < 1.5) {
        if (x < 0.5) idx = 12.0;
        else if (x < 1.5) idx = 4.0;
        else if (x < 2.5) idx = 14.0;
        else idx = 6.0;
    } else if (y < 2.5) {
        if (x < 0.5) idx = 3.0;
        else if (x < 1.5) idx = 11.0;
        else if (x < 2.5) idx = 1.0;
        else idx = 9.0;
    } else {
        if (x < 0.5) idx = 15.0;
        else if (x < 1.5) idx = 7.0;
        else if (x < 2.5) idx = 13.0;
        else idx = 5.0;
    }

    return (idx + 0.5) / 16.0;
}

float sampleDitherThreshold(vec2 fragCoord) {
    if (uDitherMode == 0) {
        return getDiamondThreshold(fragCoord, max(uDitherPixelSize, 1.0));
    }
    if (uDitherMode == 1) {
        return getBayer4Threshold(fragCoord, max(uDitherPixelSize, 1.0));
    }
    return hash2D(fragCoord + vWorldPosition.xz * 2.7);
}

void main() {
    vec3 normal = normalize(vNormal);
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);

    // Hemisphere ambient lighting
    vec3 skyColor = vec3(1.0, 1.0, 0.75);
    vec3 groundColor = vec3(0.05, 0.05, 0.25);
    vec3 ambientLighting = hemiLight(normal, groundColor, skyColor);

    // Directional light (wrapped Lambert with backlight scatter)
    vec3 lightDir = normalize(vec3(1.0, 0.5, 1.0));
    float wrap = 0.5;
    float dotNL = clamp((dot(normal, lightDir) + wrap) / (1.0 + wrap), 0.0, 1.0);
    float backlight = clamp((dot(viewDir, -lightDir) + wrap) / (1.0 + wrap), 0.0, 1.0);
    vec3 scatter = vec3(pow(backlight, 2.0));
    vec3 diffuseLighting = (vec3(dotNL) + scatter) * vec3(1.0);

    // Final lighting mix (matching original: 20% diffuse, 80% ambient)
    vec3 lighting = diffuseLighting * 0.2 + ambientLighting * 0.8;

    // Apply lighting to grass color (matching original infinite-terrain)
    vec3 color = vColor * lighting;

    float distanceToCamera = length(vWorldPosition - cameraPosition);
    float fadeAlpha = 1.0 - smoothstep(uFadeStart, uFadeEnd, distanceToCamera);
    float dither = sampleDitherThreshold(gl_FragCoord.xy);
    if (dither > clamp(fadeAlpha, 0.0, 1.0)) discard;

    // Fog (simple distance fog)
    float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * distanceToCamera * distanceToCamera);
    color = mix(color, uFogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

const rockVertexShader = `
precision highp float;

// Three.js InstancedMesh auto-injects instanceMatrix, position, normal

void main() {
    mat4 worldMatrix = instanceMatrix;
    vec4 worldPos = worldMatrix * vec4(position, 1.0);

    vWorldPosition = worldPos.xyz;
    vNormal = normalize(mat3(worldMatrix) * normal);

    gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const rockFragmentShader = `
precision highp float;

varying vec3 vNormal;
varying vec3 vWorldPosition;

// cameraPosition is auto-injected by Three.js
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uAmbient;
uniform vec3 uDiffuseColor;
uniform vec3 uSpecularColor;
uniform sampler2D rockTexture;
uniform float textureScale;

// Fog uniforms (matching terrain/grass)
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogHeightFalloff;
uniform float uFogHeightDensity;

void main() {
    vec3 normal = normalize(vNormal);

    // Triplanar texture sampling (world-space projection)
    vec3 blending = abs(normal);
    blending = blending / (blending.x + blending.y + blending.z);

    vec3 texX = texture2D(rockTexture, vWorldPosition.yz * textureScale).rgb;
    vec3 texY = texture2D(rockTexture, vWorldPosition.xz * textureScale).rgb;
    vec3 texZ = texture2D(rockTexture, vWorldPosition.xy * textureScale).rgb;
    vec3 texColor = texX * blending.x + texY * blending.y + texZ * blending.z;

    // Blend texture with diffuse color (70% texture, 30% base)
    vec3 albedo = mix(uDiffuseColor, texColor, 0.7);

    // Diffuse lighting
    float NdotL = max(dot(normal, uSunDirection), 0.0);
    float diffuse = NdotL * 0.6 + 0.4;

    // Specular (subtle)
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    vec3 halfVec = normalize(uSunDirection + viewDir);
    float specular = pow(max(dot(normal, halfVec), 0.0), 32.0) * 0.15;

    vec3 color = albedo * (uAmbient + diffuse * uSunColor);
    color += uSpecularColor * specular * uSunColor;

    // ========== Fog System (matching terrain) ==========
    float distanceToCamera = length(vWorldPosition - cameraPosition);

    // Distance fog (exponential squared)
    float distanceFog = 1.0 - exp(-uFogDensity * uFogDensity * distanceToCamera * distanceToCamera);

    // Height fog (distance-dependent, max 15%)
    float heightFactor = exp(-max(0.0, vWorldPosition.y - uFogHeightFalloff) * uFogHeightDensity);
    float heightFog = heightFactor * 0.15 * smoothstep(0.0, 30.0, distanceToCamera);

    // Final fog factor
    float fogFactor = clamp(distanceFog + heightFog, 0.0, 1.0);

    // Apply fog
    color = mix(color, uFogColor, fogFactor);

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

// Rock vertex shader needs varyings declared at top level
const rockVertexShaderFull = `
precision highp float;

varying vec3 vNormal;
varying vec3 vWorldPosition;

void main() {
    mat4 worldMatrix = instanceMatrix;
    vec4 worldPos = worldMatrix * vec4(position, 1.0);

    vWorldPosition = worldPos.xyz;
    vNormal = normalize(mat3(worldMatrix) * normal);

    gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

// Impostor billboard shader (camera-facing quads)
const impostorVertexShader = `
precision highp float;

// Three.js InstancedMesh auto-injects instanceMatrix, position, uv
// cameraPosition is auto-injected by Three.js

varying vec2 vUV;
varying vec3 vWorldPosition;
varying float vScale;

void main() {
    // Extract position and scale from instance matrix
    vec3 instancePos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
    float scaleX = length(vec3(instanceMatrix[0][0], instanceMatrix[0][1], instanceMatrix[0][2]));
    float scaleY = length(vec3(instanceMatrix[1][0], instanceMatrix[1][1], instanceMatrix[1][2]));
    vScale = max(scaleX, scaleY);

    // Billboard: rotate to face camera (Y-axis only for stability)
    vec3 toCamera = cameraPosition - instancePos;
    toCamera.y = 0.0;
    float len = length(toCamera);
    if (len > 0.01) {
        toCamera /= len;
    } else {
        toCamera = vec3(0.0, 0.0, 1.0);
    }
    vec3 right = vec3(toCamera.z, 0.0, -toCamera.x);
    vec3 up = vec3(0.0, 1.0, 0.0);

    // Apply billboard transform (scale position by instance scale)
    vec3 billboardPos = instancePos
        + right * position.x * scaleX
        + up * position.y * scaleY;

    vWorldPosition = billboardPos;
    vUV = uv;

    gl_Position = projectionMatrix * viewMatrix * vec4(billboardPos, 1.0);
}
`;

const impostorFragmentShader = `
precision highp float;

uniform vec3 uBaseColor;
// cameraPosition is auto-injected by Three.js
uniform vec3 uFogColor;
uniform float uFogDensity;

varying vec2 vUV;
varying vec3 vWorldPosition;
varying float vScale;

void main() {
    // Circular billboard with soft edges
    vec2 centered = vUV - 0.5;
    float dist = length(centered);
    float alpha = 1.0 - smoothstep(0.3, 0.5, dist);
    if (alpha < 0.01) discard;

    // Simple shading (lighter at top)
    float heightGradient = vUV.y * 0.2 + 0.9;
    vec3 color = uBaseColor * heightGradient;

    // Fog
    float distanceToCamera = length(vWorldPosition - cameraPosition);
    float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * distanceToCamera * distanceToCamera);
    color = mix(color, uFogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(color, alpha * 0.8);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

export class FoliageSystem {
  private scene: THREE.Scene;
  private heightmap: Heightmap;
  private splatMap: SplatMap;
  private terrainScale: number;

  // Chunk management
  private chunkSize = 16;  // 16x16 world units per chunk
  private chunks: Map<string, FoliageChunk> = new Map();

  // Cell management for streaming (cells contain multiple chunks)
  private cellSize = 64;  // 64x64 world units per cell (matches StreamingManager)
  private loadedCells: Set<string> = new Set();  // Track which cells are loaded

  // Base geometries for instanced meshes
  private baseGeometries: Map<string, THREE.BufferGeometry> = new Map();

  // Rock mesh variations
  private rockVariationGeometries: THREE.BufferGeometry[] = [];
  private readonly ROCK_VARIATION_COUNT = 4;

  // Grass mesh variations
  private grassVariationGeometries: THREE.BufferGeometry[] = [];
  private readonly GRASS_VARIATION_COUNT = 4;

  // Foliage type configurations
  private foliageTypes: Map<string, FoliageTypeConfig> = new Map();

  // Materials
  private grassMaterial: THREE.ShaderMaterial | null = null;
  private rockMaterial: THREE.ShaderMaterial | null = null;
  private impostorGrassMaterial: THREE.ShaderMaterial | null = null;
  private impostorRockMaterial: THREE.ShaderMaterial | null = null;

  // Impostor base geometry (simple quad billboard)
  private impostorBaseGeometry: THREE.BufferGeometry | null = null;

  // Wind noise texture for GPU-efficient wind animation
  private windNoiseTexture: THREE.DataTexture | null = null;
  private readonly WIND_TEXTURE_SIZE = 256;

  // Frustum culling for performance optimization
  private frustum = new THREE.Frustum();
  private frustumMatrix = new THREE.Matrix4();
  private camera: THREE.Camera | null = null;
  private lastFrustumUpdateFrame = -1;
  private frameCounter = 0;

  // Performance settings
  private maxInstancesPerChunk = 5000;
  private lodDistances = {
    near: 100,   // full density
    mid: 200,    // 50% density
    far: 450,    // fade out distance
  };

  // Reusable objects for matrix generation (avoid GC pressure)
  private readonly _tempScale = new THREE.Vector3();
  private readonly _tempPosition = new THREE.Vector3();
  private readonly _tempQuaternion = new THREE.Quaternion();
  private readonly _tempMatrix = new THREE.Matrix4();
  private readonly _tempRotMatrixY = new THREE.Matrix4();
  private readonly _tempRotMatrixX = new THREE.Matrix4();
  private readonly _tempRotMatrixZ = new THREE.Matrix4();
  private readonly _tempRotMatrix = new THREE.Matrix4();
  private readonly _tempFinalMatrix = new THREE.Matrix4();
  private readonly _tempEuler = new THREE.Euler();
  private readonly _frustumSphere = new THREE.Sphere();

  // Wrapping mode for infinite terrain support (disable in game mode)
  private useWrapping = true;

  // Camera position caching for updateVisibility optimization
  private lastVisibilityCamX = -Infinity;
  private lastVisibilityCamZ = -Infinity;
  private lastVisibilityCamY = -Infinity;
  private readonly VISIBILITY_UPDATE_THRESHOLD = 2.0;

  // Random seed for consistent generation
  private seed: number;

  constructor(
    scene: THREE.Scene,
    heightmap: Heightmap,
    splatMap: SplatMap,
    terrainScale: number
  ) {
    this.scene = scene;
    this.heightmap = heightmap;
    this.splatMap = splatMap;
    this.terrainScale = terrainScale;
    this.seed = 12345;

    this.initializeFoliageTypes();
    this.createBaseGeometries();
    this.createMaterials();
    this.createImpostorSystem();
  }

  /**
   * Set camera for frustum culling (replaces scene.activeCamera)
   */
  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  /**
   * Initialize foliage type configurations
   */
  private initializeFoliageTypes(): void {
    this.foliageTypes.set("grass", {
      name: "grass",
      baseDensity: 8.0,
      minScale: 0.4,
      maxScale: 0.8,
      biomeChannel: 0,
      biomeThreshold: 0.3,
      slopeMax: 0.6,
      yOffset: 0,
      color: new THREE.Color(0.3, 0.5, 0.2),
      colorVariation: 0.15,
    });

    this.foliageTypes.set("pebble", {
      name: "pebble",
      baseDensity: 0.5,
      minScale: 0.1,
      maxScale: 0.25,
      biomeChannel: 1,
      biomeThreshold: 0.4,
      slopeMax: 0.8,
      yOffset: -0.02,
      color: new THREE.Color(0.4, 0.35, 0.3),
      colorVariation: 0.1,
    });

    this.foliageTypes.set("rock", {
      name: "rock",
      baseDensity: 0.15,
      minScale: 0.2,
      maxScale: 0.6,
      biomeChannel: 2,
      biomeThreshold: 0.3,
      slopeMax: 0.9,
      yOffset: -0.05,
      color: new THREE.Color(0.5, 0.5, 0.52),
      colorVariation: 0.08,
    });

    this.foliageTypes.set("sandRock", {
      name: "sandRock",
      baseDensity: 0.05,
      minScale: 0.15,
      maxScale: 0.4,
      biomeChannel: 3,
      biomeThreshold: 0.5,
      slopeMax: 0.7,
      yOffset: -0.03,
      color: new THREE.Color(0.6, 0.55, 0.45),
      colorVariation: 0.1,
    });
  }

  /**
   * Create base geometries for instanced meshes
   */
  private createBaseGeometries(): void {
    // Grass geometry variations
    this.createGrassVariations();

    if (this.grassVariationGeometries.length > 0) {
      this.baseGeometries.set("grass", this.grassVariationGeometries[0]);
    } else {
      const grassGeo = this.createGrassBladeGeometry();
      this.baseGeometries.set("grass", grassGeo);
    }

    // Pebble geometry (small icosphere)
    const pebbleGeo = new THREE.IcosahedronGeometry(0.5, 1);
    this.baseGeometries.set("pebble", pebbleGeo);

    // Rock geometry variations
    this.createRockVariations();

    if (this.rockVariationGeometries.length > 0) {
      this.baseGeometries.set("rock", this.rockVariationGeometries[0]);
      this.baseGeometries.set("sandRock", this.rockVariationGeometries[0]);
    }
  }

  /**
   * Create multiple rock geometry variations
   */
  private createRockVariations(): void {
    console.log("[FoliageSystem] Creating rock variations...");

    for (let i = 0; i < this.ROCK_VARIATION_COUNT; i++) {
      const seed = 1000 + i * 777;
      const geo = this.generateProceduralRockGeometry(seed);
      if (geo) {
        this.rockVariationGeometries.push(geo);
      }
    }

    console.log(`[FoliageSystem] Created ${this.rockVariationGeometries.length} rock variations`);
  }

  /**
   * Generate a procedural rock geometry
   */
  private generateProceduralRockGeometry(seed: number): THREE.BufferGeometry {
    const geo = new THREE.IcosahedronGeometry(0.5, 4);

    // Shape parameters (extracted from seed)
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

    const posAttr = geo.getAttribute("position");
    const positions = posAttr.array as Float32Array;
    const newPositions = new Float32Array(positions.length);

    for (let i = 0; i < positions.length; i += 3) {
      let x = positions[i];
      let y = positions[i + 1];
      let z = positions[i + 2];

      const len = Math.sqrt(x * x + y * y + z * z);
      const nx = x / len;
      const ny = y / len;
      const nz = z / len;

      x *= scaleX;
      y *= scaleY;
      z *= scaleZ;

      const taperFactorY = 1.0 - taperY * ny;
      const taperFactorX = 1.0 - taperX * nx;
      const taperFactorZ = 1.0 - taperZ * nz;
      x *= taperFactorY * taperFactorX;
      z *= taperFactorY * taperFactorZ;

      const twistAngle = twistAmount * ny;
      const cosT = Math.cos(twistAngle);
      const sinT = Math.sin(twistAngle);
      const rx = x * cosT - z * sinT;
      const rz = x * sinT + z * cosT;
      x = rx;
      z = rz;

      x += bendX * y * y;
      z += bendZ * y * y;

      x += asymOffsetX * (1.0 - Math.abs(ny));
      y += asymOffsetY;
      z += asymOffsetZ * (1.0 - Math.abs(ny));

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

    geo.setAttribute("position", new THREE.BufferAttribute(newPositions, 3));
    geo.computeVertexNormals();

    return geo;
  }

  /**
   * Create grass geometry variations with isosceles triangle shape
   */
  private createGrassVariations(): void {
    console.log("[FoliageSystem] Creating grass variations (isosceles triangle shape)...");

    for (let i = 0; i < this.GRASS_VARIATION_COUNT; i++) {
      const seed = 2000 + i * 333;
      const geo = this.generateIsoscelesGrassBladeGeometry(seed);
      if (geo) {
        this.grassVariationGeometries.push(geo);
      }
    }

    console.log(`[FoliageSystem] Created ${this.grassVariationGeometries.length} grass variations`);
  }

  /**
   * Generate a single grass blade geometry with isosceles triangle shape
   */
  private generateIsoscelesGrassBladeGeometry(seed: number): THREE.BufferGeometry {
    const easeOut = (x: number, t: number): number => {
      const clamped = Math.max(0, Math.min(1, 1 - x));
      return 1 - Math.pow(clamped, t);
    };

    const GRASS_WIDTH = 0.15;
    const GRASS_HEIGHT = 1.15;
    const SEGMENTS = 4;

    const heightVar = 0.8 + Math.abs(noise3D(seed, 0, 0)) * 0.4;
    const bladeHeight = GRASS_HEIGHT * heightVar;

    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];

    for (let seg = 0; seg <= SEGMENTS; seg++) {
      const heightPercent = seg / SEGMENTS;
      const y = heightPercent * bladeHeight;

      const widthFactor = easeOut(1.08 - heightPercent, 2.0);
      const halfWidth = (GRASS_WIDTH * widthFactor) / 2;

      if (seg === SEGMENTS) {
        positions.push(0, y, 0);
        normals.push(0, 0, 1);
      } else {
        positions.push(-halfWidth, y, 0);
        normals.push(0, 0, 1);
        positions.push(halfWidth, y, 0);
        normals.push(0, 0, 1);
      }
    }

    for (let seg = 0; seg < SEGMENTS; seg++) {
      const vi = seg * 2;
      if (seg === SEGMENTS - 1) {
        const tipIndex = SEGMENTS * 2;
        indices.push(vi, vi + 1, tipIndex);
      } else {
        indices.push(vi, vi + 1, vi + 2);
        indices.push(vi + 2, vi + 1, vi + 3);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(normals), 3));
    geo.setIndex(indices);

    setGeometryVertexColor(geo, 0.35, 0.55, 0.25);

    return geo;
  }

  /**
   * Generate a procedural grass clump geometry
   */
  private generateProceduralGrassClumpGeometry(seed: number): THREE.BufferGeometry {
    const bladeGeometries: THREE.BufferGeometry[] = [];

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

      const bladeNormals: number[] = [];
      for (let j = 0; j < positions.length; j += 3) {
        const y = positions[j + 1];
        const progress = y / h4;
        const nz = 0.4 + progress * 0.4;
        const ny = 0.3 * (1 - progress);
        const len = Math.sqrt(nz * nz + ny * ny);
        bladeNormals.push(0, ny / len, nz / len);
      }

      const uvs = [0, 0, 1, 0, 0.1, 0.35, 0.9, 0.35, 0.2, 0.65, 0.8, 0.65, 0.35, 0.9, 0.65, 0.9, 0.5, 1];

      const bladeGeo = new THREE.BufferGeometry();
      bladeGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
      bladeGeo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(bladeNormals), 3));
      bladeGeo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
      bladeGeo.setIndex(indices);

      // Apply transform (position and rotation)
      const angle = (noise3D(iSeed * 2, 0, 0) + 0.5) * Math.PI * 2;
      const distFactor = Math.pow(Math.abs(noise3D(0, iSeed * 2, 0)), 1.0 / clumpDensity);
      const dist = distFactor * clumpSpread;

      this._tempPosition.set(Math.cos(angle) * dist, 0, Math.sin(angle) * dist);
      this._tempEuler.set(
        noise3D(iSeed * 3, 0, 0) * 0.12,
        (noise3D(iSeed, iSeed, 0) + 0.5) * Math.PI * 2,
        noise3D(0, iSeed * 3, 0) * 0.1
      );
      this._tempQuaternion.setFromEuler(this._tempEuler);
      this._tempScale.set(1, 1, 1);
      this._tempMatrix.compose(this._tempPosition, this._tempQuaternion, this._tempScale);
      bladeGeo.applyMatrix4(this._tempMatrix);

      setGeometryVertexColor(bladeGeo, 0.35, 0.45, 0.22);

      bladeGeometries.push(bladeGeo);
    }

    const merged = BufferGeometryUtils.mergeGeometries(bladeGeometries, false);
    if (merged) {
      // Dispose individual blade geometries
      for (const bg of bladeGeometries) bg.dispose();
      return merged;
    }

    // Fallback empty geometry
    for (const bg of bladeGeometries) bg.dispose();
    return new THREE.BufferGeometry();
  }

  /**
   * Create a grass blade geometry with vertexID attribute
   */
  private createGrassBladeGeometry(): THREE.BufferGeometry {
    const segments = 4;
    const vertexCount = (segments + 1) * 2;
    const totalVertices = vertexCount * 2;

    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const vertexIDs: number[] = [];
    const indices: number[] = [];

    // Front face vertices (vertexID 0-9)
    for (let i = 0; i < vertexCount; i++) {
      positions.push(0, 0, 0);
      normals.push(0, 0, 1);
      colors.push(0.30, 0.40, 0.18, 1.0);
      vertexIDs.push(i);
    }

    // Back face vertices (vertexID 10-19)
    for (let i = 0; i < vertexCount; i++) {
      positions.push(0, 0, 0);
      normals.push(0, 0, -1);
      colors.push(0.30, 0.40, 0.18, 1.0);
      vertexIDs.push(vertexCount + i);
    }

    // Front face indices
    for (let i = 0; i < segments; i++) {
      const vi = i * 2;
      indices.push(vi, vi + 1, vi + 2);
      indices.push(vi + 2, vi + 1, vi + 3);
    }

    // Back face indices (reversed winding)
    for (let i = 0; i < segments; i++) {
      const vi = vertexCount + i * 2;
      indices.push(vi + 2, vi + 1, vi);
      indices.push(vi + 3, vi + 1, vi + 2);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(normals), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(colors), 4));
    geo.setAttribute("vertexID", new THREE.BufferAttribute(new Float32Array(vertexIDs), 1));
    geo.setIndex(indices);

    return geo;
  }

  /**
   * Create wind noise texture for GPU-efficient wind animation
   */
  private createWindTexture(): void {
    const size = this.WIND_TEXTURE_SIZE;
    const data = new Uint8Array(size * size * 4);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = x / size;
        const ny = y / size;

        let value = 0;
        let amplitude = 0.5;
        let frequency = 1;
        let px = nx * 4;
        let py = ny * 4;

        for (let i = 0; i < 3; i++) {
          const noiseVal = this.tileableNoise2D(px * frequency, py * frequency, 4);
          value += amplitude * noiseVal;
          frequency *= 2.02;
          amplitude *= 0.5;
        }

        const byteVal = Math.floor(Math.min(1, value) * 255);
        const idx = (y * size + x) * 4;
        data[idx] = byteVal;
        data[idx + 1] = byteVal;
        data[idx + 2] = byteVal;
        data[idx + 3] = 255;
      }
    }

    this.windNoiseTexture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    this.windNoiseTexture.wrapS = THREE.RepeatWrapping;
    this.windNoiseTexture.wrapT = THREE.RepeatWrapping;
    this.windNoiseTexture.minFilter = THREE.LinearMipmapLinearFilter;
    this.windNoiseTexture.magFilter = THREE.LinearFilter;
    this.windNoiseTexture.generateMipmaps = true;
    this.windNoiseTexture.needsUpdate = true;

    console.log(`[FoliageSystem] Created ${size}x${size} wind texture`);
  }

  /**
   * Tileable 2D noise for wind texture generation
   */
  private tileableNoise2D(x: number, y: number, period: number): number {
    const ix = Math.floor(x) % period;
    const iy = Math.floor(y) % period;
    const fx = x - Math.floor(x);
    const fy = y - Math.floor(y);

    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);

    const n00 = this.hash2D(ix, iy);
    const n10 = this.hash2D((ix + 1) % period, iy);
    const n01 = this.hash2D(ix, (iy + 1) % period);
    const n11 = this.hash2D((ix + 1) % period, (iy + 1) % period);

    const nx0 = n00 * (1 - ux) + n10 * ux;
    const nx1 = n01 * (1 - ux) + n11 * ux;
    return nx0 * (1 - uy) + nx1 * uy;
  }

  /**
   * Simple hash function for noise generation
   */
  private hash2D(x: number, y: number): number {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  }

  /**
   * Create materials for foliage
   */
  private createMaterials(): void {
    // Rock material
    const rockTex = loadTextureWithFallbackSync(
      DEFAULT_FOLIAGE_QUALITY_PROFILE.textures.rock,
      {
        preferredExtensions: ["ktx2", "jpg", "png"],
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.RepeatWrapping,
        anisotropy: 8,
      }
    );

    this.rockMaterial = new THREE.ShaderMaterial({
      vertexShader: rockVertexShaderFull,
      fragmentShader: rockFragmentShader,
      uniforms: {
        uSunDirection: { value: new THREE.Vector3(0.5, 1, 0.5).normalize() },
        uSunColor: { value: new THREE.Color(1, 0.95, 0.8) },
        uAmbient: { value: 0.4 },
        uDiffuseColor: { value: new THREE.Color(0.5, 0.48, 0.45) },
        uSpecularColor: { value: new THREE.Color(0.1, 0.1, 0.1) },
        rockTexture: { value: rockTex },
        textureScale: { value: 1.0 },
        uFogColor: { value: new THREE.Color(0.6, 0.75, 0.9) },
        uFogDensity: { value: 0.008 },
        uFogHeightFalloff: { value: 5.0 },
        uFogHeightDensity: { value: 0.1 },
      },
      side: THREE.DoubleSide,
    });

    // Grass material
    this.createWindTexture();

    this.grassMaterial = new THREE.ShaderMaterial({
      vertexShader: grassVertexShader,
      fragmentShader: grassFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uWindStrength: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.biomeGrassStrength },
        uWindScale: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.grass.windScale },
        uWindSecondaryStrength: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.grass.windSecondaryStrength },
        uWindMacroSpeed: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.grassMacroSpeed },
        uWindMicroSpeed: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.grassMicroSpeed },
        uBladeThickness: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.grass.bladeThickness },
        uWindDirection: { value: new THREE.Vector2(
          Math.cos(DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.directionRadians),
          Math.sin(DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.directionRadians)
        )},
        uLodFar: { value: this.lodDistances.far },
        uVariationStrength: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.fade.biomeVariationStrength },
        uGrassBaseColor: { value: new THREE.Color(57/255, 108/255, 24/255) },
        uGrassTopColor: { value: new THREE.Color(119/255, 170/255, 26/255) },
        uWindTexture: { value: this.windNoiseTexture },
        uWindTextureScale: { value: this.terrainScale },
        uSunDirection: { value: new THREE.Vector3(0.5, 1, 0.5).normalize() },
        uSunColor: { value: new THREE.Color(1, 0.95, 0.8) },
        uAmbient: { value: 0.4 },
        uFogColor: { value: new THREE.Color(0.6, 0.75, 0.9) },
        uFogDensity: { value: 0.008 },
        uFadeStart: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.fade.biomeGrassFadeStart },
        uFadeEnd: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.fade.biomeGrassFadeEnd },
        uDitherPixelSize: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.grass.ditherPixelSize },
        uDitherMode: { value: DEFAULT_FOLIAGE_QUALITY_PROFILE.grass.ditherMode },
      },
      side: THREE.DoubleSide,
    });
  }

  /**
   * Create impostor system (billboard geometries and materials)
   */
  private createImpostorSystem(): void {
    console.log("[FoliageSystem] Creating impostor system...");

    this.impostorBaseGeometry = new THREE.PlaneGeometry(1, 1);

    // Grass impostor material
    this.impostorGrassMaterial = new THREE.ShaderMaterial({
      vertexShader: impostorVertexShader,
      fragmentShader: impostorFragmentShader,
      uniforms: {
        uBaseColor: { value: new THREE.Color(0.35, 0.55, 0.25) },
        uFogColor: { value: new THREE.Color(0.6, 0.75, 0.9) },
        uFogDensity: { value: 0.008 },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    // Rock impostor material
    this.impostorRockMaterial = new THREE.ShaderMaterial({
      vertexShader: impostorVertexShader,
      fragmentShader: impostorFragmentShader,
      uniforms: {
        uBaseColor: { value: new THREE.Color(0.5, 0.48, 0.45) },
        uFogColor: { value: new THREE.Color(0.6, 0.75, 0.9) },
        uFogDensity: { value: 0.008 },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    console.log("[FoliageSystem] Impostor system created");
  }

  /**
   * Sync fog settings with scene fog for consistent appearance
   */
  syncFogSettings(
    fogColor: THREE.Color,
    fogDensity: number,
    fogHeightFalloff: number = 5.0,
    fogHeightDensity: number = 0.1
  ): void {
    if (this.grassMaterial) {
      this.grassMaterial.uniforms.uFogColor.value.copy(fogColor);
      this.grassMaterial.uniforms.uFogDensity.value = fogDensity;
    }

    if (this.rockMaterial) {
      this.rockMaterial.uniforms.uFogColor.value.copy(fogColor);
      this.rockMaterial.uniforms.uFogDensity.value = fogDensity;
      this.rockMaterial.uniforms.uFogHeightFalloff.value = fogHeightFalloff;
      this.rockMaterial.uniforms.uFogHeightDensity.value = fogHeightDensity;
    }

    if (this.impostorGrassMaterial) {
      this.impostorGrassMaterial.uniforms.uFogColor.value.copy(fogColor);
      this.impostorGrassMaterial.uniforms.uFogDensity.value = fogDensity;
    }
    if (this.impostorRockMaterial) {
      this.impostorRockMaterial.uniforms.uFogColor.value.copy(fogColor);
      this.impostorRockMaterial.uniforms.uFogDensity.value = fogDensity;
    }
  }

  /**
   * Update camera position for fog calculation in shaders
   * (Three.js auto-injects cameraPosition for ShaderMaterial, but we keep this
   *  for any custom usage and impostor materials)
   */
  updateCameraPosition(_cameraPosition: THREE.Vector3): void {
    // Three.js automatically provides cameraPosition uniform to ShaderMaterial.
    // No manual setting needed.
  }

  /**
   * Sync sun direction and color for lighting
   */
  syncSunDirection(sunDirection: THREE.Vector3, sunColor: THREE.Color): void {
    if (this.grassMaterial) {
      this.grassMaterial.uniforms.uSunDirection.value.copy(sunDirection);
      this.grassMaterial.uniforms.uSunColor.value.copy(sunColor);
    }
    if (this.rockMaterial) {
      this.rockMaterial.uniforms.uSunDirection.value.copy(sunDirection);
      this.rockMaterial.uniforms.uSunColor.value.copy(sunColor);
    }
  }

  /**
   * Update time uniform for wind animation
   */
  updateTime(time: number): void {
    if (this.grassMaterial) {
      this.grassMaterial.uniforms.uTime.value = time;
    }
  }

  /**
   * Update LOD far distance in shader for alpha fade
   */
  private updateShaderLodDistance(): void {
    if (this.grassMaterial) {
      this.grassMaterial.uniforms.uLodFar.value = this.lodDistances.far;
    }
  }

  /**
   * Seeded random for consistent results
   */
  private seededRandom(): number {
    this.seed = (this.seed * 9301 + 49297) % 233280;
    return this.seed / 233280;
  }

  /**
   * Reset seed for reproducible generation
   */
  private resetSeed(baseSeed: number): void {
    this.seed = baseSeed;
  }

  /**
   * Generate all foliage for the terrain
   */
  generateAll(): void {
    console.log("[FoliageSystem] Generating all foliage...");
    this.disposeAll();

    const numChunksX = Math.ceil(this.terrainScale / this.chunkSize);
    const numChunksZ = Math.ceil(this.terrainScale / this.chunkSize);

    for (let cx = 0; cx < numChunksX; cx++) {
      for (let cz = 0; cz < numChunksZ; cz++) {
        this.generateChunk(cx, cz);
      }
    }

    console.log(`[FoliageSystem] Generated ${this.chunks.size} chunks`);
  }

  /**
   * Helper: create an InstancedMesh from geometry, material, and matrix buffer
   */
  private createInstancedMesh(
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    matrices: Float32Array
  ): THREE.InstancedMesh {
    const instanceCount = matrices.length / 16;
    const instMesh = new THREE.InstancedMesh(geometry, material, instanceCount);
    instMesh.name = name;

    const mat4 = new THREE.Matrix4();
    for (let i = 0; i < instanceCount; i++) {
      mat4.fromArray(matrices, i * 16);
      instMesh.setMatrixAt(i, mat4);
    }
    instMesh.instanceMatrix.needsUpdate = true;
    instMesh.computeBoundingSphere();

    if (this.scene && typeof this.scene.add === "function") {
      this.scene.add(instMesh);
    }

    return instMesh;
  }

  /**
   * Generate foliage for a specific chunk
   */
  private generateChunk(chunkX: number, chunkZ: number): void {
    const chunkKey = `${chunkX}_${chunkZ}`;
    const worldStartX = chunkX * this.chunkSize;
    const worldStartZ = chunkZ * this.chunkSize;
    const worldEndX = Math.min(worldStartX + this.chunkSize, this.terrainScale);
    const worldEndZ = Math.min(worldStartZ + this.chunkSize, this.terrainScale);

    const chunk: FoliageChunk = {
      x: chunkX,
      z: chunkZ,
      instances: new Map(),
      mesh: new Map(),
      impostorMesh: null,
      visible: true,
      currentLOD: FoliageLOD.Near,
    };

    for (const [typeName, config] of this.foliageTypes) {
      const isRockType = typeName === "rock" || typeName === "sandRock";
      const isGrassType = typeName === "grass";

      if (isGrassType && this.grassVariationGeometries.length > 0) {
        const variationMatrices = this.generateGrassInstancesWithVariations(
          config, worldStartX, worldStartZ, worldEndX, worldEndZ
        );

        for (let v = 0; v < this.grassVariationGeometries.length; v++) {
          const matrices = variationMatrices[v];
          if (matrices && matrices.length > 0) {
            const variationKey = `${typeName}_v${v}`;
            this.shuffleMatrices(matrices, chunkX * 1000 + chunkZ * 100 + v);
            chunk.instances.set(variationKey, matrices);

            const baseGeo = this.grassVariationGeometries[v];
            const instMesh = this.createInstancedMesh(
              `${variationKey}_${chunkKey}`,
              baseGeo,
              this.grassMaterial!,
              matrices
            );
            chunk.mesh.set(variationKey, instMesh);
          }
        }
      } else if (isRockType && this.rockVariationGeometries.length > 0) {
        const variationMatrices = this.generateRockInstancesWithVariations(
          config, worldStartX, worldStartZ, worldEndX, worldEndZ
        );

        for (let v = 0; v < this.rockVariationGeometries.length; v++) {
          const matrices = variationMatrices[v];
          if (matrices && matrices.length > 0) {
            const variationKey = `${typeName}_v${v}`;
            this.shuffleMatrices(matrices, chunkX * 1000 + chunkZ * 100 + v + 50);
            chunk.instances.set(variationKey, matrices);

            const baseGeo = this.rockVariationGeometries[v];
            const instMesh = this.createInstancedMesh(
              `${variationKey}_${chunkKey}`,
              baseGeo,
              this.rockMaterial!,
              matrices
            );
            chunk.mesh.set(variationKey, instMesh);
          }
        }
      } else {
        const matrices = this.generateInstancesForType(
          typeName, config, worldStartX, worldStartZ, worldEndX, worldEndZ
        );

        if (matrices.length > 0) {
          this.shuffleMatrices(matrices, chunkX * 1000 + chunkZ * 100 + typeName.charCodeAt(0));
          chunk.instances.set(typeName, matrices);

          const baseGeo = this.baseGeometries.get(typeName);
          const material = (typeName === "grass") ? this.grassMaterial! : this.rockMaterial!;
          if (baseGeo) {
            const instMesh = this.createInstancedMesh(
              `${typeName}_${chunkKey}`,
              baseGeo,
              material,
              matrices
            );
            chunk.mesh.set(typeName, instMesh);
          }
        }
      }
    }

    this.chunks.set(chunkKey, chunk);
  }

  /**
   * Generate rock instances distributed across variations
   */
  private generateRockInstancesWithVariations(
    config: FoliageTypeConfig,
    startX: number,
    startZ: number,
    endX: number,
    endZ: number
  ): Float32Array[] {
    if (this.rockVariationGeometries.length === 0) {
      console.warn("[FoliageSystem] No rock variations available for generation");
      return [];
    }

    const variationMatrices: number[][] = [];
    for (let i = 0; i < this.rockVariationGeometries.length; i++) {
      variationMatrices.push([]);
    }

    const resolution = this.splatMap.getResolution();
    this.resetSeed(Math.floor(startX * 1000 + startZ));

    const area = (endX - startX) * (endZ - startZ);
    const targetInstances = Math.floor(area * config.baseDensity);
    const instanceCount = Math.min(targetInstances, this.maxInstancesPerChunk);

    for (let i = 0; i < instanceCount; i++) {
      const x = startX + this.seededRandom() * (endX - startX);
      const z = startZ + this.seededRandom() * (endZ - startZ);

      const splatX = Math.floor((x / this.terrainScale) * (resolution - 1));
      const splatZ = Math.floor((z / this.terrainScale) * (resolution - 1));
      const weights = this.splatMap.getWeights(
        Math.max(0, Math.min(resolution - 1, splatX)),
        Math.max(0, Math.min(resolution - 1, splatZ))
      );

      const biomeWeight = weights[config.biomeChannel];
      if (biomeWeight < config.biomeThreshold) continue;

      const waterWeight = this.splatMap.getWaterWeight(
        Math.max(0, Math.min(resolution - 1, splatX)),
        Math.max(0, Math.min(resolution - 1, splatZ))
      );
      if (waterWeight > 0.1) continue;

      if (this.seededRandom() > biomeWeight) continue;

      const y = this.heightmap.getInterpolatedHeight(x, z);
      const slope = this.calculateSlope(x, z);
      if (slope > config.slopeMax) continue;

      const sizeRandom = Math.pow(this.seededRandom(), 2.5);
      const scaleBase = config.minScale + sizeRandom * (config.maxScale - config.minScale);
      const scale = scaleBase * (0.8 + this.seededRandom() * 0.4);

      const rotationY = this.seededRandom() * Math.PI * 2;
      const rotationX = (this.seededRandom() - 0.5) * 0.2;
      const rotationZ = (this.seededRandom() - 0.5) * 0.2;

      // Three.js: compose(position, quaternion, scale)
      this._tempPosition.set(x, y + config.yOffset, z);
      this._tempScale.set(scale, scale, scale);
      this._tempEuler.set(rotationX, rotationY, rotationZ);
      this._tempQuaternion.setFromEuler(this._tempEuler);

      // Build final matrix: Translation * RotZ * RotX * RotY * Scale
      this._tempMatrix.compose(this._tempPosition, this._tempQuaternion, this._tempScale);

      const variationIndex = Math.floor(this.seededRandom() * this.rockVariationGeometries.length);

      const m = this._tempMatrix.elements;
      variationMatrices[variationIndex].push(
        m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7],
        m[8], m[9], m[10], m[11], m[12], m[13], m[14], m[15]
      );
    }

    return variationMatrices.map((arr) => new Float32Array(arr));
  }

  /**
   * Generate grass instances distributed across variations
   */
  private generateGrassInstancesWithVariations(
    config: FoliageTypeConfig,
    startX: number,
    startZ: number,
    endX: number,
    endZ: number
  ): Float32Array[] {
    if (this.grassVariationGeometries.length === 0) {
      console.warn("[FoliageSystem] No grass variations available for generation");
      return [];
    }

    const variationMatrices: number[][] = [];
    for (let i = 0; i < this.grassVariationGeometries.length; i++) {
      variationMatrices.push([]);
    }

    const resolution = this.splatMap.getResolution();
    this.resetSeed(Math.floor(startX * 1000 + startZ + 500));

    const area = (endX - startX) * (endZ - startZ);
    const targetInstances = Math.floor(area * config.baseDensity);
    const instanceCount = Math.min(targetInstances, this.maxInstancesPerChunk);

    for (let i = 0; i < instanceCount; i++) {
      const x = startX + this.seededRandom() * (endX - startX);
      const z = startZ + this.seededRandom() * (endZ - startZ);

      const splatX = Math.floor((x / this.terrainScale) * (resolution - 1));
      const splatZ = Math.floor((z / this.terrainScale) * (resolution - 1));
      const weights = this.splatMap.getWeights(
        Math.max(0, Math.min(resolution - 1, splatX)),
        Math.max(0, Math.min(resolution - 1, splatZ))
      );

      const biomeWeight = weights[config.biomeChannel];
      const rockWeight = weights[2] ?? 0;
      const pebbleWeight = weights[1] ?? 0;

      if (biomeWeight < config.biomeThreshold) continue;

      const waterWeight = this.splatMap.getWaterWeight(
        Math.max(0, Math.min(resolution - 1, splatX)),
        Math.max(0, Math.min(resolution - 1, splatZ))
      );
      if (waterWeight > 0.1) continue;

      const stoneWeight = Math.max(rockWeight, pebbleWeight * 0.35);
      const stoneStart = DEFAULT_FOLIAGE_QUALITY_PROFILE.grass.stoneSuppressionStartWeight;
      const stoneInfluence = Math.max(
        0,
        (stoneWeight - stoneStart) / Math.max(0.0001, 1.0 - stoneStart)
      );
      if (stoneInfluence > 0) {
        const suppressionChance =
          stoneInfluence * DEFAULT_FOLIAGE_QUALITY_PROFILE.grass.stoneSuppression;
        if (this.seededRandom() < suppressionChance) continue;
      }

      if (this.seededRandom() > biomeWeight) continue;

      const y = this.heightmap.getInterpolatedHeight(x, z);
      const slope = this.calculateSlope(x, z);
      if (slope > config.slopeMax) continue;

      // Consume random values to maintain seed consistency
      const _unusedScaleBase = config.minScale + this.seededRandom() * (config.maxScale - config.minScale);
      const _unusedSuppressionScale = 1.0 - stoneInfluence * (DEFAULT_FOLIAGE_QUALITY_PROFILE.grass.stoneSuppression * 0.55);
      this.seededRandom(); // was scale variation
      this.seededRandom(); // was rotationY

      // Create identity matrix with only translation (position)
      this._tempPosition.set(x, y + config.yOffset, z);
      this._tempScale.set(1, 1, 1);
      this._tempQuaternion.set(0, 0, 0, 1);
      this._tempFinalMatrix.compose(this._tempPosition, this._tempQuaternion, this._tempScale);

      const variationIndex = Math.floor(this.seededRandom() * this.grassVariationGeometries.length);

      const m = this._tempFinalMatrix.elements;
      variationMatrices[variationIndex].push(
        m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7],
        m[8], m[9], m[10], m[11], m[12], m[13], m[14], m[15]
      );
    }

    return variationMatrices.map((arr) => new Float32Array(arr));
  }

  /**
   * Generate instance matrices for a specific foliage type in a region
   */
  private generateInstancesForType(
    typeName: string,
    config: FoliageTypeConfig,
    startX: number,
    startZ: number,
    endX: number,
    endZ: number
  ): Float32Array {
    const matrices: number[] = [];
    const resolution = this.splatMap.getResolution();

    this.resetSeed(Math.floor(startX * 1000 + startZ));

    const area = (endX - startX) * (endZ - startZ);
    const targetInstances = Math.floor(area * config.baseDensity);
    const instanceCount = Math.min(targetInstances, this.maxInstancesPerChunk);

    for (let i = 0; i < instanceCount; i++) {
      const x = startX + this.seededRandom() * (endX - startX);
      const z = startZ + this.seededRandom() * (endZ - startZ);

      const splatX = Math.floor((x / this.terrainScale) * (resolution - 1));
      const splatZ = Math.floor((z / this.terrainScale) * (resolution - 1));
      const weights = this.splatMap.getWeights(
        Math.max(0, Math.min(resolution - 1, splatX)),
        Math.max(0, Math.min(resolution - 1, splatZ))
      );

      const biomeWeight = weights[config.biomeChannel];

      if (biomeWeight < config.biomeThreshold) continue;

      const waterWeight = this.splatMap.getWaterWeight(
        Math.max(0, Math.min(resolution - 1, splatX)),
        Math.max(0, Math.min(resolution - 1, splatZ))
      );
      if (waterWeight > 0.1) continue;

      const rockWeight = weights[2] ?? 0;
      const pebbleWeight = weights[1] ?? 0;
      let stoneInfluence = 0;
      if (typeName === "grass") {
        const stoneWeight = Math.max(rockWeight, pebbleWeight * 0.35);
        const stoneStart = DEFAULT_FOLIAGE_QUALITY_PROFILE.grass.stoneSuppressionStartWeight;
        stoneInfluence = Math.max(
          0,
          (stoneWeight - stoneStart) / Math.max(0.0001, 1.0 - stoneStart)
        );
        if (stoneInfluence > 0) {
          const suppressionChance =
            stoneInfluence * DEFAULT_FOLIAGE_QUALITY_PROFILE.grass.stoneSuppression;
          if (this.seededRandom() < suppressionChance) continue;
        }
      }

      if (this.seededRandom() > biomeWeight) continue;

      const y = this.heightmap.getInterpolatedHeight(x, z);
      const slope = this.calculateSlope(x, z);
      if (slope > config.slopeMax) continue;

      const sizeRandom = Math.pow(this.seededRandom(), 2.5);
      const scaleBase = config.minScale + sizeRandom * (config.maxScale - config.minScale);
      let scale = scaleBase * (0.8 + this.seededRandom() * 0.4);
      if (typeName === "grass" && stoneInfluence > 0) {
        const suppressionScale =
          1.0 -
          stoneInfluence * (DEFAULT_FOLIAGE_QUALITY_PROFILE.grass.stoneSuppression * 0.55);
        scale = Math.max(0.05, scale * suppressionScale);
      }

      const rotationY = this.seededRandom() * Math.PI * 2;

      this._tempPosition.set(x, y + config.yOffset, z);
      this._tempScale.set(scale, scale, scale);
      this._tempQuaternion.setFromEuler(this._tempEuler.set(0, rotationY, 0));
      this._tempFinalMatrix.compose(this._tempPosition, this._tempQuaternion, this._tempScale);

      const m = this._tempFinalMatrix.elements;
      matrices.push(
        m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7],
        m[8], m[9], m[10], m[11], m[12], m[13], m[14], m[15]
      );
    }

    return new Float32Array(matrices);
  }

  /**
   * Calculate slope at a position (0 = flat, 1 = vertical)
   */
  private calculateSlope(x: number, z: number): number {
    const delta = 0.5;
    const hL = this.heightmap.getInterpolatedHeight(Math.max(0, x - delta), z);
    const hR = this.heightmap.getInterpolatedHeight(Math.min(this.terrainScale, x + delta), z);
    const hD = this.heightmap.getInterpolatedHeight(x, Math.max(0, z - delta));
    const hU = this.heightmap.getInterpolatedHeight(x, Math.min(this.terrainScale, z + delta));

    const dx = (hR - hL) / (2 * delta);
    const dz = (hU - hD) / (2 * delta);

    const nx = -dx;
    const ny = 1;
    const nz = -dz;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);

    return 1 - (ny / len);
  }

  /**
   * Update frustum planes cache (call once per frame before visibility check)
   */
  private updateFrustumPlanes(): void {
    this.frameCounter++;
    if (this.lastFrustumUpdateFrame === this.frameCounter) return;

    const cam = this.camera;
    if (!cam) return;

    this.frustumMatrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.frustumMatrix);
    this.lastFrustumUpdateFrame = this.frameCounter;
  }

  /**
   * Check if a chunk is inside the camera frustum
   */
  private isChunkInFrustum(chunkCenterX: number, chunkCenterY: number, chunkCenterZ: number): boolean {
    if (!this.camera) return true;

    this._frustumSphere.center.set(chunkCenterX, chunkCenterY, chunkCenterZ);
    this._frustumSphere.radius = this.chunkSize * 0.7071;
    return this.frustum.intersectsSphere(this._frustumSphere);
  }

  /**
   * Update foliage visibility based on camera position
   */
  updateVisibility(cameraPosition: THREE.Vector3): void {
    let camX: number;
    let camZ: number;

    if (this.useWrapping) {
      camX = cameraPosition.x % this.terrainScale;
      camZ = cameraPosition.z % this.terrainScale;
      if (camX < 0) camX += this.terrainScale;
      if (camZ < 0) camZ += this.terrainScale;
    } else {
      camX = cameraPosition.x;
      camZ = cameraPosition.z;
    }

    const moveDx = camX - this.lastVisibilityCamX;
    const moveDz = camZ - this.lastVisibilityCamZ;
    const moveDistSq = moveDx * moveDx + moveDz * moveDz;
    const heightChanged = Math.abs(cameraPosition.y - this.lastVisibilityCamY) > 5.0;

    if (moveDistSq < this.VISIBILITY_UPDATE_THRESHOLD * this.VISIBILITY_UPDATE_THRESHOLD && !heightChanged) {
      return;
    }

    this.lastVisibilityCamX = camX;
    this.lastVisibilityCamZ = camZ;
    this.lastVisibilityCamY = cameraPosition.y;

    this.updateFrustumPlanes();

    for (const [key, chunk] of this.chunks) {
      const chunkCenterX = (chunk.x + 0.5) * this.chunkSize;
      const chunkCenterZ = (chunk.z + 0.5) * this.chunkSize;
      const chunkCenterY = cameraPosition.y * 0.5;

      const visible = this.isChunkInFrustum(chunkCenterX, chunkCenterY, chunkCenterZ);

      if (chunk.visible !== visible) {
        chunk.visible = visible;
        for (const mesh of chunk.mesh.values()) {
          mesh.visible = visible;
        }
      }
    }
  }

  /**
   * Set wrapping mode for camera position in updateVisibility
   */
  setUseWrapping(useWrapping: boolean): void {
    this.useWrapping = useWrapping;
  }

  /**
   * Reset all chunk visibility to visible
   */
  resetAllChunkVisibility(): void {
    for (const [, chunk] of this.chunks) {
      if (!chunk.visible) {
        chunk.visible = true;
        for (const mesh of chunk.mesh.values()) {
          mesh.visible = true;
        }
      }
    }
    this.lastVisibilityCamX = -Infinity;
    this.lastVisibilityCamZ = -Infinity;
    this.lastVisibilityCamY = -Infinity;
  }

  /**
   * Regenerate foliage for changed area
   */
  regenerateArea(centerX: number, centerZ: number, radius: number): void {
    const minChunkX = Math.floor((centerX - radius) / this.chunkSize);
    const maxChunkX = Math.ceil((centerX + radius) / this.chunkSize);
    const minChunkZ = Math.floor((centerZ - radius) / this.chunkSize);
    const maxChunkZ = Math.ceil((centerZ + radius) / this.chunkSize);

    for (let cx = minChunkX; cx <= maxChunkX; cx++) {
      for (let cz = minChunkZ; cz <= maxChunkZ; cz++) {
        if (cx >= 0 && cz >= 0) {
          const key = `${cx}_${cz}`;
          const existing = this.chunks.get(key);
          if (existing) {
            for (const mesh of existing.mesh.values()) {
              this.disposeInstancedMesh(mesh);
            }
            if (existing.impostorMesh) {
              this.disposeInstancedMesh(existing.impostorMesh);
            }
            this.chunks.delete(key);
          }
          this.generateChunk(cx, cz);
        }
      }
    }
  }

  /**
   * Set LOD distances
   */
  setLODDistances(near: number, mid: number, far: number): void {
    this.lodDistances.near = near;
    this.lodDistances.mid = mid;
    this.lodDistances.far = far;
    this.updateShaderLodDistance();
  }

  /**
   * Get statistics
   */
  getStats(): { chunks: number; totalInstances: number } {
    let totalInstances = 0;
    for (const chunk of this.chunks.values()) {
      for (const matrices of chunk.instances.values()) {
        totalInstances += matrices.length / 16;
      }
    }
    return {
      chunks: this.chunks.size,
      totalInstances,
    };
  }

  /**
   * Set visibility of all foliage meshes (for debugging)
   */
  setVisible(visible: boolean): void {
    for (const chunk of this.chunks.values()) {
      for (const mesh of chunk.mesh.values()) {
        mesh.visible = visible;
      }
    }
  }

  /**
   * Get base geometry for a foliage type (for external rendering)
   */
  getBaseGeometry(typeName: string): THREE.BufferGeometry | undefined {
    const varMatch = typeName.match(/_v(\d+)$/);
    const varIdx = varMatch ? parseInt(varMatch[1]) : 0;
    const baseTypeName = typeName.replace(/_v\d+$/, "");

    if (baseTypeName === "grass" && this.grassVariationGeometries.length > 0) {
      return this.grassVariationGeometries[varIdx] || this.grassVariationGeometries[0];
    } else if ((baseTypeName === "rock" || baseTypeName === "sandRock") && this.rockVariationGeometries.length > 0) {
      return this.rockVariationGeometries[varIdx] || this.rockVariationGeometries[0];
    } else {
      return this.baseGeometries.get(baseTypeName);
    }
  }

  /**
   * Helper to dispose an InstancedMesh (remove from scene + dispose geometry)
   * Note: We do NOT dispose geometry here because it's shared across chunks.
   * We only remove from scene.
   */
  private disposeInstancedMesh(mesh: THREE.InstancedMesh): void {
    if (this.scene && typeof this.scene.remove === "function") {
      this.scene.remove(mesh);
    }
    // Don't dispose geometry - it's shared (base geometry)
    // Don't dispose material - it's shared
    mesh.dispose();
  }

  /**
   * Dispose all foliage
   */
  disposeAll(): void {
    for (const chunk of this.chunks.values()) {
      for (const mesh of chunk.mesh.values()) {
        this.disposeInstancedMesh(mesh);
      }
      if (chunk.impostorMesh) {
        this.disposeInstancedMesh(chunk.impostorMesh);
      }
    }
    this.chunks.clear();

    this.lastVisibilityCamX = -Infinity;
    this.lastVisibilityCamZ = -Infinity;
    this.lastVisibilityCamY = -Infinity;
  }

  // ============================================
  // Tile Data Export/Import
  // ============================================

  /**
   * Export all foliage instance data for saving with tile
   */
  exportTileData(): Record<string, string> {
    const result: Record<string, string> = {};
    const typeMatrices: Map<string, number[]> = new Map();

    for (const chunk of this.chunks.values()) {
      for (const [typeName, matrices] of chunk.instances) {
        if (!typeMatrices.has(typeName)) {
          typeMatrices.set(typeName, []);
        }
        const arr = typeMatrices.get(typeName)!;
        for (let i = 0; i < matrices.length; i++) {
          arr.push(matrices[i]);
        }
      }
    }

    for (const [typeName, values] of typeMatrices) {
      if (values.length > 0) {
        const float32 = new Float32Array(values);
        result[typeName] = DataCodec.encodeFloat32Array(float32);
      }
    }

    console.log(`[FoliageSystem] Exported ${Object.keys(result).length} foliage types`);
    return result;
  }

  /**
   * Import foliage instance data from saved tile
   */
  importTileData(
    data: Record<string, string>,
    offsetX: number = 0,
    offsetZ: number = 0,
    clearExisting: boolean = false
  ): void {
    if (clearExisting) {
      this.disposeAll();
    }

    let totalImported = 0;

    for (const [typeName, base64] of Object.entries(data)) {
      const matrices = DataCodec.decodeFloat32Array(base64);
      if (matrices.length === 0) continue;

      const instanceCount = matrices.length / 16;

      if (offsetX !== 0 || offsetZ !== 0) {
        for (let i = 0; i < instanceCount; i++) {
          const baseIdx = i * 16;
          matrices[baseIdx + 12] += offsetX;
          matrices[baseIdx + 14] += offsetZ;
        }
      }

      this.addImportedInstances(typeName, matrices);
      totalImported += instanceCount;
    }

    console.log(`[FoliageSystem] Imported ${totalImported} foliage instances`);
  }

  /**
   * Add imported instances to appropriate chunks
   */
  private addImportedInstances(typeName: string, matrices: Float32Array): void {
    const chunkInstances: Map<string, number[]> = new Map();
    const instanceCount = matrices.length / 16;

    for (let i = 0; i < instanceCount; i++) {
      const baseIdx = i * 16;
      const worldX = matrices[baseIdx + 12];
      const worldZ = matrices[baseIdx + 14];

      const chunkX = Math.floor(worldX / this.chunkSize);
      const chunkZ = Math.floor(worldZ / this.chunkSize);
      const chunkKey = `${chunkX},${chunkZ}`;

      if (!chunkInstances.has(chunkKey)) {
        chunkInstances.set(chunkKey, []);
      }

      const arr = chunkInstances.get(chunkKey)!;
      for (let j = 0; j < 16; j++) {
        arr.push(matrices[baseIdx + j]);
      }
    }

    for (const [chunkKey, values] of chunkInstances) {
      const [cx, cz] = chunkKey.split(",").map(Number);
      let chunk = this.chunks.get(chunkKey);

      if (!chunk) {
        chunk = {
          x: cx,
          z: cz,
          instances: new Map(),
          mesh: new Map(),
          impostorMesh: null,
          visible: true,
          currentLOD: FoliageLOD.Near,
        };
        this.chunks.set(chunkKey, chunk);
      }

      const existingMatrices = chunk.instances.get(typeName);
      const newMatrices = new Float32Array(values);

      if (existingMatrices) {
        const merged = new Float32Array(existingMatrices.length + newMatrices.length);
        merged.set(existingMatrices);
        merged.set(newMatrices, existingMatrices.length);
        chunk.instances.set(typeName, merged);
      } else {
        chunk.instances.set(typeName, newMatrices);
      }

      this.updateChunkMesh(chunk, typeName);
    }
  }

  /**
   * Update instanced mesh for a specific type in a chunk
   */
  private updateChunkMesh(chunk: FoliageChunk, typeName: string): void {
    const matrices = chunk.instances.get(typeName);
    if (!matrices || matrices.length === 0) return;

    // Dispose old mesh if exists
    const existingMesh = chunk.mesh.get(typeName);
    if (existingMesh) {
      this.disposeInstancedMesh(existingMesh);
      chunk.mesh.delete(typeName);
    }

    // Determine base geometry
    const varMatch = typeName.match(/_v(\d+)$/);
    const varIdx = varMatch ? parseInt(varMatch[1]) : 0;
    const baseTypeName = typeName.replace(/_v\d+$/, "");

    let baseGeo: THREE.BufferGeometry | undefined;
    let material: THREE.Material;

    if (baseTypeName === "grass" && this.grassVariationGeometries.length > 0) {
      baseGeo = this.grassVariationGeometries[varIdx] || this.grassVariationGeometries[0];
      material = this.grassMaterial!;
    } else if ((baseTypeName === "rock" || baseTypeName === "sandRock") && this.rockVariationGeometries.length > 0) {
      baseGeo = this.rockVariationGeometries[varIdx] || this.rockVariationGeometries[0];
      material = this.rockMaterial!;
    } else {
      baseGeo = this.baseGeometries.get(baseTypeName);
      material = (baseTypeName === "grass") ? this.grassMaterial! : this.rockMaterial!;
    }

    if (!baseGeo) {
      console.warn(`[FoliageSystem] No base geometry for type: ${typeName} (base: ${baseTypeName})`);
      return;
    }

    const instMesh = this.createInstancedMesh(
      `foliage_${chunk.x}_${chunk.z}_${typeName}`,
      baseGeo,
      material,
      matrices
    );
    chunk.mesh.set(typeName, instMesh);
  }

  // ============================================
  // Cell-based Streaming
  // ============================================

  setCellSize(size: number): void {
    this.cellSize = size;
    console.log(`[FoliageSystem] Cell size set to ${size}`);
  }

  getCellSize(): number {
    return this.cellSize;
  }

  private getChunksInCell(cellX: number, cellZ: number): Array<{ chunkX: number; chunkZ: number }> {
    const chunksPerCellEdge = Math.ceil(this.cellSize / this.chunkSize);
    const result: Array<{ chunkX: number; chunkZ: number }> = [];

    const cellWorldStartX = cellX * this.cellSize;
    const cellWorldStartZ = cellZ * this.cellSize;

    const startChunkX = Math.floor(cellWorldStartX / this.chunkSize);
    const startChunkZ = Math.floor(cellWorldStartZ / this.chunkSize);

    for (let dx = 0; dx < chunksPerCellEdge; dx++) {
      for (let dz = 0; dz < chunksPerCellEdge; dz++) {
        result.push({
          chunkX: startChunkX + dx,
          chunkZ: startChunkZ + dz,
        });
      }
    }

    return result;
  }

  generateCell(cellX: number, cellZ: number): void {
    const cellKey = `${cellX}_${cellZ}`;

    if (this.loadedCells.has(cellKey)) {
      console.log(`[FoliageSystem] Cell ${cellKey} already loaded`);
      return;
    }

    console.log(`[FoliageSystem] Generating cell (${cellX},${cellZ})...`);

    const chunks = this.getChunksInCell(cellX, cellZ);
    let generatedCount = 0;

    for (const { chunkX, chunkZ } of chunks) {
      const chunkKey = `${chunkX}_${chunkZ}`;
      if (!this.chunks.has(chunkKey)) {
        this.generateChunk(chunkX, chunkZ);
        generatedCount++;
      }
    }

    this.loadedCells.add(cellKey);
    console.log(`[FoliageSystem] Cell ${cellKey} loaded with ${generatedCount} new chunks`);
  }

  unloadCell(cellX: number, cellZ: number): void {
    const cellKey = `${cellX}_${cellZ}`;

    if (!this.loadedCells.has(cellKey)) {
      return;
    }

    console.log(`[FoliageSystem] Unloading cell (${cellX},${cellZ})...`);

    const chunks = this.getChunksInCell(cellX, cellZ);
    let unloadedCount = 0;

    for (const { chunkX, chunkZ } of chunks) {
      const chunkKey = `${chunkX}_${chunkZ}`;
      const chunk = this.chunks.get(chunkKey);

      if (chunk) {
        for (const mesh of chunk.mesh.values()) {
          this.disposeInstancedMesh(mesh);
        }
        if (chunk.impostorMesh) {
          this.disposeInstancedMesh(chunk.impostorMesh);
        }
        this.chunks.delete(chunkKey);
        unloadedCount++;
      }
    }

    this.loadedCells.delete(cellKey);
    console.log(`[FoliageSystem] Cell ${cellKey} unloaded (${unloadedCount} chunks disposed)`);
  }

  updateCellLOD(cellX: number, cellZ: number, lod: FoliageLOD): void {
    const cellKey = `${cellX}_${cellZ}`;

    if (!this.loadedCells.has(cellKey)) {
      if (lod !== FoliageLOD.Far) {
        this.generateCell(cellX, cellZ);
      } else {
        return;
      }
    }

    const densityMultiplier = this.getLODDensityMultiplier(lod);
    const useImpostor = lod === FoliageLOD.Impostor;

    const chunks = this.getChunksInCell(cellX, cellZ);
    let updatedCount = 0;

    for (const { chunkX, chunkZ } of chunks) {
      const chunkKey = `${chunkX}_${chunkZ}`;
      const chunk = this.chunks.get(chunkKey);

      if (chunk && chunk.currentLOD !== lod) {
        chunk.currentLOD = lod;

        if (useImpostor) {
          for (const mesh of chunk.mesh.values()) {
            mesh.visible = false;
          }
          this.createOrShowChunkImpostor(chunk);
        } else {
          if (chunk.impostorMesh) {
            chunk.impostorMesh.visible = false;
          }

          // For InstancedMesh, we control visible instance count via .count property
          for (const [instanceTypeName, fullMatrices] of chunk.instances) {
            const mesh = chunk.mesh.get(instanceTypeName);
            if (mesh && fullMatrices.length > 0) {
              mesh.visible = true;
              const fullInstanceCount = fullMatrices.length / 16;
              const targetCount = Math.max(1, Math.floor(fullInstanceCount * densityMultiplier));
              mesh.count = targetCount;
            }
          }
        }
        updatedCount++;
      }
    }

    if (updatedCount > 0) {
      console.log(`[FoliageSystem] Cell ${cellKey} LOD updated to ${FoliageLOD[lod]} (${updatedCount} chunks)`);
    }
  }

  /**
   * Create or show impostor mesh for a chunk
   */
  private createOrShowChunkImpostor(chunk: FoliageChunk): void {
    if (!this.impostorBaseGeometry) return;

    if (chunk.impostorMesh) {
      chunk.impostorMesh.visible = true;
      return;
    }

    const IMPOSTOR_SAMPLE_RATE = 4;
    const matrices: number[] = [];
    let isGrassType = false;

    for (const [typeName, fullMatrices] of chunk.instances) {
      if (typeName.startsWith("grass")) {
        isGrassType = true;
      }

      const instanceCount = fullMatrices.length / 16;
      for (let i = 0; i < instanceCount; i += IMPOSTOR_SAMPLE_RATE) {
        const baseIdx = i * 16;
        const x = fullMatrices[baseIdx + 12];
        const y = fullMatrices[baseIdx + 13];
        const z = fullMatrices[baseIdx + 14];
        const scaleX = Math.sqrt(
          fullMatrices[baseIdx] * fullMatrices[baseIdx] +
          fullMatrices[baseIdx + 4] * fullMatrices[baseIdx + 4] +
          fullMatrices[baseIdx + 8] * fullMatrices[baseIdx + 8]
        );

        const scale = scaleX * 1.5;
        this._tempScale.set(scale, scale, 1);
        this._tempPosition.set(x, y + scale * 0.5, z);
        this._tempQuaternion.set(0, 0, 0, 1);
        this._tempMatrix.compose(this._tempPosition, this._tempQuaternion, this._tempScale);
        const m = this._tempMatrix.elements;
        matrices.push(
          m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7],
          m[8], m[9], m[10], m[11], m[12], m[13], m[14], m[15]
        );
      }
    }

    if (matrices.length === 0) return;

    const float32Matrices = new Float32Array(matrices);
    const material = isGrassType ? this.impostorGrassMaterial! : this.impostorRockMaterial!;

    const instMesh = this.createInstancedMesh(
      `impostor_${chunk.x}_${chunk.z}`,
      this.impostorBaseGeometry,
      material,
      float32Matrices
    );

    chunk.impostorMesh = instMesh;
  }

  /**
   * Shuffle matrices in-place for even LOD distribution
   */
  private shuffleMatrices(matrices: Float32Array, seed: number): void {
    const count = matrices.length / 16;
    if (count <= 1) return;

    let s = seed;
    const random = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };

    const temp = new Float32Array(16);
    for (let i = count - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      if (i !== j) {
        const iOffset = i * 16;
        const jOffset = j * 16;
        for (let k = 0; k < 16; k++) temp[k] = matrices[iOffset + k];
        for (let k = 0; k < 16; k++) matrices[iOffset + k] = matrices[jOffset + k];
        for (let k = 0; k < 16; k++) matrices[jOffset + k] = temp[k];
      }
    }
  }

  /**
   * Get density multiplier for LOD level
   */
  private getLODDensityMultiplier(lod: FoliageLOD): number {
    switch (lod) {
      case FoliageLOD.Near:
        return 1.0;
      case FoliageLOD.Mid:
        return 0.5;
      case FoliageLOD.Impostor:
        return 0.0;
      case FoliageLOD.Far:
        return 0.0;
      default:
        return 1.0;
    }
  }

  isCellLoaded(cellX: number, cellZ: number): boolean {
    return this.loadedCells.has(`${cellX}_${cellZ}`);
  }

  getLoadedCells(): Array<{ cellX: number; cellZ: number }> {
    const result: Array<{ cellX: number; cellZ: number }> = [];
    for (const key of this.loadedCells) {
      const [cellX, cellZ] = key.split('_').map(Number);
      result.push({ cellX, cellZ });
    }
    return result;
  }

  getCellStats(): {
    loadedCells: number;
    totalChunks: number;
    chunksPerCell: number;
  } {
    const chunksPerCellEdge = Math.ceil(this.cellSize / this.chunkSize);
    return {
      loadedCells: this.loadedCells.size,
      totalChunks: this.chunks.size,
      chunksPerCell: chunksPerCellEdge * chunksPerCellEdge,
    };
  }

  /**
   * Full cleanup
   */
  dispose(): void {
    this.disposeAll();
    this.loadedCells.clear();

    // Dispose base geometries
    for (const geo of this.baseGeometries.values()) {
      geo.dispose();
    }
    this.baseGeometries.clear();

    // Dispose rock variation geometries
    for (const geo of this.rockVariationGeometries) {
      geo.dispose();
    }
    this.rockVariationGeometries = [];

    // Dispose grass variation geometries
    for (const geo of this.grassVariationGeometries) {
      geo.dispose();
    }
    this.grassVariationGeometries = [];

    if (this.grassMaterial) {
      this.grassMaterial.dispose();
      this.grassMaterial = null;
    }
    if (this.rockMaterial) {
      this.rockMaterial.dispose();
      this.rockMaterial = null;
    }

    // Dispose impostor system
    if (this.impostorBaseGeometry) {
      this.impostorBaseGeometry.dispose();
      this.impostorBaseGeometry = null;
    }
    if (this.impostorGrassMaterial) {
      this.impostorGrassMaterial.dispose();
      this.impostorGrassMaterial = null;
    }
    if (this.impostorRockMaterial) {
      this.impostorRockMaterial.dispose();
      this.impostorRockMaterial = null;
    }

    // Dispose wind texture
    if (this.windNoiseTexture) {
      this.windNoiseTexture.dispose();
      this.windNoiseTexture = null;
    }
  }
}
