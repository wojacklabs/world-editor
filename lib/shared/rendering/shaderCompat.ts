/**
 * Babylon.js → Three.js shader compatibility utilities.
 *
 * Babylon.js injects built-in uniforms/attributes with specific names.
 * Three.js ShaderMaterial auto-injects equivalents under different names.
 *
 * Mapping:
 *   Babylon.js                    Three.js (auto-injected)
 *   ─────────────────────────     ──────────────────────────
 *   attribute vec3 position       → auto (no declaration needed)
 *   attribute vec3 normal         → auto
 *   attribute vec2 uv             → auto
 *   uniform mat4 world            → modelMatrix
 *   uniform mat4 worldViewProjection → projectionMatrix * modelViewMatrix
 *   uniform mat4 viewProjection   → projectionMatrix * viewMatrix
 *   uniform mat4 view             → viewMatrix
 *   uniform mat4 projection       → projectionMatrix
 *
 * Thin Instance → InstancedMesh:
 *   Babylon.js: attribute vec4 world0, world1, world2, world3;
 *   Three.js:   attribute mat4 instanceMatrix; (auto-injected for InstancedMesh)
 *               modelMatrix already includes instance transform.
 */

/**
 * Adapt a Babylon.js vertex shader string for use with Three.js ShaderMaterial.
 *
 * - Removes explicit declarations for auto-injected attributes (position, normal, uv).
 * - Renames built-in uniform matrices.
 * - Replaces thin-instance world0-world3 with instanceMatrix.
 */
export function adaptVertexShader(src: string): string {
  let s = src;

  // Remove Babylon.js auto-injected attribute declarations
  s = s.replace(/^\s*attribute\s+vec3\s+position\s*;.*$/gm, "");
  s = s.replace(/^\s*attribute\s+vec3\s+normal\s*;.*$/gm, "");
  s = s.replace(/^\s*attribute\s+vec2\s+uv\s*;.*$/gm, "");
  s = s.replace(/^\s*attribute\s+vec4\s+color\s*;.*$/gm, "");

  // Rename Babylon.js built-in uniform matrices
  // Order matters: worldViewProjection before world to avoid partial replace
  s = s.replace(/\bworldViewProjection\b/g, "(projectionMatrix * modelViewMatrix)");
  s = s.replace(/\bviewProjection\b/g, "(projectionMatrix * viewMatrix)");

  // 'world' as a standalone uniform → modelMatrix
  // Must not match 'worldPosition' or other compound names already handled
  s = s.replace(/\buniform\s+mat4\s+world\s*;/g, "// world → modelMatrix (auto-injected)");
  s = s.replace(/(?<!\w)world(?!\w|View|Position|Normal|Tangent)/g, "modelMatrix");

  // Remove 'uniform mat4 view;' and 'uniform mat4 projection;' (auto-injected)
  s = s.replace(/^\s*uniform\s+mat4\s+view\s*;.*$/gm, "// view → viewMatrix (auto-injected)");
  s = s.replace(/^\s*uniform\s+mat4\s+projection\s*;.*$/gm, "// projection → projectionMatrix (auto-injected)");

  // Rename remaining usages
  s = s.replace(/(?<!\w)view(?!\w|Matrix|Projection|Port|Dir)/g, "viewMatrix");
  s = s.replace(/(?<!\w)projection(?!\w|Matrix)/g, "projectionMatrix");

  return s;
}

/**
 * Adapt a Babylon.js fragment shader string for use with Three.js ShaderMaterial.
 * Fragment shaders generally need fewer changes — mostly precision qualifiers.
 */
export function adaptFragmentShader(src: string): string {
  // Three.js auto-prepends precision; remove duplicate if present
  let s = src.replace(/^\s*precision\s+(highp|mediump|lowp)\s+float\s*;.*$/gm, "");
  return s;
}

/**
 * Replace Babylon.js thin-instance attribute pattern with Three.js instanceMatrix.
 *
 * Babylon.js thin instances use 4 vec4 attributes (world0-world3) to pass
 * the per-instance world matrix. Three.js InstancedMesh auto-injects
 * `attribute mat4 instanceMatrix` and folds it into modelMatrix.
 *
 * This function:
 * 1. Removes world0-world3 attribute declarations
 * 2. Removes the mat4 worldMatrix construction from those attributes
 * 3. Replaces worldMatrix usage with modelMatrix (which includes instance transform)
 */
export function adaptThinInstanceVertex(src: string): string {
  let s = src;

  // Remove world0-world3 attribute declarations
  s = s.replace(/^\s*attribute\s+vec4\s+world[0-3]\s*;.*$/gm, "");

  // Remove mat4 worldMatrix = mat4(world0, world1, world2, world3);
  s = s.replace(
    /^\s*mat4\s+worldMatrix\s*=\s*mat4\s*\(\s*world0\s*,\s*world1\s*,\s*world2\s*,\s*world3\s*\)\s*;.*$/gm,
    ""
  );

  // worldMatrix → modelMatrix (Three.js auto-includes instance transform)
  s = s.replace(/\bworldMatrix\b/g, "modelMatrix");

  return s;
}
