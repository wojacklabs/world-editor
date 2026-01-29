import {
  Scene,
  Mesh,
  MeshBuilder,
  ShaderMaterial,
  Vector3,
  Vector2,
  Color3,
  Effect,
  Observer,
} from "@babylonjs/core";

// Register sky shaders with integrated procedural clouds
Effect.ShadersStore["proceduralSkyVertexShader"] = `
precision highp float;

attribute vec3 position;

uniform mat4 worldViewProjection;

varying vec3 vWorldPosition;
varying vec3 vViewDirection;

void main() {
    vWorldPosition = position;
    vViewDirection = normalize(position);
    gl_Position = worldViewProjection * vec4(position, 1.0);
}
`;

Effect.ShadersStore["proceduralSkyFragmentShader"] = `
precision highp float;

varying vec3 vWorldPosition;
varying vec3 vViewDirection;

uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uTimeOfDay;
uniform float uCloudCoverage;
uniform float uHazeIntensity;
uniform float uNightFactor;
uniform vec2 uWindOffset;
uniform float uCloudTime;
uniform float uPrecipitationIntensity; // 0 = clear, 1 = heavy rain/snow

// Atmospheric scattering constants - enhanced for vivid blue sky
const vec3 RAYLEIGH_COEFF = vec3(3.8e-6, 13.5e-6, 33.0e-6); // More blue scattering
const float MIE_COEFF = 15e-6; // Reduced haze scattering
const float MIE_G = 0.80; // Tighter sun glow

// ========== NOISE FUNCTIONS ==========

// Hash functions for noise
float hash(float n) {
    return fract(sin(n) * 43758.5453123);
}

float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

vec2 hash22(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
}

vec3 hash33(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
             dot(p, vec3(269.5, 183.3, 246.1)),
             dot(p, vec3(113.5, 271.9, 124.6)));
    return fract(sin(p) * 43758.5453123);
}

// Simplex-like gradient noise (2D)
float gradientNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);

    float a = hash2(i);
    float b = hash2(i + vec2(1.0, 0.0));
    float c = hash2(i + vec2(0.0, 1.0));
    float d = hash2(i + vec2(1.0, 1.0));

    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Worley/Voronoi noise for cloud cell distribution
// Returns (distance to closest, distance to second closest)
vec2 worleyNoise(vec2 p, float cellSize) {
    p /= cellSize;
    vec2 i = floor(p);
    vec2 f = fract(p);

    float d1 = 1.0; // Distance to closest
    float d2 = 1.0; // Distance to second closest

    // Check 3x3 neighborhood
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 neighbor = vec2(float(x), float(y));
            vec2 cellId = i + neighbor;

            // Random point within cell (offset from cell corner)
            vec2 randomOffset = hash22(cellId);
            vec2 pointPos = neighbor + randomOffset - f;

            float dist = length(pointPos);

            if (dist < d1) {
                d2 = d1;
                d1 = dist;
            } else if (dist < d2) {
                d2 = dist;
            }
        }
    }

    return vec2(d1, d2);
}

// FBM (Fractal Brownian Motion) using gradient noise
float fbm(vec2 p, int octaves) {
    float value = 0.0;
    float amplitude = 0.5;
    float frequency = 1.0;
    float maxValue = 0.0;

    for (int i = 0; i < 6; i++) {
        if (i >= octaves) break;
        value += amplitude * gradientNoise(p * frequency);
        maxValue += amplitude;
        amplitude *= 0.5;
        frequency *= 2.0;
    }

    return value / maxValue;
}

// ========== CLOUD RENDERING ==========

// Project sky direction to cloud plane UV
vec2 getCloudUV(vec3 viewDir) {
    // Only render clouds above horizon
    if (viewDir.y <= 0.02) return vec2(-999.0);

    // Project onto a virtual dome at a fixed height
    // Use spherical projection for natural look
    float cloudHeight = 0.35; // Relative height on sky dome
    float scale = cloudHeight / max(viewDir.y, 0.1);

    vec2 uv = viewDir.xz * scale;
    return uv * 0.8; // Scale factor for cloud density
}

// Multi-scale Worley with size variation
// Returns density contribution for a single cloud layer with random size per cell
float getVariedCloudLayer(vec2 uv, float baseScale, float sizeVariance, float seed) {
    vec2 cellUV = uv / baseScale;
    vec2 cellId = floor(cellUV);
    vec2 cellFract = fract(cellUV);

    float minDist = 10.0;
    float cellSize = 1.0; // Size modifier for this cell's cloud

    // Check 3x3 neighborhood
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 neighbor = vec2(float(x), float(y));
            vec2 neighborId = cellId + neighbor;

            // Random position within cell (more offset = more spacing variation)
            vec2 randomOffset = hash22(neighborId + seed);
            // Add extra random displacement for irregular spacing
            vec2 spacingJitter = (hash22(neighborId * 7.31 + seed) - 0.5) * 0.6;
            vec2 pointPos = neighbor + randomOffset + spacingJitter - cellFract;

            float dist = length(pointPos);

            if (dist < minDist) {
                minDist = dist;
                // Each cell has a random size modifier
                cellSize = 0.5 + hash2(neighborId + seed * 13.7) * sizeVariance;
            }
        }
    }

    // Scale distance by cell's size modifier (smaller cellSize = larger cloud)
    float scaledDist = minDist / cellSize;

    // Cloud shape with soft edges
    float cloud = 1.0 - smoothstep(0.0, 0.55, scaledDist);

    return cloud;
}

// Calculate cloud density at a point - with size/spacing variation and depth
float getCloudDensity(vec2 uv, float coverage, out float cloudHeight) {
    // Animate with wind (larger multiplier for visible movement)
    vec2 animatedUV = uv + uWindOffset;

    // Layer 1: Large clouds with high size variance
    float layer1 = getVariedCloudLayer(animatedUV, 2.5, 1.5, 0.0);

    // Layer 2: Medium clouds, different offset for irregular distribution
    vec2 offset2 = vec2(37.5, 91.2);
    float layer2 = getVariedCloudLayer(animatedUV * 0.7 + offset2, 3.0, 1.2, 100.0);

    // Layer 3: Small cloud puffs scattered around
    vec2 offset3 = vec2(-53.8, 27.1);
    float layer3 = getVariedCloudLayer(animatedUV * 1.4 + offset3, 1.8, 2.0, 200.0);

    // Combine layers with weights - creates varied cloud sizes
    float baseDensity = layer1 * 0.6 + layer2 * 0.3 + layer3 * 0.25;
    baseDensity = clamp(baseDensity, 0.0, 1.0);

    // FBM for fluffy edges and internal detail
    float detail = fbm(animatedUV * 3.0, 4);
    float fineDetail = fbm(animatedUV * 8.0 + vec2(50.0), 3);

    // Apply detail to create fluffy edges
    float density = baseDensity * (0.6 + 0.4 * detail);
    density += (fineDetail - 0.5) * 0.2 * baseDensity;
    density = clamp(density, 0.0, 1.0);

    // Coverage threshold
    float threshold = 0.25 + (1.0 - coverage) * 0.55;
    density = smoothstep(threshold - 0.1, threshold + 0.15, density);

    // Calculate cloud "height" for 3D depth effect
    // Higher density = taller cloud, with variation from noise
    float heightNoise = fbm(animatedUV * 2.0 + vec2(200.0), 3);
    cloudHeight = density * (0.5 + 0.5 * heightNoise);

    // Add wispy clouds / rain streaks (only visible during precipitation)
    if (uPrecipitationIntensity > 0.1) {
        float wisps = fbm(animatedUV * 5.0 + uCloudTime * 0.1, 3);
        wisps = smoothstep(0.6, 0.8, wisps) * 0.2;
        density = max(density, wisps * coverage * 0.4 * uPrecipitationIntensity);
    }

    return clamp(density, 0.0, 1.0);
}

// Calculate cloud color with 3D depth lighting
vec3 getCloudColor(float density, float cloudHeight, vec3 viewDir, vec3 sunDir, vec3 sunColor) {
    // Base cloud color - bright white
    vec3 cloudBase = vec3(1.0, 1.0, 1.0);

    // Sun angle affects cloud brightness
    float sunDot = max(0.0, sunDir.y);
    float lightIntensity = 0.85 + 0.15 * sunDot;

    // === 3D DEPTH EFFECT ===
    // Use cloudHeight as proxy for cloud thickness/volume
    float selfShadow = cloudHeight * density;

    // Top-lit effect: brighter at cloud top, darker at bottom
    float topLight = 1.0 - selfShadow * 0.25;

    // Depth-based shading - thicker parts are slightly darker
    float depthShading = mix(0.85, 1.0, pow(1.0 - density * 0.4, 2.0));

    // Combine lighting
    vec3 cloudColor = cloudBase * lightIntensity * topLight * depthShading;

    // Add subtle blue ambient in shadowed areas for sky reflection
    vec3 ambientTint = vec3(0.88, 0.92, 1.0);
    cloudColor = mix(cloudColor, cloudColor * ambientTint, selfShadow * 0.4);

    // Sun-facing highlights (silver lining)
    float sunFacing = max(0.0, dot(viewDir, sunDir));
    float rimLight = pow(sunFacing, 4.0) * 0.3;
    cloudColor += sunColor * rimLight * (1.0 - density * 0.5);

    // Edge glow - clouds are brighter at thin edges (subsurface scattering)
    float edgeGlow = smoothstep(0.05, 0.3, density) * (1.0 - smoothstep(0.3, 0.8, density));
    cloudColor += vec3(0.08) * edgeGlow;

    // Underside shading - darker at bottom of thick clouds (stronger during precipitation)
    float undersideStrength = 0.05 + uPrecipitationIntensity * 0.15; // 0.05 clear, 0.2 during rain
    float undersideDark = cloudHeight * undersideStrength;
    cloudColor *= (1.0 - undersideDark);

    // Sunset/sunrise warm tinting
    float warmth = pow(1.0 - sunDot, 2.0);
    vec3 warmColor = vec3(1.0, 0.85, 0.7);
    cloudColor = mix(cloudColor, cloudColor * warmColor, warmth * 0.4);

    return clamp(cloudColor, 0.0, 1.0);
}

// ========== STAR FIELD ==========

float stars(vec3 dir) {
    vec2 uv = dir.xz / (abs(dir.y) + 0.001);
    uv *= 100.0;
    vec2 id = floor(uv);
    float h = hash2(id);
    if (h > 0.98 && dir.y > 0.1) {
        vec2 gv = fract(uv) - 0.5;
        float d = length(gv);
        float star = smoothstep(0.2, 0.0, d) * (h - 0.98) * 50.0;
        // Twinkle
        star *= 0.7 + 0.3 * sin(uCloudTime * 2.0 + h * 100.0);
        return star;
    }
    return 0.0;
}

// ========== ATMOSPHERIC SCATTERING ==========

vec3 calculateAtmosphericScattering(vec3 viewDir, vec3 sunDir) {
    float cosTheta = dot(viewDir, sunDir);

    // Rayleigh phase function
    float rayleighPhase = 0.75 * (1.0 + cosTheta * cosTheta);

    // Mie phase function (Henyey-Greenstein)
    float miePhase = (1.0 - MIE_G * MIE_G) / pow(1.0 + MIE_G * MIE_G - 2.0 * MIE_G * cosTheta, 1.5);

    // Altitude affects density
    float altitude = max(viewDir.y, 0.0);
    float rayleighDensity = exp(-altitude * 0.5);
    float mieDensity = exp(-altitude * 0.25);

    // Calculate scattering
    vec3 rayleigh = RAYLEIGH_COEFF * rayleighPhase * rayleighDensity * 40000.0;
    vec3 mie = vec3(MIE_COEFF) * miePhase * mieDensity * 2000.0;

    return (rayleigh + mie) * uSunColor;
}

// ========== MAIN ==========

void main() {
    vec3 viewDir = normalize(vViewDirection);
    vec3 sunDir = normalize(uSunDirection);

    // Base sky color from atmospheric scattering
    vec3 skyColor = calculateAtmosphericScattering(viewDir, sunDir);

    // Sun disc with glow
    float sunAngle = dot(viewDir, sunDir);
    float sunDisc = smoothstep(0.9995, 0.9998, sunAngle);
    float sunGlow = pow(max(0.0, sunAngle), 8.0) * 0.5;
    skyColor += uSunColor * sunDisc * 50.0;
    skyColor += uSunColor * sunGlow * (1.0 - uNightFactor);

    // Horizon gradient (warm colors)
    float horizonFade = 1.0 - abs(viewDir.y);
    horizonFade = pow(horizonFade, 3.0);
    vec3 horizonColor = uSunColor * vec3(1.0, 0.7, 0.5) * horizonFade;
    skyColor += horizonColor * 0.3 * (1.0 - uNightFactor * 0.5);

    // ========== CLOUDS ==========
    vec2 cloudUV = getCloudUV(viewDir);
    float cloudDensity = 0.0;
    float cloudHeight = 0.0;
    vec3 cloudColor = vec3(1.0);

    if (cloudUV.x > -900.0 && uCloudCoverage > 0.01) {
        cloudDensity = getCloudDensity(cloudUV, uCloudCoverage, cloudHeight);
        cloudColor = getCloudColor(cloudDensity, cloudHeight, viewDir, sunDir, uSunColor);

        // Gentle fade clouds near horizon to blend with haze (less aggressive)
        float horizonCloudFade = smoothstep(0.02, 0.08, viewDir.y);
        cloudDensity *= horizonCloudFade;

        // Reduce cloud visibility at night but keep some
        cloudDensity *= (1.0 - uNightFactor * 0.5);
        // Night clouds are dimmer but still visible
        cloudColor = mix(cloudColor, cloudColor * 0.5, uNightFactor);
    }

    // Night sky
    vec3 nightColor = vec3(0.01, 0.015, 0.03);
    vec3 nightHorizon = vec3(0.02, 0.03, 0.05);
    vec3 nightSky = mix(nightHorizon, nightColor, max(viewDir.y, 0.0));

    // Add stars at night (behind clouds)
    float starIntensity = stars(viewDir) * uNightFactor * (1.0 - cloudDensity);
    nightSky += vec3(starIntensity);

    // Blend day/night sky
    skyColor = mix(skyColor, nightSky, uNightFactor);

    // Blend clouds over sky
    skyColor = mix(skyColor, cloudColor, cloudDensity * 0.95);

    // Haze at horizon (over everything) - reduced range for clearer sky
    float haze = smoothstep(0.0, 0.2, 1.0 - abs(viewDir.y));
    haze = pow(haze, 1.5); // Concentrate haze closer to horizon
    vec3 hazeColor = mix(uSunColor * 0.85, vec3(0.3, 0.35, 0.4), uNightFactor);
    skyColor = mix(skyColor, hazeColor, haze * uHazeIntensity * (1.0 - uNightFactor * 0.7));

    // Tone mapping - preserve saturation for vivid sky
    skyColor = skyColor / (skyColor + vec3(0.8)); // Less aggressive compression
    skyColor = pow(skyColor, vec3(0.95)); // Preserve brightness

    gl_FragColor = vec4(skyColor, 1.0);
}
`;

let skyShaderCounter = 0;

export interface SkyShaderConfig {
  radius: number;
  segments: number;
}

const DEFAULT_CONFIG: SkyShaderConfig = {
  radius: 1000,
  segments: 32,
};

export class ProceduralSkyShader {
  private scene: Scene;
  private skyMesh: Mesh | null = null;
  private skyMaterial: ShaderMaterial | null = null;
  private config: SkyShaderConfig;
  private renderObserver: Observer<Scene> | null = null;

  // Uniforms
  private sunDirection: Vector3 = new Vector3(0.5, 0.8, 0.3).normalize();
  private sunColor: Color3 = new Color3(1.0, 0.95, 0.85);
  private timeOfDay: number = 12;
  private cloudCoverage: number = 0.3;
  private hazeIntensity: number = 0.3;
  private nightFactor: number = 0;
  private precipitationIntensity: number = 0;

  // Cloud animation
  private windOffset: Vector2 = new Vector2(0, 0);
  private windSpeed: number = 0.2;
  private windDirection: number = 45; // degrees
  private startTime: number = 0;

  constructor(scene: Scene, config: Partial<SkyShaderConfig> = {}) {
    this.scene = scene;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startTime = performance.now() / 1000;
  }

  init(): void {
    this.createSkyMesh();
    this.createSkyMaterial();

    if (this.skyMesh && this.skyMaterial) {
      this.skyMesh.material = this.skyMaterial;
    }

    // Animation update loop
    this.renderObserver = this.scene.onBeforeRenderObservable.add(() => {
      this.updateAnimation();
    });
  }

  private createSkyMesh(): void {
    // Create inverted sphere (normals pointing inward)
    this.skyMesh = MeshBuilder.CreateSphere(
      "proceduralSky",
      {
        diameter: this.config.radius * 2,
        segments: this.config.segments,
        sideOrientation: Mesh.BACKSIDE, // Render inside
      },
      this.scene
    );

    // Disable picking and shadow casting
    this.skyMesh.isPickable = false;
    this.skyMesh.receiveShadows = false;

    // Render before everything else
    this.skyMesh.renderingGroupId = 0;
    this.skyMesh.infiniteDistance = true;
  }

  private createSkyMaterial(): void {
    const uniqueName = `proceduralSky_${++skyShaderCounter}_${Date.now()}`;

    this.skyMaterial = new ShaderMaterial(
      uniqueName,
      this.scene,
      {
        vertex: "proceduralSky",
        fragment: "proceduralSky",
      },
      {
        attributes: ["position"],
        uniforms: [
          "worldViewProjection",
          "uSunDirection",
          "uSunColor",
          "uTimeOfDay",
          "uCloudCoverage",
          "uHazeIntensity",
          "uNightFactor",
          "uWindOffset",
          "uCloudTime",
          "uPrecipitationIntensity",
        ],
      }
    );

    // Disable depth write so sky is always behind everything
    this.skyMaterial.backFaceCulling = false;
    this.skyMaterial.disableDepthWrite = true;

    // Set initial uniforms
    this.updateUniforms();

    this.skyMaterial.onError = (effect, errors) => {
      console.error("[ProceduralSkyShader] Shader compile error:", errors);
    };
  }

  private updateUniforms(): void {
    if (!this.skyMaterial) return;

    this.skyMaterial.setVector3("uSunDirection", this.sunDirection);
    this.skyMaterial.setColor3("uSunColor", this.sunColor);
    this.skyMaterial.setFloat("uTimeOfDay", this.timeOfDay);
    this.skyMaterial.setFloat("uCloudCoverage", this.cloudCoverage);
    this.skyMaterial.setFloat("uHazeIntensity", this.hazeIntensity);
    this.skyMaterial.setFloat("uNightFactor", this.nightFactor);
    this.skyMaterial.setVector2("uWindOffset", this.windOffset);
    this.skyMaterial.setFloat("uCloudTime", 0);
    this.skyMaterial.setFloat("uPrecipitationIntensity", this.precipitationIntensity);
  }

  private updateAnimation(): void {
    if (!this.skyMaterial) return;

    const currentTime = performance.now() / 1000;
    const elapsed = currentTime - this.startTime;

    // Update wind offset for cloud movement
    // Increased multiplier from 0.02 to 0.15 for visible movement
    const windRad = (this.windDirection * Math.PI) / 180;
    this.windOffset.x = Math.cos(windRad) * elapsed * this.windSpeed * 0.15;
    this.windOffset.y = Math.sin(windRad) * elapsed * this.windSpeed * 0.15;

    this.skyMaterial.setVector2("uWindOffset", this.windOffset);
    this.skyMaterial.setFloat("uCloudTime", elapsed);
  }

  // Public setters
  setSunDirection(direction: Vector3): void {
    this.sunDirection = direction.normalize();
    if (this.skyMaterial) {
      this.skyMaterial.setVector3("uSunDirection", this.sunDirection);
    }
  }

  setSunColor(color: Color3): void {
    this.sunColor = color;
    if (this.skyMaterial) {
      this.skyMaterial.setColor3("uSunColor", this.sunColor);
    }
  }

  setTimeOfDay(time: number): void {
    this.timeOfDay = time;
    if (this.skyMaterial) {
      this.skyMaterial.setFloat("uTimeOfDay", time);
    }
  }

  setCloudCoverage(coverage: number): void {
    this.cloudCoverage = coverage;
    if (this.skyMaterial) {
      this.skyMaterial.setFloat("uCloudCoverage", coverage);
    }
  }

  setHazeIntensity(intensity: number): void {
    this.hazeIntensity = intensity;
    if (this.skyMaterial) {
      this.skyMaterial.setFloat("uHazeIntensity", intensity);
    }
  }

  setNightFactor(factor: number): void {
    this.nightFactor = factor;
    if (this.skyMaterial) {
      this.skyMaterial.setFloat("uNightFactor", factor);
    }
  }

  setWindSpeed(speed: number): void {
    this.windSpeed = speed;
  }

  setWindDirection(direction: number): void {
    this.windDirection = direction;
  }

  setPrecipitationIntensity(intensity: number): void {
    this.precipitationIntensity = intensity;
    if (this.skyMaterial) {
      this.skyMaterial.setFloat("uPrecipitationIntensity", intensity);
    }
  }

  // Get current sky color at horizon for fog matching
  getHorizonColor(): Color3 {
    // Approximate horizon color based on sun position and time
    const dayHorizon = new Color3(0.7, 0.8, 0.9);
    const sunsetHorizon = new Color3(0.9, 0.6, 0.4);
    const nightHorizon = new Color3(0.02, 0.03, 0.05);

    // Calculate warmth based on sun angle
    const sunElevation = this.sunDirection.y;
    const warmth = Math.max(0, 1 - Math.abs(sunElevation) * 2);

    let horizonColor = Color3.Lerp(dayHorizon, sunsetHorizon, warmth);
    horizonColor = Color3.Lerp(horizonColor, nightHorizon, this.nightFactor);

    return horizonColor;
  }

  // Get zenith color for gradient effects
  getZenithColor(): Color3 {
    const dayZenith = new Color3(0.35, 0.55, 0.9);
    const nightZenith = new Color3(0.01, 0.015, 0.03);
    return Color3.Lerp(dayZenith, nightZenith, this.nightFactor);
  }

  getMesh(): Mesh | null {
    return this.skyMesh;
  }

  getMaterial(): ShaderMaterial | null {
    return this.skyMaterial;
  }

  setEnabled(enabled: boolean): void {
    if (this.skyMesh) {
      this.skyMesh.setEnabled(enabled);
    }
  }

  dispose(): void {
    if (this.renderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.renderObserver);
      this.renderObserver = null;
    }

    if (this.skyMesh) {
      this.skyMesh.dispose();
      this.skyMesh = null;
    }
    // Don't dispose shared material
    this.skyMaterial = null;
  }
}
