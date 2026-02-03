import { Scene, Texture } from "@babylonjs/core";
import { isKTX2Enabled } from "./KTX2State";

export interface TextureFallbackOptions {
  preferredExtensions?: string[];
  fallbackExtensions?: string[];
  noMipmap?: boolean;
  invertY?: boolean;
  samplingMode?: number;
  anisotropicFilteringLevel?: number;
  wrapU?: number;
  wrapV?: number;
  level?: number;
}

const DEFAULT_EXTENSIONS = ["ktx2", "jpg", "png"];

function isKTX2Extension(ext: string): boolean {
  return ext.toLowerCase().replace(".", "") === "ktx2";
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

export function loadTextureWithFallback(
  scene: Scene,
  pathOrBase: string,
  options: TextureFallbackOptions = {}
): Texture {
  const candidates = buildTextureCandidates(pathOrBase, options);
  const first = candidates[0] ?? pathOrBase;
  let candidateIndex = 0;

  const texture = new Texture(
    first,
    scene,
    options.noMipmap ?? false,
    options.invertY ?? false,
    options.samplingMode
  );

  if (options.anisotropicFilteringLevel !== undefined) {
    texture.anisotropicFilteringLevel = options.anisotropicFilteringLevel;
  }
  if (options.wrapU !== undefined) {
    texture.wrapU = options.wrapU;
  }
  if (options.wrapV !== undefined) {
    texture.wrapV = options.wrapV;
  }
  if (options.level !== undefined) {
    texture.level = options.level;
  }

  const textureAny = texture as Texture & {
    onErrorObservable?: { add: (fn: () => void) => void };
    updateURL?: (url: string) => void;
  };

  const tryNextCandidate = (): void => {
    if (candidateIndex >= candidates.length - 1) {
      return;
    }
    candidateIndex += 1;
    const next = candidates[candidateIndex];
    if (textureAny.updateURL) {
      textureAny.updateURL(next);
    }
  };

  if (textureAny.onErrorObservable?.add) {
    textureAny.onErrorObservable.add(tryNextCandidate);
  }

  return texture;
}
