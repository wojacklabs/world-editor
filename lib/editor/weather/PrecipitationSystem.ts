import {
  Scene,
  Mesh,
  ShaderMaterial,
  Vector3,
  Color4,
  Effect,
  Observer,
  Engine,
  VertexData,
  VertexBuffer,
} from "@babylonjs/core";

// Register precipitation shaders - using custom vertex buffer approach for WebGPU compatibility
Effect.ShadersStore["precipitationVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec2 uv;
attribute vec3 particleSeed; // x, y, z seed for each particle

uniform mat4 viewProjection;
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

    gl_Position = viewProjection * vec4(billboardPos, 1.0);
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

Effect.ShadersStore["precipitationFragmentShader"] = `
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

// 6-pointed star/snowflake pattern
float snowflakePattern(vec2 uv) {
    float dist = length(uv);

    // Base soft circle
    float circle = smoothstep(0.5, 0.15, dist);

    // 6-fold symmetry for crystal arms
    float angle = atan(uv.y, uv.x);
    float arm = abs(sin(angle * 3.0)); // 6 arms (sin repeats twice per 2π)

    // Crystal arm shape - thinner toward edges
    float armShape = smoothstep(0.5, 0.0, dist * (1.0 - arm * 0.4));

    // Inner glow
    float innerGlow = smoothstep(0.3, 0.0, dist) * 0.5;

    // Combine: crystal arms with soft center
    float snowflake = max(armShape * 0.7, circle * 0.5) + innerGlow;

    // Add subtle sparkle points at arm tips
    float sparkle = pow(arm, 8.0) * smoothstep(0.45, 0.35, dist) * 0.3;
    snowflake += sparkle;

    return clamp(snowflake, 0.0, 1.0);
}

// Improved rain streak
float rainStreak(vec2 uv, float thickness) {
    // Tapered streak: thin at top, slightly thicker at bottom
    float taper = mix(0.08, 0.12, uv.y + 0.5) * thickness;

    // Main streak body
    float streak = smoothstep(taper, 0.0, abs(uv.x));

    // Gradient: transparent at top, opaque at bottom (motion blur effect)
    float gradient = smoothstep(-0.5, 0.3, uv.y);
    streak *= gradient;

    // Fade out at very bottom
    streak *= smoothstep(0.5, 0.4, uv.y);

    // Bright highlight line in center
    float highlight = smoothstep(taper * 0.3, 0.0, abs(uv.x));
    highlight *= gradient * 0.4;

    return streak * 0.7 + highlight;
}

void main() {
    vec2 center = vUV - 0.5;
    float alpha = 0.0;
    vec3 color = uColor.rgb;

    if (uPrecipitationType < 0.5) {
        // === RAIN ===
        alpha = rainStreak(center, vThickness);

        // Slight blue-white tint variation
        color = mix(uColor.rgb, vec3(0.9, 0.95, 1.0), 0.2);

    } else {
        // === SNOW ===
        // Apply rotation to UV
        vec2 rotatedUV = rotateUV(center, vRotation);

        // Scale based on size variation
        rotatedUV /= (0.7 + vSizeScale * 0.3);

        alpha = snowflakePattern(rotatedUV) * 0.85;

        // Slight warm/cool variation
        float warmth = fract(vRotation * 0.1);
        color = mix(uColor.rgb, vec3(1.0, 0.98, 0.95), warmth * 0.1);
    }

    alpha *= vAlpha;

    if (alpha < 0.01) discard;

    gl_FragColor = vec4(color, uColor.a * alpha);
}
`;

let precipitationMaterialCounter = 0;

export type PrecipitationType = "rain" | "snow" | "none";

interface PrecipitationConfig {
  type: PrecipitationType;
  particleCount: number;
  boxSize: Vector3;
  fallSpeed: number;
  windInfluence: number;
  particleSize: number;
  color: Color4;
  streakLength: number;
}

const RAIN_CONFIG: PrecipitationConfig = {
  type: "rain",
  particleCount: 4000,
  boxSize: new Vector3(60, 40, 60),
  fallSpeed: 20,
  windInfluence: 1.0,
  particleSize: 0.08,
  color: new Color4(0.7, 0.75, 0.85, 0.6),
  streakLength: 3.0,
};

const SNOW_CONFIG: PrecipitationConfig = {
  type: "snow",
  particleCount: 2500,
  boxSize: new Vector3(60, 30, 60),
  fallSpeed: 3,
  windInfluence: 1.5,
  particleSize: 0.12,
  color: new Color4(0.95, 0.95, 1.0, 0.8),
  streakLength: 0,
};

export class PrecipitationSystem {
  private scene: Scene;
  private particleMesh: Mesh | null = null;
  private material: ShaderMaterial | null = null;
  private renderObserver: Observer<Scene> | null = null;

  // State
  private currentType: PrecipitationType = "none";
  private intensity: number = 0;
  private windDirection: Vector3 = new Vector3(1, 0, 0);
  private windSpeed: number = 0.2;

  // Animation
  private startTime: number = 0;

  constructor(scene: Scene) {
    this.scene = scene;
    this.startTime = performance.now() / 1000;
  }

  init(): void {
    // Register update loop
    this.renderObserver = this.scene.onBeforeRenderObservable.add(() => {
      this.update();
    });
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
    const indicesPerParticle = 6;

    const positions = new Float32Array(count * verticesPerParticle * 3);
    const uvs = new Float32Array(count * verticesPerParticle * 2);
    const particleSeeds = new Float32Array(count * verticesPerParticle * 3);
    const indices = new Uint32Array(count * indicesPerParticle);

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

    // Create mesh
    this.particleMesh = new Mesh("precipitationMesh", this.scene);
    this.particleMesh.isPickable = false;

    // Apply vertex data
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.uvs = uvs;
    vertexData.indices = indices;
    vertexData.applyToMesh(this.particleMesh);

    // Add custom attribute for particle seeds
    this.particleMesh.setVerticesData("particleSeed", particleSeeds, false, 3);

    // Create material
    const uniqueName = `precipitation_${++precipitationMaterialCounter}_${Date.now()}`;
    this.material = new ShaderMaterial(
      uniqueName,
      this.scene,
      {
        vertex: "precipitation",
        fragment: "precipitation",
      },
      {
        attributes: ["position", "uv", "particleSeed"],
        uniforms: [
          "viewProjection",
          "uTime",
          "uCameraPosition",
          "uWindDirection",
          "uWindSpeed",
          "uFallSpeed",
          "uBoxSize",
          "uStreakLength",
          "uParticleSize",
          "uColor",
          "uPrecipitationType",
        ],
        needAlphaBlending: true,
      }
    );

    this.material.backFaceCulling = false;
    this.material.alphaMode = Engine.ALPHA_ADD;

    // Set uniforms
    this.material.setFloat("uFallSpeed", config.fallSpeed);
    this.material.setVector3("uBoxSize", config.boxSize);
    this.material.setFloat("uStreakLength", config.streakLength);
    this.material.setFloat("uParticleSize", config.particleSize);
    this.material.setColor4("uColor", config.color);
    this.material.setFloat("uPrecipitationType", config.type === "snow" ? 1.0 : 0.0);
    this.material.setVector3("uWindDirection", this.windDirection);
    this.material.setFloat("uWindSpeed", this.windSpeed);

    this.particleMesh.material = this.material;
  }

  private update(): void {
    if (!this.material) return;

    const time = (performance.now() / 1000) - this.startTime;
    this.material.setFloat("uTime", time);

    const camera = this.scene.activeCamera;
    if (camera) {
      this.material.setVector3("uCameraPosition", camera.position);
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

  setWindDirection(direction: Vector3): void {
    this.windDirection = direction.normalize();
    if (this.material) {
      this.material.setVector3("uWindDirection", this.windDirection);
    }
  }

  setWindSpeed(speed: number): void {
    this.windSpeed = speed;
    if (this.material) {
      this.material.setFloat("uWindSpeed", this.windSpeed);
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
      this.particleMesh.dispose();
      this.particleMesh = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
  }

  setEnabled(enabled: boolean): void {
    if (this.particleMesh) {
      this.particleMesh.setEnabled(enabled);
    }
  }

  dispose(): void {
    if (this.renderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.renderObserver);
      this.renderObserver = null;
    }
    this.disposeParticles();
  }
}
