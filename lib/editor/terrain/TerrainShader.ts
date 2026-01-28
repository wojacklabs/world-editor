import {
  Scene,
  ShaderMaterial,
  Effect,
  RawTexture,
  Color3,
  Vector3,
  Texture,
  Engine,
  BaseTexture,
} from "@babylonjs/core";

/**
 * Load texture with KTX2 support and JPG/PNG fallback
 * Tries KTX2 first for GPU compression benefits, falls back to original format
 */
function loadTextureWithKTX2Fallback(
  basePath: string,
  scene: Scene,
  extension: string = "jpg"
): Texture {
  // For now, use original textures directly
  // KTX2 files should be generated offline using toktx tool
  // When KTX2 files exist, change extension to .ktx2
  const texturePath = `${basePath}.${extension}`;
  
  const texture = new Texture(texturePath, scene);
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = 16;

  return texture;
}

// Register custom shaders
Effect.ShadersStore["terrainVertexShader"] = `
precision highp float;

// Attributes
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

// Uniforms
uniform mat4 worldViewProjection;
uniform mat4 world;
uniform vec3 cameraPosition;

// Displacement uniforms
uniform sampler2D uSplatMap;
uniform sampler2D uRockDisp;
uniform sampler2D uGrassDisp;
uniform float uTextureScale;
uniform float uDispStrength;
uniform float uTerrainSize;

// Varyings
varying vec3 vPosition;
varying vec3 vNormal;
varying vec2 vUV;
varying float vHeight;
varying vec3 vViewDirection;
varying float vSlope;
varying float vCameraDistance;
varying mat3 vTBN;

void main() {
    // Sample splat map to get material weights
    vec4 splat = texture2D(uSplatMap, uv);
    float rockWeight = splat.b;
    float grassWeight = splat.r;

    // Calculate texture UV for displacement sampling (same as fragment shader)
    vec2 texUV = position.xz * uTextureScale;

    // Sample displacement maps
    float rockDispValue = texture2D(uRockDisp, texUV).r;
    float grassDispValue = texture2D(uGrassDisp, texUV).r;

    // Apply displacement for rock and grass areas
    // dispValue is 0-1, center at 0.5 for balanced displacement
    // Grass displacement at 50% strength (smoother terrain)
    float displacement = (rockDispValue - 0.5) * uDispStrength * rockWeight +
                         (grassDispValue - 0.5) * uDispStrength * 0.5 * grassWeight;
    
    vec3 displacedPosition = position + vec3(0.0, displacement, 0.0);
    
    vec4 worldPosition = world * vec4(displacedPosition, 1.0);
    gl_Position = worldViewProjection * vec4(displacedPosition, 1.0);

    vPosition = worldPosition.xyz;
    vNormal = normalize(normal);
    vUV = uv;
    vHeight = displacedPosition.y;

    vec3 toCamera = cameraPosition - worldPosition.xyz;
    vCameraDistance = length(toCamera);
    vViewDirection = normalize(toCamera);

    // Calculate slope (0 = flat, 1 = vertical)
    vSlope = 1.0 - abs(dot(vec3(0.0, 1.0, 0.0), vNormal));
    
    // Build TBN matrix for tangent space calculations
    // For terrain on XZ plane: tangent = X, bitangent = Z, normal = Y
    // Fixed TBN for consistent normal mapping across all tiles
    vec3 T = vec3(1.0, 0.0, 0.0);
    vec3 B = vec3(0.0, 0.0, 1.0);
    vec3 N = vNormal;
    vTBN = mat3(T, B, N);
}
`;

Effect.ShadersStore["terrainFragmentShader"] = `
precision highp float;

// Uniforms
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uAmbientIntensity;
uniform sampler2D uSplatMap;
uniform sampler2D uWaterMask;
uniform float uTerrainSize;
uniform float uUseSplatMap;  // Debug toggle: 0.0 = disable splat, 1.0 = normal
uniform int uDebugMode;  // 0=normal, 1=splatmap, 2=watermask, 3=grass, 4=dirt, 5=rock, 6=sand, 7=normals, 8=normals_detail, 9=normals_final, 10=rock_ao, 11=macro_var, 12=depth, 13=slope, 14=uv, 15=diffuse, 16=specular, 17=ao, 18=base_color

// Material colors (fallback)
uniform vec3 uGrassColor;
uniform vec3 uDirtColor;
uniform vec3 uRockColor;
uniform vec3 uSandColor;

// Textures
uniform sampler2D uRockDiffuse;
uniform sampler2D uRockNormal;
uniform sampler2D uRockDisp;
uniform sampler2D uRockARM;  // AO (R), Roughness (G), Metallic (B)
uniform sampler2D uDirtDiffuse;
uniform sampler2D uDirtNormal;
uniform sampler2D uDirtDisp;
uniform sampler2D uGrassDiffuse;
uniform sampler2D uGrassNormal;
uniform sampler2D uGrassARM;  // AO (R), Roughness (G), Metallic (B)
uniform sampler2D uGrassDisp;
uniform float uTextureScale;
uniform float uNormalStrength;

// Fog
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogStart;
uniform float uFogHeightFalloff;   // Height fog base altitude
uniform float uFogHeightDensity;   // Height fog density
uniform vec3 cameraPosition;       // Camera position for per-pixel fog calculation

// Water/Underwater
uniform float uWaterLevel;
uniform float uTime;

// Varyings
varying vec3 vPosition;
varying vec3 vNormal;
varying vec2 vUV;
varying float vHeight;
varying vec3 vViewDirection;
varying float vSlope;
varying float vCameraDistance;
varying mat3 vTBN;

// Hash functions for noise
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float hash3(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

// 2D noise
float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));

    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// FBM (Fractal Brownian Motion)
float fbm(vec2 p, int octaves) {
    float value = 0.0;
    float amplitude = 0.5;
    float frequency = 1.0;
    for (int i = 0; i < 6; i++) {
        if (i >= octaves) break;
        value += amplitude * noise(p * frequency);
        frequency *= 2.0;
        amplitude *= 0.5;
    }
    return value;
}

// Voronoi for rock cracks
float voronoi(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float minDist = 1.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 neighbor = vec2(float(x), float(y));
            vec2 point = hash(i + neighbor) * vec2(1.0);
            float d = length(neighbor + point - f);
            minDist = min(minDist, d);
        }
    }
    return minDist;
}

// Grass texture pattern
vec3 grassPattern(vec2 pos, vec3 baseColor) {
    // Multi-scale grass variation (reduced octaves for performance)
    float large = fbm(pos * 0.5, 2) * 0.15;
    float medium = fbm(pos * 2.0, 2) * 0.1;
    float small = fbm(pos * 8.0, 2) * 0.08;

    // Grass blade hints
    float blades = noise(pos * 15.0) * 0.05;

    // Color variation (yellow-green to dark green)
    vec3 lightGrass = baseColor * 1.15;
    vec3 darkGrass = baseColor * 0.85;
    float colorMix = fbm(pos * 1.5, 2);

    vec3 color = mix(darkGrass, lightGrass, colorMix);
    color *= (1.0 + large + medium + small + blades);

    return color;
}

// Dirt texture pattern - texture based
vec3 dirtPattern(vec2 uv, vec2 pos, vec3 baseColor) {
    vec3 texColor = texture2D(uDirtDiffuse, uv).rgb;
    
    // Add subtle color variation
    float variation = fbm(pos * 0.3, 2) * 0.1;
    texColor *= (0.95 + variation);
    
    return texColor;
}

// Get dirt normal from texture
vec3 getDirtNormal(vec2 uv) {
    vec3 normalTex = texture2D(uDirtNormal, uv).rgb;
    
    // Convert from [0,1] to [-1,1]
    vec3 n;
    n.x = (normalTex.r * 2.0 - 1.0) * uNormalStrength;
    n.y = (normalTex.g * 2.0 - 1.0) * uNormalStrength;
    n.z = normalTex.b;
    return normalize(n);
}

// Get height from dirt displacement map
float getDirtHeight(vec2 uv) {
    return texture2D(uDirtDisp, uv).r;
}

// Hash function that returns vec2 for variation
vec2 hash2(vec2 p) {
    return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}

// UV noise to break tiling pattern
// Returns distorted UV that varies smoothly across the terrain
vec2 getDistortedUV(vec2 pos) {
    vec2 baseUV = pos * uTextureScale;
    
    // Multi-frequency noise for natural-looking distortion
    vec2 noise1 = vec2(
        fbm(pos * 0.1, 2),
        fbm(pos * 0.1 + vec2(43.0, 17.0), 2)
    ) * 0.15;  // Low frequency, larger offset
    
    vec2 noise2 = vec2(
        noise(pos * 0.5),
        noise(pos * 0.5 + vec2(31.0, 23.0))
    ) * 0.05;  // Medium frequency, smaller offset
    
    // Apply distortion
    return baseUV + noise1 + noise2;
}

// =============================================================================
// HEX TILING SYSTEM
// Eliminates grid-like texture repetition by sampling from two overlapping
// grids with per-cell random UV rotation and smooth blending.
// Reference: "Procedural Stochastic Textures by Tiling and Blending" (2018)
// =============================================================================

struct HexUVData {
    vec2 uv1;      // Rotated UV from grid A
    vec2 uv2;      // Rotated UV from grid B
    float blend;   // 0.0 = uv2, 1.0 = uv1
    float rot1;    // Grid A rotation angle (for normal map correction)
    float rot2;    // Grid B rotation angle
};

float hexCellRand(vec2 cell) {
    return fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
}

HexUVData computeHexUV(vec2 uv) {
    HexUVData h;

    // Two overlapping grids offset by half cell create diamond/hex boundary
    // Grid A: cell centers at (n+0.5, m+0.5)
    // Grid B: cell centers at (n, m) — integers
    vec2 centerA = floor(uv) + 0.5;
    vec2 centerB = floor(uv + 0.5);

    // Squared distance to each cell center
    vec2 dA = uv - centerA;
    vec2 dB = uv - centerB;
    float distA = dot(dA, dA);
    float distB = dot(dB, dB);

    // Per-cell random rotation (full 360°)
    h.rot1 = hexCellRand(centerA) * 6.28318;
    h.rot2 = hexCellRand(centerB) * 6.28318;

    // Rotate UVs
    float c1 = cos(h.rot1), s1 = sin(h.rot1);
    float c2 = cos(h.rot2), s2 = sin(h.rot2);
    h.uv1 = vec2(uv.x * c1 - uv.y * s1, uv.x * s1 + uv.y * c1);
    h.uv2 = vec2(uv.x * c2 - uv.y * s2, uv.x * s2 + uv.y * c2);

    // Smooth blend: closer to grid A center → more weight on uv1
    h.blend = smoothstep(-0.12, 0.12, distB - distA);

    return h;
}

// Hex-tiled rock texture sampling (direct uniform access — no sampler2D params for WebGPU)
vec3 hexRockDiffuse(HexUVData h) {
    return mix(texture2D(uRockDiffuse, h.uv2).rgb, texture2D(uRockDiffuse, h.uv1).rgb, h.blend);
}

vec3 hexRockARM(HexUVData h) {
    return mix(texture2D(uRockARM, h.uv2).rgb, texture2D(uRockARM, h.uv1).rgb, h.blend);
}

float hexRockDisp(HexUVData h) {
    return mix(texture2D(uRockDisp, h.uv2).r, texture2D(uRockDisp, h.uv1).r, h.blend);
}

// Hex-tiled rock normal with tangent-space rotation correction
vec3 hexRockNormal(HexUVData h) {
    vec3 n1raw = texture2D(uRockNormal, h.uv1).rgb;
    vec3 n2raw = texture2D(uRockNormal, h.uv2).rgb;

    vec2 n1xy = (n1raw.rg * 2.0 - 1.0) * uNormalStrength;
    vec2 n2xy = (n2raw.rg * 2.0 - 1.0) * uNormalStrength;

    // Counter-rotate XY to undo UV rotation (rotate by -angle)
    float c1 = cos(h.rot1), s1 = sin(h.rot1);
    float c2 = cos(h.rot2), s2 = sin(h.rot2);
    vec2 n1r = vec2(n1xy.x * c1 + n1xy.y * s1, -n1xy.x * s1 + n1xy.y * c1);
    vec2 n2r = vec2(n2xy.x * c2 + n2xy.y * s2, -n2xy.x * s2 + n2xy.y * c2);

    vec3 n1 = vec3(n1r, n1raw.b);
    vec3 n2 = vec3(n2r, n2raw.b);
    return normalize(mix(n2, n1, h.blend));
}

// Hex-tiled grass texture sampling (direct uniform access — no sampler2D params for WebGPU)
vec3 hexGrassDiffuse(HexUVData h) {
    return mix(texture2D(uGrassDiffuse, h.uv2).rgb, texture2D(uGrassDiffuse, h.uv1).rgb, h.blend);
}

vec3 hexGrassARM(HexUVData h) {
    return mix(texture2D(uGrassARM, h.uv2).rgb, texture2D(uGrassARM, h.uv1).rgb, h.blend);
}

vec3 hexGrassNormal(HexUVData h) {
    vec3 n1raw = texture2D(uGrassNormal, h.uv1).rgb;
    vec3 n2raw = texture2D(uGrassNormal, h.uv2).rgb;

    vec2 n1xy = (n1raw.rg * 2.0 - 1.0) * uNormalStrength;
    vec2 n2xy = (n2raw.rg * 2.0 - 1.0) * uNormalStrength;

    // Counter-rotate XY to undo UV rotation (rotate by -angle)
    float c1 = cos(h.rot1), s1 = sin(h.rot1);
    float c2 = cos(h.rot2), s2 = sin(h.rot2);
    vec2 n1r = vec2(n1xy.x * c1 + n1xy.y * s1, -n1xy.x * s1 + n1xy.y * c1);
    vec2 n2r = vec2(n2xy.x * c2 + n2xy.y * s2, -n2xy.x * s2 + n2xy.y * c2);

    vec3 n1 = vec3(n1r, n1raw.b);
    vec3 n2 = vec3(n2r, n2raw.b);
    return normalize(mix(n2, n1, h.blend));
}

float hexGrassDisp(HexUVData h) {
    return mix(texture2D(uGrassDisp, h.uv2).r, texture2D(uGrassDisp, h.uv1).r, h.blend);
}

// Triplanar UV coordinates for steep surfaces
// Projects texture from X, Y, Z axes and blends based on normal direction
struct TriplanarUVs {
    vec2 uvX;  // YZ plane projection (for surfaces facing X)
    vec2 uvY;  // XZ plane projection (for surfaces facing Y - top/bottom)
    vec2 uvZ;  // XY plane projection (for surfaces facing Z)
    vec3 weights;  // Blend weights based on normal
};

TriplanarUVs calculateTriplanarUVs(vec3 worldPos, vec3 worldNormal, float scale) {
    TriplanarUVs result;
    
    // Calculate UVs for each projection plane
    result.uvX = worldPos.yz * scale;  // Project onto YZ plane
    result.uvY = worldPos.xz * scale;  // Project onto XZ plane (top-down)
    result.uvZ = worldPos.xy * scale;  // Project onto XY plane
    
    // Calculate blend weights from absolute normal components
    vec3 blendWeights = abs(worldNormal);
    
    // Sharpen the blend for more distinct transitions (power of 4)
    blendWeights = pow(blendWeights, vec3(4.0));
    
    // Normalize weights so they sum to 1
    float weightSum = blendWeights.x + blendWeights.y + blendWeights.z;
    result.weights = blendWeights / max(weightSum, 0.001);
    
    return result;
}

// Triplanar sampling functions for specific textures
// WebGPU/WGSL does not support passing samplers as function parameters,
// so we create specific functions for each texture

// Triplanar sample rock diffuse texture
vec3 sampleTriplanarRockDiffuse(TriplanarUVs uvs) {
    vec3 colX = texture2D(uRockDiffuse, uvs.uvX).rgb;
    vec3 colY = texture2D(uRockDiffuse, uvs.uvY).rgb;
    vec3 colZ = texture2D(uRockDiffuse, uvs.uvZ).rgb;

    return colX * uvs.weights.x + colY * uvs.weights.y + colZ * uvs.weights.z;
}

// Triplanar sample rock ARM texture
vec3 sampleTriplanarRockARM(TriplanarUVs uvs) {
    vec3 colX = texture2D(uRockARM, uvs.uvX).rgb;
    vec3 colY = texture2D(uRockARM, uvs.uvY).rgb;
    vec3 colZ = texture2D(uRockARM, uvs.uvZ).rgb;

    return colX * uvs.weights.x + colY * uvs.weights.y + colZ * uvs.weights.z;
}

// Triplanar sample rock displacement texture
float sampleTriplanarRockDisp(TriplanarUVs uvs) {
    float colX = texture2D(uRockDisp, uvs.uvX).r;
    float colY = texture2D(uRockDisp, uvs.uvY).r;
    float colZ = texture2D(uRockDisp, uvs.uvZ).r;

    return colX * uvs.weights.x + colY * uvs.weights.y + colZ * uvs.weights.z;
}

// Triplanar sample rock normal with proper tangent space handling
vec3 sampleTriplanarRockNormal(TriplanarUVs uvs, vec3 worldNormal, float strength) {
    // Sample normal maps for each projection
    vec3 normalX = texture2D(uRockNormal, uvs.uvX).rgb * 2.0 - 1.0;
    vec3 normalY = texture2D(uRockNormal, uvs.uvY).rgb * 2.0 - 1.0;
    vec3 normalZ = texture2D(uRockNormal, uvs.uvZ).rgb * 2.0 - 1.0;

    // Apply strength
    normalX.xy *= strength;
    normalY.xy *= strength;
    normalZ.xy *= strength;

    // Swizzle normals to match world space for each projection axis
    // X projection: tangent space (Y, Z) -> world space (Y, Z, X)
    vec3 worldNormalX = vec3(normalX.z, normalX.xy);
    // Y projection: tangent space (X, Z) -> world space (X, Z, Y) - top down
    vec3 worldNormalY = vec3(normalY.x, normalY.z, normalY.y);
    // Z projection: tangent space (X, Y) -> world space (X, Y, Z)
    vec3 worldNormalZ = vec3(normalZ.xy, normalZ.z);

    // Flip normals based on the sign of the geometry normal for each axis
    worldNormalX *= sign(worldNormal.x);
    worldNormalY *= sign(worldNormal.y);
    worldNormalZ *= sign(worldNormal.z);

    // Blend the normals
    vec3 blendedNormal = worldNormalX * uvs.weights.x +
                         worldNormalY * uvs.weights.y +
                         worldNormalZ * uvs.weights.z;

    return normalize(blendedNormal);
}

// =============================================================================
// MACRO VARIATION SYSTEM
// Eliminates large-scale tiling repetition through world-scale color/normal modulation
// =============================================================================

// Macro color variation - applies large-scale brightness/hue shifts
struct MacroVariation {
    float brightness;      // Overall brightness modifier (0.8 - 1.2)
    float saturation;      // Saturation modifier
    vec3 tint;             // Color tint for biome blending
    float normalStrength;  // How much to perturb macro normal
};

MacroVariation calculateMacroVariation(vec2 worldPos) {
    MacroVariation mv;
    
    // Very low frequency noise for large-scale variation (every 20-50 units)
    float macroNoise1 = fbm(worldPos * 0.02, 2);  // ~50 unit scale
    float macroNoise2 = fbm(worldPos * 0.05 + vec2(100.0, 50.0), 2);  // ~20 unit scale
    float macroNoise3 = fbm(worldPos * 0.03 + vec2(37.0, 89.0), 2);  // ~33 unit scale
    
    // Brightness variation: subtle darkening in some areas
    // Range: 0.85 - 1.1 (±15% variation)
    mv.brightness = 0.9 + macroNoise1 * 0.2;

    // Saturation variation: some areas more/less saturated
    // Range: 0.9 - 1.1
    mv.saturation = 0.95 + macroNoise2 * 0.15;
    
    // Color tint: very subtle hue shifts based on area
    // Simulates natural soil/grass variation across landscape
    float tintR = 1.0 + (macroNoise1 - 0.5) * 0.08;  // Slight red/cyan shift
    float tintG = 1.0 + (macroNoise2 - 0.5) * 0.06;  // Slight green/magenta shift  
    float tintB = 1.0 + (macroNoise3 - 0.5) * 0.04;  // Very subtle blue shift
    mv.tint = vec3(tintR, tintG, tintB);
    
    // Normal strength variation for macro bumps
    mv.normalStrength = macroNoise3 * 0.15;  // 0 - 0.15 range
    
    return mv;
}

// Apply macro variation to a color
vec3 applyMacroVariation(vec3 color, MacroVariation mv) {
    // Apply tint
    vec3 tinted = color * mv.tint;
    
    // Apply saturation
    float luminance = dot(tinted, vec3(0.299, 0.587, 0.114));
    vec3 saturated = mix(vec3(luminance), tinted, mv.saturation);
    
    // Apply brightness
    vec3 result = saturated * mv.brightness;
    
    return result;
}

// Calculate macro normal perturbation
// Creates very gentle undulations at world scale
vec3 calculateMacroNormal(vec2 worldPos, vec3 baseNormal, float strength) {
    if (strength < 0.001) return baseNormal;
    
    // Sample heights at offset positions for gradient
    float epsilon = 2.0;  // Large epsilon for macro scale
    
    // Use very low frequency noise as "macro heightmap"
    float h0 = fbm(worldPos * 0.015, 2);
    float hX = fbm((worldPos + vec2(epsilon, 0.0)) * 0.015, 2);
    float hZ = fbm((worldPos + vec2(0.0, epsilon)) * 0.015, 2);
    
    // Calculate gradient (slope in X and Z)
    float dX = (hX - h0) / epsilon;
    float dZ = (hZ - h0) / epsilon;
    
    // Create normal perturbation
    vec3 macroPerturbation = normalize(vec3(-dX * strength, 1.0, -dZ * strength));
    
    // Blend with base normal using reoriented normal mapping technique
    // This properly combines two normal vectors
    vec3 t = baseNormal + vec3(0.0, 1.0, 0.0);
    vec3 u = macroPerturbation * vec3(-1.0, -1.0, 1.0);
    vec3 result = normalize(t * dot(t, u) - u * t.y);
    
    return result;
}

// Rock texture pattern - simple texture sampling with normal map for depth illusion
vec3 rockPattern(vec2 uv, vec2 pos, vec3 baseColor) {
    vec3 texColor = texture2D(uRockDiffuse, uv).rgb;
    
    // Add subtle color variation
    float variation = fbm(pos * 0.3, 2) * 0.1;
    texColor *= (0.95 + variation);
    
    return texColor;
}

// Get rock normal from texture - enhanced normal strength for better depth perception
vec3 getRockNormal(vec2 uv) {
    vec3 normalTex = texture2D(uRockNormal, uv).rgb;
    
    // Convert from [0,1] to [-1,1]
    vec3 n;
    n.x = (normalTex.r * 2.0 - 1.0) * uNormalStrength;
    n.y = (normalTex.g * 2.0 - 1.0) * uNormalStrength;
    n.z = normalTex.b;  // Keep Z component mostly intact
    return normalize(n);
}

// Get height from displacement map for lighting enhancement
float getRockHeight(vec2 uv) {
    return texture2D(uRockDisp, uv).r;
}

// Get ARM values (AO, Roughness, Metallic)
vec3 getRockARM(vec2 uv) {
    return texture2D(uRockARM, uv).rgb;
}

// Sand texture pattern
vec3 sandPattern(vec2 pos, vec3 baseColor) {
    // Wind ripples (reduced octaves for performance)
    float ripples = sin(pos.x * 8.0 + fbm(pos * 2.0, 2) * 3.0) * 0.03;
    ripples += sin(pos.y * 6.0 + pos.x * 2.0) * 0.02;
    
    // Fine grain
    float grain = noise(pos * 50.0) * 0.03;
    float dunes = fbm(pos * 0.5, 2) * 0.1;
    
    // Slight color shift
    vec3 lightSand = baseColor * 1.1;
    vec3 shadowSand = baseColor * 0.9;
    float colorMix = fbm(pos * 1.0, 2);
    
    vec3 color = mix(shadowSand, lightSand, colorMix);
    color *= (1.0 + ripples + grain + dunes);
    
    return color;
}

void main() {
    // Sample splat map and water mask
    vec4 splat = texture2D(uSplatMap, vUV);
    float waterMaskValue = texture2D(uWaterMask, vUV).r;
    vec2 worldPos = vPosition.xz;

    // Debug render modes (early exit for basic modes)
    if (uDebugMode >= 1 && uDebugMode <= 7) {
        vec3 debugColor = vec3(0.5);

        if (uDebugMode == 1) {
            // Splatmap raw RGBA visualization
            debugColor = splat.rgb;
        } else if (uDebugMode == 2) {
            // Water mask visualization
            debugColor = vec3(waterMaskValue, waterMaskValue * 0.5, 1.0 - waterMaskValue);
        } else if (uDebugMode == 3) {
            // Grass weight (R channel)
            debugColor = vec3(0.0, splat.r, 0.0);
        } else if (uDebugMode == 4) {
            // Dirt weight (G channel)
            debugColor = vec3(splat.g * 0.6, splat.g * 0.4, splat.g * 0.2);
        } else if (uDebugMode == 5) {
            // Rock weight (B channel)
            debugColor = vec3(splat.b * 0.5, splat.b * 0.5, splat.b * 0.6);
        } else if (uDebugMode == 6) {
            // Sand weight (A channel)
            debugColor = vec3(splat.a * 0.9, splat.a * 0.8, splat.a * 0.5);
        } else if (uDebugMode == 7) {
            // Geometry normals (before any perturbation)
            debugColor = normalize(vNormal) * 0.5 + 0.5;
        }

        gl_FragColor = vec4(debugColor, 1.0);
        return;
    }

    // Debug modes 12-14 (basic info)
    if (uDebugMode >= 12 && uDebugMode <= 14) {
        vec3 debugColor = vec3(0.5);

        if (uDebugMode == 12) {
            // Height/depth visualization
            float normalizedHeight = (vHeight + 5.0) / 20.0;
            debugColor = vec3(normalizedHeight);
        } else if (uDebugMode == 13) {
            // Slope visualization
            debugColor = vec3(vSlope, 1.0 - vSlope, 0.0);
        } else if (uDebugMode == 14) {
            // UV visualization
            debugColor = vec3(vUV.x, vUV.y, 0.0);
        }

        gl_FragColor = vec4(debugColor, 1.0);
        return;
    }

    // Debug mode 19: WorldPos visualization - to check continuity across tiles
    if (uDebugMode == 19) {
        // Map worldPos to colors: x to red, z to green
        // worldPos is vec2(vPosition.x, vPosition.z)
        // Normalized by terrain size (64) for visibility
        // fract will show repeating pattern every 64 units
        float normalizedX = fract(worldPos.x / 64.0);
        float normalizedZ = fract(worldPos.y / 64.0);  // .y of worldPos = vPosition.z
        // Show as gradient: red=X, green=Z
        gl_FragColor = vec4(normalizedX, normalizedZ, 0.5, 1.0);
        return;
    }

    // Debug mode: disable splatmap (show uniform gray)
    if (uUseSplatMap < 0.5) {
        // Show debug gray color with basic lighting
        vec3 debugColor = vec3(0.5, 0.5, 0.55);
        float NdotL = max(dot(normalize(vNormal), uSunDirection), 0.0);
        float diffuse = NdotL * 0.6 + 0.4;
        vec3 color = debugColor * (uAmbientIntensity + diffuse * uSunColor);
        gl_FragColor = vec4(color, 1.0);
        return;
    }

    // Suppress grass in water areas, boost sand near water
    splat.r *= (1.0 - waterMaskValue);  // Reduce grass where water exists
    float sandBoost = smoothstep(0.0, 0.5, waterMaskValue) * 0.5;
    splat.a += sandBoost;  // Boost sand near water edges

    // Normalize splat weights to ensure they sum to 1.0
    float totalWeight = splat.r + splat.g + splat.b + splat.a;
    vec4 normalizedSplat = totalWeight > 0.0 ? splat / totalWeight : vec4(1.0, 0.0, 0.0, 0.0);

    // Calculate distorted UV for flat surfaces
    vec2 texUV = getDistortedUV(worldPos);

    // Compute hex tiling UVs for rock (eliminates grid repetition)
    HexUVData hexUV = computeHexUV(texUV);

    // Calculate triplanar UVs for steep surfaces (cliffs)
    vec3 geometryNormal = normalize(vNormal);
    TriplanarUVs triUVs = calculateTriplanarUVs(vPosition, geometryNormal, uTextureScale);
    
    // Triplanar blend factor: use triplanar on steep slopes (>0.7)
    // 0.5-0.7 = transition zone, >0.7 = full triplanar
    float triplanarBlend = smoothstep(0.5, 0.7, vSlope);

    // Generate detailed textures for each material
    vec3 grassColor = hexGrassDiffuse(hexUV) * (0.95 + fbm(worldPos * 0.3, 2) * 0.1);
    vec3 grassARM = hexGrassARM(hexUV);
    float grassAO = grassARM.r;
    float grassRoughness = grassARM.g;
    float grassHeight = hexGrassDisp(hexUV);
    vec3 dirtColor = dirtPattern(texUV, worldPos, uDirtColor);
    vec3 sandColor = sandPattern(worldPos, uSandColor);
    
    // Rock color: blend between hex-tiled planar and triplanar based on slope
    vec3 rockColorPlanar = hexRockDiffuse(hexUV) * (0.95 + fbm(worldPos * 0.3, 2) * 0.1);
    // Inline triplanar rock diffuse sampling (avoid function calls for WebGPU compatibility)
    vec3 rockColorTriplanar =
        texture2D(uRockDiffuse, triUVs.uvX).rgb * triUVs.weights.x +
        texture2D(uRockDiffuse, triUVs.uvY).rgb * triUVs.weights.y +
        texture2D(uRockDiffuse, triUVs.uvZ).rgb * triUVs.weights.z;
    // Add subtle variation to triplanar rock
    float triVariation = fbm(worldPos * 0.3, 2) * 0.1;
    rockColorTriplanar *= (0.95 + triVariation);
    vec3 rockColor = mix(rockColorPlanar, rockColorTriplanar, triplanarBlend);

    // Get texture data for rock (blend planar/triplanar for ARM as well)
    vec3 rockARMPlanar = hexRockARM(hexUV);
    // Inline triplanar rock ARM sampling
    vec3 rockARMTriplanar =
        texture2D(uRockARM, triUVs.uvX).rgb * triUVs.weights.x +
        texture2D(uRockARM, triUVs.uvY).rgb * triUVs.weights.y +
        texture2D(uRockARM, triUVs.uvZ).rgb * triUVs.weights.z;
    vec3 rockARM = mix(rockARMPlanar, rockARMTriplanar, triplanarBlend);
    float rockAO = rockARM.r;
    float rockRoughness = rockARM.g;
    // float rockMetallic = rockARM.b;  // Not used for rock (non-metallic)

    // Dirt height (planar only - dirt doesn't appear on steep slopes)
    float dirtHeight = getDirtHeight(texUV);

    // Rock height: blend planar/triplanar
    float rockHeightPlanar = hexRockDisp(hexUV);
    // Inline triplanar rock displacement sampling
    float rockHeightTriplanar =
        texture2D(uRockDisp, triUVs.uvX).r * triUVs.weights.x +
        texture2D(uRockDisp, triUVs.uvY).r * triUVs.weights.y +
        texture2D(uRockDisp, triUVs.uvZ).r * triUVs.weights.z;
    float rockHeight = mix(rockHeightPlanar, rockHeightTriplanar, triplanarBlend);

    // Blend materials based on normalized splat map weights
    vec3 baseColor = grassColor * normalizedSplat.r +
                     dirtColor * normalizedSplat.g +
                     rockColor * normalizedSplat.b +
                     sandColor * normalizedSplat.a;

    // Auto-blend rock on steep slopes - DISABLED (rock only from splatmap painting)
    float slopeBlend = 0.0;
    
    // Add height-based color variation
    float heightBlend = smoothstep(-2.0, 15.0, vHeight);
    baseColor = mix(baseColor * 0.92, baseColor * 1.08, heightBlend);
    
    // ==========================================================
    // MACRO VARIATION: Apply large-scale color/brightness variation
    // This breaks up tiling patterns at world scale
    // ==========================================================
    MacroVariation macroVar = calculateMacroVariation(worldPos);
    baseColor = applyMacroVariation(baseColor, macroVar);

    // Lighting - apply normal maps for textured materials
    
    // Get tangent-space normals from textures (planar)
    vec3 rockNormalPlanar = hexRockNormal(hexUV);
    vec3 dirtNormalTex = getDirtNormal(texUV);
    vec3 grassNormalTex = hexGrassNormal(hexUV);

    // Inline triplanar normal sampling for rock on steep surfaces (WebGPU compatibility)
    vec3 triNormalX = texture2D(uRockNormal, triUVs.uvX).rgb * 2.0 - 1.0;
    vec3 triNormalY = texture2D(uRockNormal, triUVs.uvY).rgb * 2.0 - 1.0;
    vec3 triNormalZ = texture2D(uRockNormal, triUVs.uvZ).rgb * 2.0 - 1.0;
    triNormalX.xy *= uNormalStrength;
    triNormalY.xy *= uNormalStrength;
    triNormalZ.xy *= uNormalStrength;
    // Swizzle normals to match world space for each projection axis
    vec3 worldNormalX = vec3(triNormalX.z, triNormalX.xy) * sign(geometryNormal.x);
    vec3 worldNormalY = vec3(triNormalY.x, triNormalY.z, triNormalY.y) * sign(geometryNormal.y);
    vec3 worldNormalZ = vec3(triNormalZ.xy, triNormalZ.z) * sign(geometryNormal.z);
    vec3 rockNormalTriplanar = normalize(
        worldNormalX * triUVs.weights.x +
        worldNormalY * triUVs.weights.y +
        worldNormalZ * triUVs.weights.z
    );
    
    // Transform planar normals from tangent space to world space using TBN matrix
    vec3 rockPerturbedPlanar = vTBN * rockNormalPlanar;
    vec3 dirtPerturbedNormal = vTBN * dirtNormalTex;
    vec3 grassPerturbedNormal = vTBN * grassNormalTex;

    // Blend planar/triplanar rock normal based on slope
    vec3 rockPerturbedNormal = mix(rockPerturbedPlanar, rockNormalTriplanar, triplanarBlend);

    // Blend normals based on material weights
    float rockWeight = clamp(normalizedSplat.b, 0.0, 1.0);
    float dirtWeight = normalizedSplat.g;
    float grassWeight = normalizedSplat.r;

    // Combine perturbed normals
    vec3 perturbedNormal = normalize(
        geometryNormal * (1.0 - rockWeight - dirtWeight - grassWeight) +
        rockPerturbedNormal * rockWeight +
        dirtPerturbedNormal * dirtWeight +
        grassPerturbedNormal * grassWeight
    );
    
    // Apply macro normal variation for world-scale undulations
    vec3 normal = calculateMacroNormal(worldPos, perturbedNormal, macroVar.normalStrength);

    // Debug modes 8-11 (normal/AO/macro related - need computed values)
    if (uDebugMode >= 8 && uDebugMode <= 11) {
        vec3 debugColor = vec3(0.5);

        if (uDebugMode == 8) {
            // Normal map detail (tangent space normals from rock texture)
            debugColor = rockNormalPlanar * 0.5 + 0.5;
        } else if (uDebugMode == 9) {
            // Final perturbed normals (after all blending and macro)
            debugColor = normalize(normal) * 0.5 + 0.5;
        } else if (uDebugMode == 10) {
            // Rock AO texture
            debugColor = vec3(rockAO);
        } else if (uDebugMode == 11) {
            // Macro variation (brightness)
            debugColor = vec3(macroVar.brightness);
        }

        gl_FragColor = vec4(debugColor, 1.0);
        return;
    }

    // Enhanced lighting using ARM texture
    float NdotL = max(dot(normal, uSunDirection), 0.0);

    // Soft diffuse with wrap lighting
    float diffuse = NdotL * 0.6 + 0.4;

    // Subtle rim lighting
    float rim = 1.0 - max(dot(normal, vViewDirection), 0.0);
    rim = pow(rim, 4.0) * 0.1;

    // Specular - roughness controls shininess (lower roughness = shinier)
    vec3 halfVector = normalize(uSunDirection + vViewDirection);
    float NdotH = max(dot(normal, halfVector), 0.0);

    // Rock specular (from rock ARM roughness)
    float rockSmoothness = 1.0 - rockRoughness;
    float rockSpecPower = mix(16.0, 128.0, rockSmoothness);
    float rockSpecIntensity = mix(0.02, 0.15, rockSmoothness);
    float rockSpecular = pow(NdotH, rockSpecPower) * rockSpecIntensity;

    // Grass specular (from grass ARM roughness)
    float grassSmoothness = 1.0 - grassRoughness;
    float grassSpecPower = mix(16.0, 128.0, grassSmoothness);
    float grassSpecIntensity = mix(0.02, 0.15, grassSmoothness);
    float grassSpecular = pow(NdotH, grassSpecPower) * grassSpecIntensity;

    // Blend specular by material weight
    float specular = rockSpecular * rockWeight + grassSpecular * grassWeight;

    // Ambient occlusion - combine geometric AO with texture-based AO
    float geometricAO = 0.8 + 0.2 * smoothstep(-5.0, 10.0, vHeight);
    geometricAO *= (1.0 - vSlope * 0.25);
    // Blend in texture AO for rock/grass areas (texture AO provides crevice detail)
    float ao = geometricAO * mix(1.0, rockAO, rockWeight) * mix(1.0, grassAO, grassWeight);

    // Debug modes 15-18 (lighting related)
    if (uDebugMode >= 15 && uDebugMode <= 18) {
        vec3 debugColor = vec3(0.5);

        if (uDebugMode == 15) {
            // Diffuse lighting only
            debugColor = vec3(diffuse);
        } else if (uDebugMode == 16) {
            // Specular highlight only (amplified for visibility)
            debugColor = vec3(specular * 10.0);
        } else if (uDebugMode == 17) {
            // Ambient occlusion
            debugColor = vec3(ao);
        } else if (uDebugMode == 18) {
            // Base color before lighting
            debugColor = baseColor;
        }

        gl_FragColor = vec4(debugColor, 1.0);
        return;
    }

    // Final color composition
    vec3 color = baseColor * ao * (uAmbientIntensity + diffuse * uSunColor) + specular * uSunColor + rim;

    // ========== Improved Fog System ==========
    // 1. Calculate distance from fragment's world position to camera (per-pixel)
    float distanceToCamera = length(vPosition - cameraPosition);

    // 2. Distance fog (exponential squared)
    float distanceFog = 1.0 - exp(-uFogDensity * uFogDensity * distanceToCamera * distanceToCamera);

    // 3. Height fog (concentrate fog at lower altitudes)
    float heightFactor = exp(-max(0.0, vPosition.y - uFogHeightFalloff) * uFogHeightDensity);
    float heightFog = heightFactor * 0.15 * smoothstep(0.0, 30.0, distanceToCamera);

    // 4. Final fog factor
    float fogFactor = clamp(distanceFog + heightFog, 0.0, 1.0);

    // 5. Apply fog
    color = mix(color, uFogColor, fogFactor);

    // Tone mapping and gamma
    color = color / (color + vec3(1.0)) * 1.1; // Simple Reinhard
    color = pow(color, vec3(0.95));

    // Wet sand/shore effect - only apply near actual water (where water mask exists)
    // This prevents the wet effect from applying to all terrain at similar heights
    if (waterMaskValue > 0.1) {
        float heightAboveWater = vHeight - uWaterLevel;
        float wetZoneHeight = 0.5; // How high above water the wet effect extends
        if (heightAboveWater > 0.0 && heightAboveWater < wetZoneHeight) {
            // Calculate wetness factor (1.0 at water level, 0.0 at top of wet zone)
            float wetness = 1.0 - (heightAboveWater / wetZoneHeight);
            wetness = pow(wetness, 0.7); // Non-linear falloff for more natural look
            wetness *= waterMaskValue; // Scale by water mask proximity

            // Wet terrain is darker and more saturated
            color *= mix(1.0, 0.7, wetness);

            // Add slight specular/sheen to wet areas
            vec3 viewDir = vViewDirection;  // Already normalized in vertex shader
            vec3 lightDir = normalize(vec3(0.5, 0.8, 0.3));
            vec3 halfVec = normalize(viewDir + lightDir);
            float wetSpecular = pow(max(dot(vNormal, halfVec), 0.0), 32.0);
            color += vec3(0.1, 0.12, 0.15) * wetSpecular * wetness * 0.3;
        }
    }

    // Underwater effect - only apply where water actually exists
    if (waterMaskValue > 0.1) {
        float underwaterDepth = uWaterLevel - vHeight;
        if (underwaterDepth > 0.0) {
            // Calculate how deep underwater (0 = at surface, 1 = fully submerged)
            float depthFactor = clamp(underwaterDepth / 4.0, 0.0, 1.0);
            depthFactor *= waterMaskValue; // Scale by water mask

            // Underwater tint (blue-green)
            vec3 underwaterColor = vec3(0.1, 0.3, 0.4);
            color = mix(color, underwaterColor, depthFactor * 0.6);

            // Caustics effect (animated light patterns)
            vec2 causticUV = vPosition.xz * 0.15;
            float caustic1 = sin(causticUV.x * 3.0 + uTime * 0.8) * cos(causticUV.y * 2.5 + uTime * 0.6);
            float caustic2 = sin(causticUV.x * 2.0 - uTime * 0.5) * cos(causticUV.y * 3.5 + uTime * 0.9);
            float caustics = (caustic1 + caustic2) * 0.5 + 0.5;
            caustics = pow(caustics, 2.0) * 0.3;

            // Caustics fade with depth (stronger near surface)
            float causticFade = 1.0 - depthFactor;
            color += vec3(caustics * causticFade * 0.15);

            // Reduce saturation underwater
            float gray = dot(color, vec3(0.299, 0.587, 0.114));
            color = mix(color, vec3(gray), depthFactor * 0.3);
        }
    }

    gl_FragColor = vec4(color, 1.0);
}
`;

// Counter for unique material IDs
let terrainMaterialCounter = 0;

export function createTerrainMaterial(scene: Scene, splatData: Float32Array, resolution: number): ShaderMaterial {
  console.log("[TerrainShader] Creating terrain shader material...");

  // Use unique name to prevent any caching issues
  const uniqueName = `terrainShader_${++terrainMaterialCounter}_${Date.now()}`;
  const material = new ShaderMaterial(
    uniqueName,
    scene,
    {
      vertex: "terrain",
      fragment: "terrain",
    },
    {
      attributes: ["position", "normal", "uv"],
      uniforms: [
        "worldViewProjection",
        "world",
        "cameraPosition",
        "uSunDirection",
        "uSunColor",
        "uAmbientIntensity",
        "uTerrainSize",
        "uGrassColor",
        "uDirtColor",
        "uRockColor",
        "uSandColor",
        "uTextureScale",
        "uNormalStrength",
        "uDispStrength",
        "uFogColor",
        "uFogDensity",
        "uFogStart",
        "uFogHeightFalloff",
        "uFogHeightDensity",
        "uWaterLevel",
        "uTime",
        "uUseSplatMap",
        "uDebugMode",
      ],
      samplers: [
        "uSplatMap",
        "uWaterMask",
        "uRockDiffuse",
        "uRockNormal",
        "uRockDisp",
        "uRockARM",
        "uDirtDiffuse",
        "uDirtNormal",
        "uDirtDisp",
        "uGrassDiffuse",
        "uGrassNormal",
        "uGrassARM",
        "uGrassDisp",
      ],
    }
  );

  // Create splat map texture
  const splatTexture = createSplatTexture(scene, splatData, resolution);

  // Set uniforms
  material.setVector3("uSunDirection", new Vector3(0.5, 0.8, 0.3).normalize());
  material.setColor3("uSunColor", new Color3(1.0, 0.95, 0.85));
  material.setFloat("uAmbientIntensity", 0.4);
  material.setTexture("uSplatMap", splatTexture);
  material.setFloat("uTerrainSize", 64);

  // Material colors - fallback for procedural patterns
  material.setColor3("uGrassColor", new Color3(0.4, 0.6, 0.25));   // Bright green grass
  material.setColor3("uDirtColor", new Color3(0.52, 0.42, 0.28));  // Warm brown dirt
  material.setColor3("uRockColor", new Color3(0.48, 0.48, 0.5));   // Gray rock (fallback)
  material.setColor3("uSandColor", new Color3(0.82, 0.72, 0.52));  // Warm sandy yellow

  // Load rock textures (supports KTX2 when available)
  material.setTexture("uRockDiffuse", loadTextureWithKTX2Fallback("/textures/rock_diff", scene, "jpg"));
  material.setTexture("uRockNormal", loadTextureWithKTX2Fallback("/textures/rock_nor", scene, "jpg"));
  material.setTexture("uRockDisp", loadTextureWithKTX2Fallback("/textures/rock_disp", scene, "jpg"));
  material.setTexture("uRockARM", loadTextureWithKTX2Fallback("/textures/rock_arm", scene, "jpg"));

  // Load dirt textures (dry mud)
  material.setTexture("uDirtDiffuse", loadTextureWithKTX2Fallback("/textures/dirt_diffuse", scene, "jpg"));
  material.setTexture("uDirtNormal", loadTextureWithKTX2Fallback("/textures/dirt_normal", scene, "jpg"));
  material.setTexture("uDirtDisp", loadTextureWithKTX2Fallback("/textures/dirt_disp", scene, "jpg"));

  // Load grass textures (coastal grass)
  material.setTexture("uGrassDiffuse", loadTextureWithKTX2Fallback("/textures/grass_diff", scene, "jpg"));
  material.setTexture("uGrassNormal", loadTextureWithKTX2Fallback("/textures/grass_nor", scene, "jpg"));
  material.setTexture("uGrassARM", loadTextureWithKTX2Fallback("/textures/grass_arm", scene, "jpg"));
  material.setTexture("uGrassDisp", loadTextureWithKTX2Fallback("/textures/grass_disp", scene, "jpg"));

  // Texture tiling scale (higher = smaller texture, more repeats)
  material.setFloat("uTextureScale", 1.0);  // 1.0 = texture repeats every 1 world unit (matches original texture size)
  material.setFloat("uNormalStrength", 1.5);  // Normal map intensity (1.0 = standard, higher = more depth)
  material.setFloat("uDispStrength", 0.2);  // Vertex displacement strength for rock areas

  // Fog settings
  material.setColor3("uFogColor", new Color3(0.6, 0.75, 0.9));
  material.setFloat("uFogDensity", 0.008);
  material.setFloat("uFogStart", 50);
  material.setFloat("uFogHeightFalloff", 5.0);    // Height fog starts below this altitude
  material.setFloat("uFogHeightDensity", 0.1);    // Height fog decay rate

  // Water/underwater settings
  material.setFloat("uWaterLevel", -100);  // Default below terrain, updated by EditorEngine when water is active
  material.setFloat("uTime", 0);

  // Debug settings
  material.setFloat("uUseSplatMap", 1.0);  // Default: splatmap enabled
  material.setInt("uDebugMode", 0);  // Default: normal rendering

  material.backFaceCulling = false;

  // Check for shader compilation errors
  material.onError = (effect, errors) => {
    console.error("[TerrainShader] Shader compilation error:", errors);
  };

  // Bind camera position on each render
  material.onBindObservable.add((mesh) => {
    const camera = scene.activeCamera;
    if (camera) {
      material.setVector3("cameraPosition", camera.position);
    }
  });

  console.log("[TerrainShader] Shader material created");
  return material;
}

// Counter for unique texture IDs
let splatTextureCounter = 0;

export function createSplatTexture(scene: Scene, splatData: Float32Array, resolution: number): RawTexture {
  // Convert Float32 RGBA to Uint8 RGBA
  const uint8Data = new Uint8Array(resolution * resolution * 4);
  for (let i = 0; i < resolution * resolution * 4; i++) {
    uint8Data[i] = Math.floor(splatData[i] * 255);
  }

  const texture = new RawTexture(
    uint8Data,
    resolution,
    resolution,
    Engine.TEXTUREFORMAT_RGBA,
    scene,
    false,
    false,
    Texture.BILINEAR_SAMPLINGMODE
  );

  // Give unique name to prevent any caching issues
  texture.name = `splatTexture_${++splatTextureCounter}_${Date.now()}`;
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;

  // Force immediate GPU upload
  texture.update(uint8Data);

  return texture;
}

export function updateSplatTexture(texture: RawTexture, splatData: Float32Array, resolution: number): void {
  const uint8Data = new Uint8Array(resolution * resolution * 4);
  for (let i = 0; i < resolution * resolution * 4; i++) {
    uint8Data[i] = Math.floor(splatData[i] * 255);
  }
  texture.update(uint8Data);
}
