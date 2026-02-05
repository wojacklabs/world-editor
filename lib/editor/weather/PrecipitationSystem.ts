import * as THREE from "three";
import { disposeMesh } from "../../shared/rendering/threeHelpers";

// Precipitation vertex shader - custom vertex buffer approach
const precipitationVertexShader = `
attribute vec3 particleSeed; // x, y, z seed for each particle

uniform float uTime;
uniform vec3 uCameraPosition;
uniform vec3 uWindDirection;
uniform float uWindSpeed;
uniform float uFallSpeed;
uniform vec3 uBoxSize;
uniform float uStreakLength;
uniform float uParticleSize;
uniform float uPrecipitationType; // 0 = rain, 1 = snow

varying vec2 vUV;
varying float vAlpha;
varying float vSizeScale;    // Per-particle size variation
varying float vRotation;     // Per-particle rotation (snow)
varying float vThickness;    // Per-particle thickness variation (rain)

void main() {
    vec3 seed = particleSeed;

    // Generate unique particle ID for randomization
    float particleId = seed.x * 127.1 + seed.z * 311.7;
    float particleRand = fract(sin(particleId) * 43758.5453);
    float particleRand2 = fract(sin(particleId * 1.7) * 23421.631);
    float particleRand3 = fract(sin(particleId * 2.3) * 65432.123);

    // Size variation per particle (0.5 to 1.5)
    vSizeScale = 0.5 + particleRand * 1.0;

    // Thickness variation for rain (0.6 to 1.4)
    vThickness = 0.6 + particleRand2 * 0.8;

    // Generate base particle position from seed
    vec3 particlePos = seed * uBoxSize - uBoxSize * 0.5;
    particlePos.y = seed.y * uBoxSize.y;

    // Unique time offset per particle for desync
    float particleTime = uTime + fract(particleId) * 10.0;

    // Animate fall with wind influence
    float fallDistance = mod(particleTime * uFallSpeed, uBoxSize.y);
    particlePos.y -= fallDistance;
    particlePos.x += uWindDirection.x * uWindSpeed * particleTime * 0.3;
    particlePos.z += uWindDirection.z * uWindSpeed * particleTime * 0.3;

    // Snow-specific: flutter side-to-side
    if (uPrecipitationType > 0.5) {
        float flutterFreq = 2.0 + particleRand * 2.0; // 2-4 Hz
        float flutterAmp = 0.3 + particleRand2 * 0.4; // 0.3-0.7 amplitude
        particlePos.x += sin(particleTime * flutterFreq + particleId) * flutterAmp;
        particlePos.z += cos(particleTime * flutterFreq * 0.7 + particleId * 1.3) * flutterAmp * 0.5;

        // Rotation for snowflakes
        vRotation = particleTime * (0.5 + particleRand3 * 1.5) + particleRand * 6.28;
    } else {
        vRotation = 0.0;
    }

    // Wrap around camera (infinite precipitation effect)
    vec3 relPos = particlePos - uCameraPosition;
    relPos = mod(relPos + uBoxSize * 0.5, uBoxSize) - uBoxSize * 0.5;
    particlePos = relPos + uCameraPosition;

    // Billboard facing camera
    vec3 toCamera = normalize(uCameraPosition - particlePos);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCamera));
    vec3 up = vec3(0.0, 1.0, 0.0);

    // Apply size variation
    float sizeMultiplier = uParticleSize * vSizeScale;

    // Stretch for rain streaks
    float stretchedY = position.y * (1.0 + uStreakLength);

    // Scale particle
    vec3 billboardPos = particlePos
        + right * position.x * sizeMultiplier
        + up * stretchedY * sizeMultiplier;

    gl_Position = projectionMatrix * viewMatrix * vec4(billboardPos, 1.0);
    vUV = uv;

    // Fade at edges of spawn box
    vec3 boxPos = relPos / uBoxSize;
    float edgeFade = 1.0 - smoothstep(0.3, 0.5, max(max(abs(boxPos.x), abs(boxPos.y)), abs(boxPos.z)));

    // Distance-based alpha (closer = slightly more transparent for depth)
    float distToCamera = length(relPos);
    float distFade = smoothstep(2.0, 10.0, distToCamera);

    vAlpha = edgeFade * (0.7 + distFade * 0.3);
}
`;

// Precipitation fragment shader
const precipitationFragmentShader = `
precision highp float;

varying vec2 vUV;
varying float vAlpha;
varying float vSizeScale;
varying float vRotation;
varying float vThickness;

uniform vec4 uColor;
uniform float uPrecipitationType; // 0 = rain, 1 = snow

// Rotate UV coordinates
vec2 rotateUV(vec2 uv, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return vec2(
        uv.x * c - uv.y * s,
        uv.x * s + uv.y * c
    );
}

// Simple soft particle for snow - small and subtle
float snowParticle(vec2 uv) {
    float dist = length(uv);
    // Simple soft circle with smooth falloff
    float particle = smoothstep(0.5, 0.0, dist);
    return particle;
}

// Subtle rain streak - blends with environment
float rainStreak(vec2 uv, float thickness) {
    // Very thin tapered streak
    float taper = mix(0.04, 0.06, uv.y + 0.5) * thickness;

    // Main streak body - softer edges
    float streak = smoothstep(taper, taper * 0.3, abs(uv.x));

    // Gradient: very transparent at top, slightly visible at bottom
    float gradient = smoothstep(-0.5, 0.4, uv.y);
    streak *= gradient;

    // Fade out at bottom
    streak *= smoothstep(0.5, 0.35, uv.y);

    // No bright highlight - just subtle streak
    return streak * 0.4;
}

void main() {
    vec2 center = vUV - 0.5;
    float alpha = 0.0;
    vec3 color = uColor.rgb;

    if (uPrecipitationType < 0.5) {
        // === RAIN ===
        alpha = rainStreak(center, vThickness);

        // Subtle gray-blue tint to blend with environment
        color = mix(uColor.rgb, vec3(0.6, 0.65, 0.7), 0.3);

    } else {
        // === SNOW ===
        // Simple small particle - no rotation needed for dots
        float particleScale = 0.4 + vSizeScale * 0.3;
        vec2 scaledUV = center / particleScale;

        alpha = snowParticle(scaledUV) * 0.6;

        // Keep white color
        color = uColor.rgb;
    }

    alpha *= vAlpha;

    if (alpha < 0.01) discard;

    gl_FragColor = vec4(color, uColor.a * alpha);
}
`;

export type PrecipitationType = "rain" | "snow" | "none";

interface PrecipitationConfig {
  type: PrecipitationType;
  particleCount: number;
  boxSize: THREE.Vector3;
  fallSpeed: number;
  windInfluence: number;
  particleSize: number;
  color: THREE.Vector4;
  streakLength: number;
}

const RAIN_CONFIG: PrecipitationConfig = {
  type: "rain",
  particleCount: 5000,
  boxSize: new THREE.Vector3(60, 40, 60),
  fallSpeed: 22,
  windInfluence: 1.0,
  particleSize: 0.06,
  color: new THREE.Vector4(0.5, 0.55, 0.6, 0.35),  // Darker, more transparent
  streakLength: 4.0,
};

const SNOW_CONFIG: PrecipitationConfig = {
  type: "snow",
  particleCount: 3500,
  boxSize: new THREE.Vector3(60, 30, 60),
  fallSpeed: 2.5,
  windInfluence: 1.5,
  particleSize: 0.03,  // Much smaller particles
  color: new THREE.Vector4(0.95, 0.95, 1.0, 0.7),
  streakLength: 0,
};

export class PrecipitationSystem {
  private scene: any;
  private particleMesh: THREE.Mesh | null = null;
  private material: THREE.ShaderMaterial | null = null;

  // Stored camera reference
  private camera: THREE.Camera | null = null;

  // State
  private currentType: PrecipitationType = "none";
  private intensity: number = 0;
  private windDirection: THREE.Vector3 = new THREE.Vector3(1, 0, 0);
  private windSpeed: number = 0.2;

  // Animation
  private startTime: number = 0;

  constructor(scene: any) {
    this.scene = scene;
    this.startTime = performance.now() / 1000;
  }

  init(): void {
    // Nothing to do at init - particles created on demand
  }

  /** Set camera reference for particle positioning */
  setCamera(camera: THREE.Camera | null): void {
    this.camera = camera;
  }

  private createParticleSystem(config: PrecipitationConfig): void {
    // Clean up existing
    this.disposeParticles();

    if (config.type === "none") return;

    const count = Math.floor(config.particleCount * this.intensity);
    if (count === 0) return;

    // Create a single mesh with all particles as quads
    // Each particle is a quad (4 vertices, 6 indices)
    const verticesPerParticle = 4;

    const positions = new Float32Array(count * verticesPerParticle * 3);
    const uvs = new Float32Array(count * verticesPerParticle * 2);
    const particleSeeds = new Float32Array(count * verticesPerParticle * 3);
    const indices = new Uint32Array(count * 6);

    // Quad local positions (centered at origin)
    const quadPositions = [
      -0.5, -0.5, 0, // bottom-left
       0.5, -0.5, 0, // bottom-right
       0.5,  0.5, 0, // top-right
      -0.5,  0.5, 0, // top-left
    ];

    const quadUVs = [
      0, 0,
      1, 0,
      1, 1,
      0, 1,
    ];

    for (let i = 0; i < count; i++) {
      // Generate random seed for this particle
      const seedX = Math.random();
      const seedY = Math.random();
      const seedZ = Math.random();

      // Create 4 vertices for this particle's quad
      for (let v = 0; v < 4; v++) {
        const vIdx = (i * 4 + v) * 3;
        const uvIdx = (i * 4 + v) * 2;

        // Position (quad local offset)
        positions[vIdx] = quadPositions[v * 3];
        positions[vIdx + 1] = quadPositions[v * 3 + 1];
        positions[vIdx + 2] = quadPositions[v * 3 + 2];

        // UV
        uvs[uvIdx] = quadUVs[v * 2];
        uvs[uvIdx + 1] = quadUVs[v * 2 + 1];

        // Particle seed (same for all 4 vertices of this particle)
        particleSeeds[vIdx] = seedX;
        particleSeeds[vIdx + 1] = seedY;
        particleSeeds[vIdx + 2] = seedZ;
      }

      // Indices for 2 triangles
      const iIdx = i * 6;
      const vBase = i * 4;
      indices[iIdx] = vBase;
      indices[iIdx + 1] = vBase + 1;
      indices[iIdx + 2] = vBase + 2;
      indices[iIdx + 3] = vBase;
      indices[iIdx + 4] = vBase + 2;
      indices[iIdx + 5] = vBase + 3;
    }

    // Create geometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute("particleSeed", new THREE.BufferAttribute(particleSeeds, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    // Create material
    this.material = new THREE.ShaderMaterial({
      vertexShader: precipitationVertexShader,
      fragmentShader: precipitationFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uCameraPosition: { value: new THREE.Vector3() },
        uWindDirection: { value: this.windDirection.clone() },
        uWindSpeed: { value: this.windSpeed },
        uFallSpeed: { value: config.fallSpeed },
        uBoxSize: { value: config.boxSize.clone() },
        uStreakLength: { value: config.streakLength },
        uParticleSize: { value: config.particleSize },
        uColor: { value: config.color.clone() },
        uPrecipitationType: { value: config.type === "snow" ? 1.0 : 0.0 },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.particleMesh = new THREE.Mesh(geometry, this.material);
    this.particleMesh.raycast = () => {};
    this.particleMesh.frustumCulled = false;

    this.scene.add(this.particleMesh);
  }

  /** Call each frame */
  update(): void {
    if (!this.material) return;

    const time = (performance.now() / 1000) - this.startTime;
    this.material.uniforms.uTime.value = time;

    if (this.camera) {
      this.material.uniforms.uCameraPosition.value.copy(this.camera.position);
    }
  }

  // Public setters
  setType(type: PrecipitationType): void {
    if (this.currentType === type) return;

    this.currentType = type;
    this.rebuildParticles();
  }

  setIntensity(intensity: number): void {
    const newIntensity = Math.max(0, Math.min(1, intensity));
    if (Math.abs(this.intensity - newIntensity) < 0.05) return;

    this.intensity = newIntensity;
    this.rebuildParticles();
  }

  setWindDirection(direction: THREE.Vector3): void {
    this.windDirection.copy(direction).normalize();
    if (this.material) {
      this.material.uniforms.uWindDirection.value.copy(this.windDirection);
    }
  }

  setWindSpeed(speed: number): void {
    this.windSpeed = speed;
    if (this.material) {
      this.material.uniforms.uWindSpeed.value = this.windSpeed;
    }
  }

  private rebuildParticles(): void {
    if (this.currentType === "none" || this.intensity === 0) {
      this.disposeParticles();
      return;
    }

    const config = this.currentType === "rain" ? RAIN_CONFIG : SNOW_CONFIG;
    this.createParticleSystem(config);
  }

  private disposeParticles(): void {
    if (this.particleMesh) {
      disposeMesh(this.scene, this.particleMesh);
      this.particleMesh = null;
    }
    this.material = null;
  }

  setEnabled(enabled: boolean): void {
    if (this.particleMesh) {
      this.particleMesh.visible = enabled;
    }
  }

  dispose(): void {
    this.disposeParticles();
  }
}
