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
    frameColumns: 1,
    frameRows: 1,
    alphaCutoff: 0.88,
  },
  wind: {
    directionRadians: Math.PI * 0.25,
    baseStrength: 0.5,
    grassClumpStrength: 0.8,
    bushStrength: 0.4,
    treeStrength: 0.35,
    biomeGrassStrength: 0.15,
  },
  fade: {
    leafFadeStart: 45,
    leafFadeEnd: 115,
    biomeGrassFadeStart: 170,
    biomeGrassFadeEnd: 270,
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
