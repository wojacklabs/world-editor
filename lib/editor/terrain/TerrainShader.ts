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
    // Sample splat map to get rock weight (blue channel)
    vec4 splat = texture2D(uSplatMap, uv);
    float rockWeight = splat.b;
    
    // Calculate texture UV for displacement sampling (same as fragment shader)
    vec2 texUV = position.xz * uTextureScale;
    
    // Sample displacement map
    float dispValue = texture2D(uRockDisp, texUV).r;
    
    // Apply displacement only for rock areas
    // dispValue is 0-1, center at 0.5 for balanced displacement
    float displacement = (dispValue - 0.5) * uDispStrength * rockWeight;
    
    vec3 displacedPosition = position + vec3(0.0, displacement, 0.0);
    
    vec4 worldPosition = world * vec4(displacedPosition, 1.0);
    gl_Position = worldViewProjection * vec4(displacedPosition, 1.0);

    vPosition = worldPosition.xyz;
    vNormal = normalize(mat3(world) * normal);
    vUV = uv;
    vHeight = displacedPosition.y;

    vec3 toCamera = cameraPosition - worldPosition.xyz;
    vCameraDistance = length(toCamera);
    vViewDirection = normalize(toCamera);

    // Calculate slope (0 = flat, 1 = vertical)
    vSlope = 1.0 - abs(dot(vec3(0.0, 1.0, 0.0), vNormal));
    
    // Build TBN matrix for tangent space calculations
    // For terrain on XZ plane: tangent = X, bitangent = Z, normal = Y
    vec3 T = normalize(mat3(world) * vec3(1.0, 0.0, 0.0));
    vec3 B = normalize(mat3(world) * vec3(0.0, 0.0, 1.0));
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
uniform float uTerrainSize;

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
uniform float uTextureScale;
uniform float uNormalStrength;

// Fog
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogStart;

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

// Sample texture using triplanar mapping
vec4 sampleTriplanar(sampler2D tex, TriplanarUVs uvs) {
    vec4 colX = texture2D(tex, uvs.uvX);
    vec4 colY = texture2D(tex, uvs.uvY);
    vec4 colZ = texture2D(tex, uvs.uvZ);
    
    return colX * uvs.weights.x + colY * uvs.weights.y + colZ * uvs.weights.z;
}

// Sample normal map using triplanar mapping with proper tangent space handling
vec3 sampleTriplanarNormal(sampler2D normalTex, TriplanarUVs uvs, vec3 worldNormal, float strength) {
    // Sample normal maps for each projection
    vec3 normalX = texture2D(normalTex, uvs.uvX).rgb * 2.0 - 1.0;
    vec3 normalY = texture2D(normalTex, uvs.uvY).rgb * 2.0 - 1.0;
    vec3 normalZ = texture2D(normalTex, uvs.uvZ).rgb * 2.0 - 1.0;
    
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
    // Sample splat map
    vec4 splat = texture2D(uSplatMap, vUV);
    vec2 worldPos = vPosition.xz;

    // Normalize splat weights to ensure they sum to 1.0
    float totalWeight = splat.r + splat.g + splat.b + splat.a;
    vec4 normalizedSplat = totalWeight > 0.0 ? splat / totalWeight : vec4(1.0, 0.0, 0.0, 0.0);

    // Calculate distorted UV for flat surfaces
    vec2 texUV = getDistortedUV(worldPos);
    
    // Calculate triplanar UVs for steep surfaces (cliffs)
    vec3 geometryNormal = normalize(vNormal);
    TriplanarUVs triUVs = calculateTriplanarUVs(vPosition, geometryNormal, uTextureScale);
    
    // Triplanar blend factor: use triplanar on steep slopes (>0.7)
    // 0.5-0.7 = transition zone, >0.7 = full triplanar
    float triplanarBlend = smoothstep(0.5, 0.7, vSlope);

    // Generate detailed textures for each material
    vec3 grassColor = grassPattern(worldPos, uGrassColor);
    vec3 dirtColor = dirtPattern(texUV, worldPos, uDirtColor);
    vec3 sandColor = sandPattern(worldPos, uSandColor);
    
    // Rock color: blend between planar and triplanar based on slope
    vec3 rockColorPlanar = rockPattern(texUV, worldPos, uRockColor);
    vec3 rockColorTriplanar = sampleTriplanar(uRockDiffuse, triUVs).rgb;
    // Add subtle variation to triplanar rock
    float triVariation = fbm(worldPos * 0.3, 2) * 0.1;
    rockColorTriplanar *= (0.95 + triVariation);
    vec3 rockColor = mix(rockColorPlanar, rockColorTriplanar, triplanarBlend);
    
    // Get texture data for rock (blend planar/triplanar for ARM as well)
    vec3 rockARMPlanar = getRockARM(texUV);
    vec3 rockARMTriplanar = sampleTriplanar(uRockARM, triUVs).rgb;
    vec3 rockARM = mix(rockARMPlanar, rockARMTriplanar, triplanarBlend);
    float rockAO = rockARM.r;
    float rockRoughness = rockARM.g;
    // float rockMetallic = rockARM.b;  // Not used for rock (non-metallic)
    
    // Dirt height (planar only - dirt doesn't appear on steep slopes)
    float dirtHeight = getDirtHeight(texUV);
    
    // Rock height: blend planar/triplanar
    float rockHeightPlanar = getRockHeight(texUV);
    float rockHeightTriplanar = sampleTriplanar(uRockDisp, triUVs).r;
    float rockHeight = mix(rockHeightPlanar, rockHeightTriplanar, triplanarBlend);

    // Blend materials based on normalized splat map weights
    vec3 baseColor = grassColor * normalizedSplat.r +
                     dirtColor * normalizedSplat.g +
                     rockColor * normalizedSplat.b +
                     sandColor * normalizedSplat.a;

    // Auto-blend rock on steep slopes
    float slopeBlend = smoothstep(0.4, 0.7, vSlope);
    baseColor = mix(baseColor, rockColor * 0.85, slopeBlend * 0.5);
    
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
    vec3 rockNormalPlanar = getRockNormal(texUV);
    vec3 dirtNormalTex = getDirtNormal(texUV);
    
    // Get triplanar normal for rock on steep surfaces
    vec3 rockNormalTriplanar = sampleTriplanarNormal(uRockNormal, triUVs, geometryNormal, uNormalStrength);
    
    // Transform planar normals from tangent space to world space using TBN matrix
    vec3 rockPerturbedPlanar = vTBN * rockNormalPlanar;
    vec3 dirtPerturbedNormal = vTBN * dirtNormalTex;
    
    // Blend planar/triplanar rock normal based on slope
    vec3 rockPerturbedNormal = mix(rockPerturbedPlanar, rockNormalTriplanar, triplanarBlend);
    
    // Blend normals based on material weights
    float rockWeight = normalizedSplat.b + slopeBlend * 0.5;
    rockWeight = clamp(rockWeight, 0.0, 1.0);
    float dirtWeight = normalizedSplat.g;
    
    // Combine perturbed normals
    vec3 perturbedNormal = normalize(
        geometryNormal * (1.0 - rockWeight - dirtWeight) +
        rockPerturbedNormal * rockWeight +
        dirtPerturbedNormal * dirtWeight
    );
    
    // Apply macro normal variation for world-scale undulations
    vec3 normal = calculateMacroNormal(worldPos, perturbedNormal, macroVar.normalStrength);
    
    // Enhanced lighting using ARM texture
    float NdotL = max(dot(normal, uSunDirection), 0.0);

    // Soft diffuse with wrap lighting
    float diffuse = NdotL * 0.6 + 0.4;

    // Subtle rim lighting
    float rim = 1.0 - max(dot(normal, vViewDirection), 0.0);
    rim = pow(rim, 4.0) * 0.1;

    // Specular - roughness controls shininess (lower roughness = shinier)
    vec3 halfVector = normalize(uSunDirection + vViewDirection);
    float smoothness = 1.0 - rockRoughness;  // Convert roughness to smoothness
    float specPower = mix(16.0, 128.0, smoothness);  // Rougher = wider highlight
    float specIntensity = mix(0.02, 0.15, smoothness);  // Rougher = dimmer highlight
    float specular = pow(max(dot(normal, halfVector), 0.0), specPower) * specIntensity;
    // Apply specular only for rock areas
    specular *= rockWeight;

    // Ambient occlusion - combine geometric AO with texture-based AO
    float geometricAO = 0.8 + 0.2 * smoothstep(-5.0, 10.0, vHeight);
    geometricAO *= (1.0 - vSlope * 0.25);
    // Blend in texture AO for rock areas (texture AO provides crevice detail)
    float ao = mix(geometricAO, geometricAO * rockAO, rockWeight);

    // Final color composition
    vec3 color = baseColor * (uAmbientIntensity + diffuse * uSunColor) * ao;
    color += specular * uSunColor;
    color += rim * uSunColor * 0.3;

    // Fog
    float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vCameraDistance * vCameraDistance);
    fogFactor = clamp(fogFactor, 0.0, 1.0);
    color = mix(color, uFogColor, fogFactor);

    // Tone mapping and gamma
    color = color / (color + vec3(1.0)) * 1.1; // Simple Reinhard
    color = pow(color, vec3(0.95));

    gl_FragColor = vec4(color, 1.0);
}
`;

export function createTerrainMaterial(scene: Scene, splatData: Float32Array, resolution: number): ShaderMaterial {
  console.log("[TerrainShader] Creating terrain shader material...");
  
  const material = new ShaderMaterial(
    "terrainShader",
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
      ],
      samplers: [
        "uSplatMap",
        "uRockDiffuse",
        "uRockNormal",
        "uRockDisp",
        "uRockARM",
        "uDirtDiffuse",
        "uDirtNormal",
        "uDirtDisp",
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

  // Texture tiling scale (higher = smaller texture, more repeats)
  material.setFloat("uTextureScale", 1.0);  // 1.0 = texture repeats every 1 world unit (matches original texture size)
  material.setFloat("uNormalStrength", 1.5);  // Normal map intensity (1.0 = standard, higher = more depth)
  material.setFloat("uDispStrength", 0.5);  // Vertex displacement strength for rock areas

  // Fog settings
  material.setColor3("uFogColor", new Color3(0.6, 0.75, 0.9));
  material.setFloat("uFogDensity", 0.008);
  material.setFloat("uFogStart", 50);

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

  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;

  return texture;
}

export function updateSplatTexture(texture: RawTexture, splatData: Float32Array, resolution: number): void {
  const uint8Data = new Uint8Array(resolution * resolution * 4);
  for (let i = 0; i < resolution * resolution * 4; i++) {
    uint8Data[i] = Math.floor(splatData[i] * 255);
  }
  texture.update(uint8Data);
}
