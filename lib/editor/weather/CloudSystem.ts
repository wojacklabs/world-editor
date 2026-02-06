import * as THREE from "three";
import { disposeMesh, createDataTexture } from "../../shared/rendering/threeHelpers";

// Cloud layer vertex shader
const cloudLayerVertexShader = `
uniform vec3 uCameraPosition;
uniform float uLayerHeight;
uniform float uLayerScale;

varying vec2 vUV;
varying vec3 vWorldPosition;
varying float vDistanceToCamera;

void main() {
    // Position layer at specified height, centered on camera
    vec3 worldPos = position * uLayerScale;
    worldPos.y = uLayerHeight;
    worldPos.xz += uCameraPosition.xz;

    vWorldPosition = worldPos;
    vUV = uv;
    vDistanceToCamera = length(worldPos - uCameraPosition);

    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
}
`;

// Cloud layer fragment shader
const cloudLayerFragmentShader = `
precision highp float;

varying vec2 vUV;
varying vec3 vWorldPosition;
varying float vDistanceToCamera;

uniform sampler2D uNoiseTexture;
uniform float uTime;
uniform float uCloudCoverage;
uniform float uCloudDensity;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec2 uWindOffset;
uniform float uLayerOpacity;

// FBM for cloud density
float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    float frequency = 1.0;

    for (int i = 0; i < 4; i++) {
        value += amplitude * texture2D(uNoiseTexture, p * frequency).r;
        frequency *= 2.0;
        amplitude *= 0.5;
    }
    return value;
}

void main() {
    // Animated UV with wind
    vec2 uv = vUV + uWindOffset;

    // Multi-octave cloud density at multiple scales
    float density = fbm(uv * 1.5);
    density += fbm(uv * 3.0 + 0.5) * 0.5;
    density = density / 1.5; // Normalize

    // Apply coverage threshold - more gradual transition
    float coverage = uCloudCoverage * uCloudDensity;
    float threshold = 0.3 + (1.0 - coverage) * 0.4; // 0.3 to 0.7 based on coverage
    density = smoothstep(threshold - 0.2, threshold + 0.3, density);

    // Cloud lighting (simple top-lit model)
    float lightFactor = 0.7 + 0.3 * max(0.0, uSunDirection.y);

    // Darker undersides for depth
    float undersideDark = mix(0.7, 1.0, smoothstep(0.2, 0.6, density));

    // Base cloud color - brighter
    vec3 cloudColor = vec3(0.95, 0.97, 1.0) * lightFactor * undersideDark;

    // Sun tint at edges (sunset/sunrise effect)
    float sunTint = pow(max(0.0, dot(normalize(vWorldPosition), uSunDirection)), 3.0);
    cloudColor = mix(cloudColor, uSunColor, sunTint * 0.25 * (1.0 - uSunDirection.y));

    // Soft edges
    float alpha = smoothstep(0.0, 0.4, density) * uLayerOpacity;

    // Distance fade (fade out at horizon) - increased distance
    float distanceFade = 1.0 - smoothstep(400.0, 800.0, vDistanceToCamera);
    alpha *= distanceFade;

    // Edge fade for layer boundaries
    vec2 edgeUV = abs(vUV - 0.5) * 2.0;
    float edgeFade = 1.0 - smoothstep(0.75, 0.95, max(edgeUV.x, edgeUV.y));
    alpha *= edgeFade;

    gl_FragColor = vec4(cloudColor, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

interface CloudLayerConfig {
  height: number;
  scale: number;
  density: number;
  opacity: number;
  windMultiplier: number;
}

const DEFAULT_LAYERS: CloudLayerConfig[] = [
  { height: 80, scale: 600, density: 1.0, opacity: 0.85, windMultiplier: 1.0 },
  { height: 120, scale: 800, density: 0.85, opacity: 0.7, windMultiplier: 1.2 },
  { height: 160, scale: 1000, density: 0.7, opacity: 0.5, windMultiplier: 1.4 },
];

interface CloudLayer {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  config: CloudLayerConfig;
}

export class CloudSystem {
  private scene: THREE.Scene;
  private layers: CloudLayer[] = [];
  private noiseTexture: THREE.DataTexture | null = null;

  // State
  private cloudCoverage: number = 0.3;
  private windSpeed: number = 0.2;
  private windDirection: number = 45;
  private sunDirection: THREE.Vector3 = new THREE.Vector3(0.5, 0.8, 0.3).normalize();
  private sunColor: THREE.Color = new THREE.Color(1.0, 0.95, 0.85);

  // Animation
  private windOffset: THREE.Vector2 = new THREE.Vector2(0, 0);
  private startTime: number = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.startTime = performance.now() / 1000;
  }

  init(): void {
    this.generateNoiseTexture();
    this.createCloudLayers();
  }

  private generateNoiseTexture(): void {
    const size = 256;
    const data = new Uint8Array(size * size * 4);

    // Generate Perlin-like noise
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;

        // Multi-frequency noise
        let noise = 0;
        let amplitude = 1;
        let frequency = 1;
        let maxValue = 0;

        for (let octave = 0; octave < 6; octave++) {
          const nx = x * frequency / size;
          const ny = y * frequency / size;

          // Simple value noise
          const hash = Math.sin(nx * 12.9898 + ny * 78.233) * 43758.5453;
          noise += (Math.abs(hash - Math.floor(hash)) - 0.5) * 2 * amplitude;

          maxValue += amplitude;
          amplitude *= 0.5;
          frequency *= 2;
        }

        noise = (noise / maxValue + 1) * 0.5; // Normalize to 0-1
        const value = Math.floor(noise * 255);

        data[i] = value;     // R
        data[i + 1] = value; // G
        data[i + 2] = value; // B
        data[i + 3] = 255;   // A
      }
    }

    this.noiseTexture = createDataTexture(data, size, size);
  }

  private createCloudLayers(): void {
    for (const config of DEFAULT_LAYERS) {
      this.createLayer(config);
    }
  }

  private createLayer(config: CloudLayerConfig): void {
    // Create horizontal plane for cloud layer
    const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
    // Rotate plane to be horizontal (PlaneGeometry faces +Z by default in Three.js)
    geo.rotateX(-Math.PI / 2);

    const material = new THREE.ShaderMaterial({
      vertexShader: cloudLayerVertexShader,
      fragmentShader: cloudLayerFragmentShader,
      uniforms: {
        uCameraPosition: { value: new THREE.Vector3() },
        uLayerHeight: { value: config.height },
        uLayerScale: { value: config.scale },
        uNoiseTexture: { value: this.noiseTexture },
        uTime: { value: 0 },
        uCloudCoverage: { value: this.cloudCoverage },
        uCloudDensity: { value: config.density },
        uSunDirection: { value: this.sunDirection.clone() },
        uSunColor: { value: this.sunColor.clone() },
        uWindOffset: { value: this.windOffset.clone() },
        uLayerOpacity: { value: config.opacity },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(geo, material);
    mesh.raycast = () => {};
    mesh.frustumCulled = false;

    this.scene.add(mesh);
    this.layers.push({ mesh, material, config });
  }

  /** Call each frame to animate clouds */
  update(camera?: THREE.Camera): void {
    const time = (performance.now() / 1000) - this.startTime;

    // Calculate wind offset
    const windRad = (this.windDirection * Math.PI) / 180;
    const windDelta = this.windSpeed * time * 0.02;
    this.windOffset.x = Math.cos(windRad) * windDelta;
    this.windOffset.y = Math.sin(windRad) * windDelta;

    // Update all layers
    for (const layer of this.layers) {
      const windMult = layer.config.windMultiplier;

      layer.material.uniforms.uTime.value = time;
      layer.material.uniforms.uWindOffset.value.set(
        this.windOffset.x * windMult,
        this.windOffset.y * windMult
      );

      if (camera) {
        layer.material.uniforms.uCameraPosition.value.copy(camera.position);
      }
    }
  }

  // Public setters
  setCloudCoverage(coverage: number): void {
    this.cloudCoverage = coverage;
    for (const layer of this.layers) {
      layer.material.uniforms.uCloudCoverage.value = coverage;
    }
  }

  setWindSpeed(speed: number): void {
    this.windSpeed = speed;
  }

  setWindDirection(direction: number): void {
    this.windDirection = direction;
  }

  setSunDirection(direction: THREE.Vector3): void {
    this.sunDirection.copy(direction).normalize();
    for (const layer of this.layers) {
      layer.material.uniforms.uSunDirection.value.copy(this.sunDirection);
    }
  }

  setSunColor(color: THREE.Color): void {
    this.sunColor.copy(color);
    for (const layer of this.layers) {
      layer.material.uniforms.uSunColor.value.copy(this.sunColor);
    }
  }

  setEnabled(enabled: boolean): void {
    for (const layer of this.layers) {
      layer.mesh.visible = enabled;
    }
  }

  dispose(): void {
    for (const layer of this.layers) {
      disposeMesh(this.scene, layer.mesh);
    }
    this.layers = [];

    if (this.noiseTexture) {
      this.noiseTexture.dispose();
      this.noiseTexture = null;
    }
  }
}
