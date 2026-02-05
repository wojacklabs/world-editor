export interface RenderingTextureUrls {
  grass: string;
  dirt: string;
  rock: string;
  sand: string;
  leafAtlas: string;
}

export interface LeafAtlasProfile {
  path: string;
  frameColumns: number;
  frameRows: number;
  alphaCutoff: number;
}

export interface WindQualityProfile {
  directionRadians: number;
  baseStrength: number;
  grassClumpStrength: number;
  bushStrength: number;
  treeStrength: number;
  biomeGrassStrength: number;
  // Grass wind timing (FBM noise based)
  grassMacroSpeed: number;
  grassMicroSpeed: number;
  // Props wind timing (sine wave based)
  propsPrimarySpeed: number;
  propsSecondarySpeed: number;
  propsNoiseSpeed: number;
}

export interface FadeQualityProfile {
  leafFadeStart: number;
  leafFadeEnd: number;
  biomeGrassFadeStart: number;
  biomeGrassFadeEnd: number;
  biomeVariationStrength: number;
}

export interface GrassQualityProfile {
  windScale: number;
  windSecondaryStrength: number;
  bladeThickness: number;
  ditherMode: number;
  ditherPixelSize: number;
  stoneSuppression: number;
  stoneSuppressionStartWeight: number;
}

export interface FoliageQualityProfile {
  version: string;
  foliageProfileVersion: string;
  proceduralProfileVersion: string;
  textures: RenderingTextureUrls;
  leafAtlas: LeafAtlasProfile;
  wind: WindQualityProfile;
  fade: FadeQualityProfile;
  grass: GrassQualityProfile;
}

export interface WorldRenderingConfig {
  leafAtlas: string;
  foliageProfileVersion: string;
  proceduralProfileVersion: string;
  textureUrls: RenderingTextureUrls;
}

export const DEFAULT_FOLIAGE_QUALITY_PROFILE: FoliageQualityProfile = {
  version: "2.0.0",
  foliageProfileVersion: "2.0.0",
  proceduralProfileVersion: "2.0.0",
  textures: {
    grass: "/textures/grass_diff",
    dirt: "/textures/dirt_diffuse",
    rock: "/textures/rock_diff",
    sand: "/textures/grass_diff",
    leafAtlas: "/assets/references/infinite-terrain/alpha_leaves",
  },
  leafAtlas: {
    path: "/assets/references/infinite-terrain/alpha_leaves",
    frameColumns: 2,
    frameRows: 2,
    alphaCutoff: 0.88,
  },
  wind: {
    directionRadians: Math.PI * 0.25,
    baseStrength: 0.75,         // 0.5 × 1.5
    grassClumpStrength: 1.2,    // 0.8 × 1.5
    bushStrength: 0.6,          // 0.4 × 1.5
    treeStrength: 1.2,          // 0.8 × 1.5
    biomeGrassStrength: 1.05,   // 0.7 × 1.5
    // Grass wind timing (texture scroll - slower than direct noise)
    grassMacroSpeed: 0.4,
    grassMicroSpeed: 0.6,
    // Props wind timing
    propsPrimarySpeed: 0.5,
    propsSecondarySpeed: 1.5,
    propsNoiseSpeed: 0.2,
  },
  fade: {
    leafFadeStart: 200,      // Start fading later (was 45)
    leafFadeEnd: 9999,       // Never fully disappear (was 115)
    biomeGrassFadeStart: 300, // Start fading later (was 170)
    biomeGrassFadeEnd: 9999,  // Never fully disappear (was 270)
    biomeVariationStrength: 0.22,
  },
  grass: {
    windScale: 0.32,
    windSecondaryStrength: 0.45,
    bladeThickness: 0.012,
    ditherMode: 1,
    ditherPixelSize: 1.0,
    stoneSuppression: 0.65,
    stoneSuppressionStartWeight: 0.22,
  },
};

export function createWorldRenderingConfig(
  profile: FoliageQualityProfile = DEFAULT_FOLIAGE_QUALITY_PROFILE
): WorldRenderingConfig {
  return {
    leafAtlas: profile.leafAtlas.path,
    foliageProfileVersion: profile.foliageProfileVersion,
    proceduralProfileVersion: profile.proceduralProfileVersion,
    textureUrls: { ...profile.textures },
  };
}
