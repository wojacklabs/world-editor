import * as THREE from "three";
import { isKTX2Enabled } from "./KTX2State";

export interface TextureFallbackOptions {
  preferredExtensions?: string[];
  fallbackExtensions?: string[];
  noMipmap?: boolean;
  flipY?: boolean;
  anisotropy?: number;
  wrapS?: THREE.Wrapping;
  wrapT?: THREE.Wrapping;
  colorSpace?: THREE.ColorSpace;
}

const DEFAULT_EXTENSIONS = ["ktx2", "jpg", "png"];

function isKTX2Extension(ext: string): boolean {
  return ext.toLowerCase().replace(".", "") === "ktx2";
}

function stripExtension(path: string): string {
  const qIdx = path.indexOf("?");
  const clean = qIdx >= 0 ? path.slice(0, qIdx) : path;
  const dotIdx = clean.lastIndexOf(".");
  const slashIdx = clean.lastIndexOf("/");
  if (dotIdx > slashIdx) {
    return clean.slice(0, dotIdx);
  }
  return clean;
}

function hasExtension(path: string): boolean {
  const qIdx = path.indexOf("?");
  const clean = qIdx >= 0 ? path.slice(0, qIdx) : path;
  const dotIdx = clean.lastIndexOf(".");
  const slashIdx = clean.lastIndexOf("/");
  return dotIdx > slashIdx;
}

function getFileExtension(path: string): string | null {
  const qIdx = path.indexOf("?");
  const clean = qIdx >= 0 ? path.slice(0, qIdx) : path;
  const dotIdx = clean.lastIndexOf(".");
  const slashIdx = clean.lastIndexOf("/");
  if (dotIdx > slashIdx) {
    return clean.slice(dotIdx + 1).toLowerCase();
  }
  return null;
}

function filterUnsupportedExtensions(extensions: string[]): string[] {
  if (isKTX2Enabled()) {
    return extensions;
  }
  return extensions.filter((ext) => !isKTX2Extension(ext));
}

export function buildTextureCandidates(
  pathOrBase: string,
  options: TextureFallbackOptions = {}
): string[] {
  const preferred = filterUnsupportedExtensions(
    options.preferredExtensions ?? []
  );
  const fallback = filterUnsupportedExtensions(
    options.fallbackExtensions ?? DEFAULT_EXTENSIONS
  );
  const fallbackFinal = fallback.length > 0 ? fallback : ["jpg", "png"];
  const extOrder = Array.from(new Set([...preferred, ...fallback]));
  const basePath = stripExtension(pathOrBase);

  const candidates: string[] = [];

  if (hasExtension(pathOrBase)) {
    const explicitExt = getFileExtension(pathOrBase);
    if (!(explicitExt && isKTX2Extension(explicitExt) && !isKTX2Enabled())) {
      candidates.push(pathOrBase);
    }
  }

  for (const ext of extOrder.length > 0 ? extOrder : fallbackFinal) {
    candidates.push(`${basePath}.${ext}`);
  }

  return Array.from(new Set(candidates));
}

const loader = new THREE.TextureLoader();

/**
 * Load a texture with fallback chain (ktx2 → jpg → png).
 * Returns a Promise that resolves with the loaded texture.
 */
export function loadTextureWithFallback(
  pathOrBase: string,
  options: TextureFallbackOptions = {}
): Promise<THREE.Texture> {
  const candidates = buildTextureCandidates(pathOrBase, options);

  function tryLoad(index: number): Promise<THREE.Texture> {
    if (index >= candidates.length) {
      return Promise.reject(
        new Error(`All texture candidates failed for: ${pathOrBase}`)
      );
    }

    return new Promise<THREE.Texture>((resolve, reject) => {
      loader.load(
        candidates[index],
        (texture) => {
          if (options.noMipmap) {
            texture.generateMipmaps = false;
            texture.minFilter = THREE.LinearFilter;
          }
          texture.flipY = options.flipY ?? true;
          texture.wrapS = options.wrapS ?? THREE.RepeatWrapping;
          texture.wrapT = options.wrapT ?? THREE.RepeatWrapping;
          if (options.anisotropy !== undefined) {
            texture.anisotropy = options.anisotropy;
          }
          if (options.colorSpace) {
            texture.colorSpace = options.colorSpace;
          }
          resolve(texture);
        },
        undefined,
        () => {
          // Try next candidate
          tryLoad(index + 1).then(resolve, reject);
        }
      );
    });
  }

  return tryLoad(0);
}

/**
 * Synchronous variant that returns a placeholder texture immediately,
 * then updates it when the actual texture loads. Useful for shader uniforms
 * that need an initial value.
 */
export function loadTextureWithFallbackSync(
  pathOrBase: string,
  options: TextureFallbackOptions = {}
): THREE.Texture {
  // Create 1x1 pixel placeholder to avoid "no image data found" warning
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 1, 1);
  }
  const placeholder = new THREE.Texture(canvas);
  placeholder.wrapS = options.wrapS ?? THREE.RepeatWrapping;
  placeholder.wrapT = options.wrapT ?? THREE.RepeatWrapping;

  loadTextureWithFallback(pathOrBase, options).then(
    (loaded) => {
      (placeholder as THREE.Texture).image = loaded.image;
      placeholder.format = loaded.format;
      placeholder.type = loaded.type;
      placeholder.flipY = loaded.flipY;
      placeholder.wrapS = loaded.wrapS;
      placeholder.wrapT = loaded.wrapT;
      placeholder.generateMipmaps = loaded.generateMipmaps;
      placeholder.minFilter = loaded.minFilter;
      placeholder.magFilter = loaded.magFilter;
      if (loaded.colorSpace) {
        placeholder.colorSpace = loaded.colorSpace;
      }
      placeholder.needsUpdate = true;
    },
    (err) => {
      console.warn("[TextureLoader.three] All fallback candidates failed:", err);
    }
  );

  return placeholder;
}
