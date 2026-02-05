import * as THREE from "three";
import { disposeMesh } from "../../shared/rendering/threeHelpers";

// Sky vertex shader
const proceduralSkyVertexShader = `
varying vec3 vWorldPosition;
varying vec3 vViewDirection;

void main() {
    vWorldPosition = position;
    vViewDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Sky fragment shader with integrated procedural clouds
const proceduralSkyFragmentShader = `
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

// Pure FBM-based cloud layer - no cell boundaries
float getCloudLayer(vec2 uv, float scale, vec2 offset) {
    vec2 p = uv * scale + offset;

    // Use FBM with domain warping for organic cloud shapes
    vec2 warp1 = vec2(fbm(p + vec2(0.0, 0.0), 3), fbm(p + vec2(5.2, 1.3), 3));
    vec2 warp2 = vec2(fbm(p + warp1 * 2.0 + vec2(1.7, 9.2), 3), fbm(p + warp1 * 2.0 + vec2(8.3, 2.8), 3));

    float cloud = fbm(p + warp2 * 1.5, 4);
    return cloud;
}

// Calculate cloud density at a point - pure FBM based, no tile boundaries
float getCloudDensity(vec2 uv, float coverage, out float cloudHeight) {
    // Animate with wind
    vec2 animatedUV = uv + uWindOffset;

    // Radial fade to prevent abrupt cloud cutoffs at UV edges
    float uvDist = length(uv);
    float radialFade = 1.0 - smoothstep(2.5, 4.5, uvDist);

    // Layer 1: Large billowy clouds with domain warping
    float layer1 = getCloudLayer(animatedUV, 0.8, vec2(0.0));

    // Layer 2: Medium clouds at different scale and offset
    float layer2 = getCloudLayer(animatedUV, 1.2, vec2(50.0, 30.0));

    // Layer 3: Smaller detail clouds
    float layer3 = getCloudLayer(animatedUV, 2.0, vec2(-30.0, 70.0));

    // Combine layers with smooth blending
    float baseDensity = layer1 * 0.5 + layer2 * 0.3 + layer3 * 0.2;

    // Remap to create cloud-like distribution (more contrast)
    baseDensity = smoothstep(0.3, 0.7, baseDensity);

    // Add fine detail for fluffy edges
    float fineDetail = fbm(animatedUV * 4.0 + vec2(100.0), 4);
    float density = baseDensity * (0.7 + 0.3 * fineDetail);

    // Very fine detail for wispy edges
    float microDetail = fbm(animatedUV * 8.0 + vec2(200.0), 3);
    density += (microDetail - 0.5) * 0.15 * baseDensity;
    density = clamp(density, 0.0, 1.0);

    // Coverage threshold with very soft edges
    float threshold = 0.2 + (1.0 - coverage) * 0.5;
    density = smoothstep(threshold - 0.2, threshold + 0.25, density);

    // Calculate cloud "height" for 3D depth effect
    // Higher density = taller cloud, with variation from noise
    float heightNoise = fbm(animatedUV * 2.0 + vec2(200.0), 3);
    cloudHeight = density * (0.5 + 0.5 * heightNoise);

    // Add wispy clouds / rain streaks (only visible during active precipitation)
    if (uPrecipitationIntensity > 0.3) {
        float wisps = fbm(animatedUV * 5.0 + uCloudTime * 0.1, 3);
        wisps = smoothstep(0.6, 0.8, wisps) * 0.2;
        density = max(density, wisps * coverage * 0.4 * uPrecipitationIntensity);
    }

    // Apply radial fade to prevent abrupt cutoffs at edges
    density *= radialFade;

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

    // Underside shading - darker at bottom of thick clouds (only during precipitation)
    float undersideStrength = uPrecipitationIntensity * 0.2; // 0 clear, 0.2 during rain
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

        // Gentle fade clouds near horizon to blend with haze
        float horizonCloudFade = smoothstep(0.01, 0.15, viewDir.y);
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

export interface SkyShaderConfig {
  radius: number;
  segments: number;
}

const DEFAULT_CONFIG: SkyShaderConfig = {
  radius: 1000,
  segments: 32,
};

export class ProceduralSkyShader {
  private scene: any;
  private skyMesh: THREE.Mesh | null = null;
  private skyMaterial: THREE.ShaderMaterial | null = null;
  private config: SkyShaderConfig;

  // Uniforms
  private sunDirection: THREE.Vector3 = new THREE.Vector3(0.5, 0.8, 0.3).normalize();
  private sunColor: THREE.Color = new THREE.Color(1.0, 0.95, 0.85);
  private timeOfDay: number = 12;
  private cloudCoverage: number = 0.3;
  private hazeIntensity: number = 0.3;
  private nightFactor: number = 0;
  private precipitationIntensity: number = 0;

  // Cloud animation
  private windOffset: THREE.Vector2 = new THREE.Vector2(0, 0);
  private windSpeed: number = 0.2;
  private windDirection: number = 45; // degrees
  private startTime: number = 0;

  constructor(scene: any, config: Partial<SkyShaderConfig> = {}) {
    this.scene = scene;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startTime = performance.now() / 1000;
  }

  init(): void {
    this.createSkyMesh();
    this.createSkyMaterial();

    if (this.skyMesh && this.skyMaterial) {
      this.skyMesh.material = this.skyMaterial;
      this.scene.add(this.skyMesh);
    }
  }

  private createSkyMesh(): void {
    const geo = new THREE.SphereGeometry(
      this.config.radius,
      this.config.segments,
      this.config.segments
    );

    // Placeholder material, replaced after createSkyMaterial
    this.skyMesh = new THREE.Mesh(geo);

    // Disable raycasting
    this.skyMesh.raycast = () => {};

    // Render before everything else
    this.skyMesh.renderOrder = -1000;
  }

  private createSkyMaterial(): void {
    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: proceduralSkyVertexShader,
      fragmentShader: proceduralSkyFragmentShader,
      uniforms: {
        uSunDirection: { value: this.sunDirection.clone() },
        uSunColor: { value: this.sunColor.clone() },
        uTimeOfDay: { value: this.timeOfDay },
        uCloudCoverage: { value: this.cloudCoverage },
        uHazeIntensity: { value: this.hazeIntensity },
        uNightFactor: { value: this.nightFactor },
        uWindOffset: { value: this.windOffset.clone() },
        uCloudTime: { value: 0 },
        uPrecipitationIntensity: { value: this.precipitationIntensity },
      },
      side: THREE.BackSide,
      depthWrite: false,
    });
  }

  /** Call each frame to animate clouds */
  update(): void {
    this.updateAnimation();
  }

  private updateAnimation(): void {
    if (!this.skyMaterial) return;

    const currentTime = performance.now() / 1000;
    const elapsed = currentTime - this.startTime;

    // Update wind offset for cloud movement
    const windRad = (this.windDirection * Math.PI) / 180;
    this.windOffset.x = Math.cos(windRad) * elapsed * this.windSpeed * 0.15;
    this.windOffset.y = Math.sin(windRad) * elapsed * this.windSpeed * 0.15;

    this.skyMaterial.uniforms.uWindOffset.value.copy(this.windOffset);
    this.skyMaterial.uniforms.uCloudTime.value = elapsed;
  }

  // Public setters
  setSunDirection(direction: THREE.Vector3): void {
    this.sunDirection.copy(direction).normalize();
    if (this.skyMaterial) {
      this.skyMaterial.uniforms.uSunDirection.value.copy(this.sunDirection);
    }
  }

  setSunColor(color: THREE.Color): void {
    this.sunColor.copy(color);
    if (this.skyMaterial) {
      this.skyMaterial.uniforms.uSunColor.value.copy(this.sunColor);
    }
  }

  setTimeOfDay(time: number): void {
    this.timeOfDay = time;
    if (this.skyMaterial) {
      this.skyMaterial.uniforms.uTimeOfDay.value = time;
    }
  }

  setCloudCoverage(coverage: number): void {
    this.cloudCoverage = coverage;
    if (this.skyMaterial) {
      this.skyMaterial.uniforms.uCloudCoverage.value = coverage;
    }
  }

  setHazeIntensity(intensity: number): void {
    this.hazeIntensity = intensity;
    if (this.skyMaterial) {
      this.skyMaterial.uniforms.uHazeIntensity.value = intensity;
    }
  }

  setNightFactor(factor: number): void {
    this.nightFactor = factor;
    if (this.skyMaterial) {
      this.skyMaterial.uniforms.uNightFactor.value = factor;
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
      this.skyMaterial.uniforms.uPrecipitationIntensity.value = intensity;
    }
  }

  // Get current sky color at horizon for fog matching
  getHorizonColor(): THREE.Color {
    // Approximate horizon color based on sun position and time
    const dayHorizon = new THREE.Color(0.7, 0.8, 0.9);
    const sunsetHorizon = new THREE.Color(0.9, 0.6, 0.4);
    const nightHorizon = new THREE.Color(0.02, 0.03, 0.05);

    // Calculate warmth based on sun angle
    const sunElevation = this.sunDirection.y;
    const warmth = Math.max(0, 1 - Math.abs(sunElevation) * 2);

    const horizonColor = dayHorizon.clone().lerp(sunsetHorizon, warmth);
    horizonColor.lerp(nightHorizon, this.nightFactor);

    return horizonColor;
  }

  // Get zenith color for gradient effects
  getZenithColor(): THREE.Color {
    const dayZenith = new THREE.Color(0.35, 0.55, 0.9);
    const nightZenith = new THREE.Color(0.01, 0.015, 0.03);
    return dayZenith.clone().lerp(nightZenith, this.nightFactor);
  }

  getMesh(): THREE.Mesh | null {
    return this.skyMesh;
  }

  getMaterial(): THREE.ShaderMaterial | null {
    return this.skyMaterial;
  }

  setEnabled(enabled: boolean): void {
    if (this.skyMesh) {
      this.skyMesh.visible = enabled;
    }
  }

  dispose(): void {
    if (this.skyMesh) {
      disposeMesh(this.scene, this.skyMesh);
      this.skyMesh = null;
    }
    // Don't dispose shared material
    this.skyMaterial = null;
  }
}
