import * as THREE from "three"
import * as CSMShaderModule from "three/examples/jsm/csm/CSMShader.js"

// @types/three declares CSMShader as an interface only; the module exports an object
const { CSMShader } = CSMShaderModule as unknown as {
  CSMShader: { lights_fragment_begin: string; lights_pars_begin: string }
}

/**
 * Shared shader state for every lit material in the scene: cascaded shadow
 * splits, height fog, cloud shadows and the noise texture. Uniform objects are
 * shared by reference, so updating `.value` here updates every program.
 */
export const shared = {
  CSM_cascades: { value: [] as THREE.Vector2[] },
  cameraNear: { value: 0.05 },
  shadowFar: { value: 200 },
  dNoise: { value: null as THREE.Texture | null },
  dSunDir: { value: new THREE.Vector3(0, 1, 0) },
  dSunColor: { value: new THREE.Color(0, 0, 0) },
  dFogFalloff: { value: 0.012 },
  dFogBase: { value: 0 },
  dCloudShadow: { value: 0 },
  dCloudOffset: { value: new THREE.Vector2() },
  dCloudScale: { value: 1 / 900 },
  dTime: { value: 0 },
}

/** Declarations shared by fog and lighting chunks, guarded so they are emitted once. */
export const DECL = /* glsl */ `
#ifndef DEBRIS_DECL
#define DEBRIS_DECL
uniform sampler2D dNoise;
uniform vec3 dSunDir;
uniform vec3 dSunColor;
uniform float dFogFalloff;
uniform float dFogBase;
uniform float dCloudShadow;
uniform vec2 dCloudOffset;
uniform float dCloudScale;
uniform float dTime;
// View space to world space without an inverse: transpose of the view rotation.
vec3 dWorldFromView(vec3 viewPos) { return (vec4(viewPos, 0.0) * viewMatrix).xyz + cameraPosition; }
float dCloudShadowAt(vec3 wp) {
  if (dCloudShadow <= 0.0) return 1.0;
  // Project along the sun onto a cloud layer ~700 m up
  vec2 p = wp.xz + dSunDir.xz / max(dSunDir.y, 0.12) * (700.0 - wp.y);
  vec2 uv = p * dCloudScale + dCloudOffset;
  float n = texture(dNoise, uv).r * 0.65 + texture(dNoise, uv * 2.9 + 0.37).g * 0.35;
  return 1.0 - dCloudShadow * smoothstep(0.48, 0.66, n);
}
#endif
`

let installed = false

/** Install the shader chunk overrides. Call again after creating a CSM, which injects its own. */
export function installChunks(force = false) {
  if (installed && !force) return
  installed = true
  const C = THREE.ShaderChunk

  C.lights_pars_begin = DECL + CSMShader.lights_pars_begin
  // CSM light loop, with cloud shadowing on the sun
  C.lights_fragment_begin = CSMShader.lights_fragment_begin
    .replace(
      "IncidentLight directLight;",
      "IncidentLight directLight;\nfloat dCloud = dCloudShadowAt( dWorldFromView( geometryPosition ) );",
    )
    .replaceAll(
      "getDirectionalLightInfo( directionalLight, directLight );",
      "getDirectionalLightInfo( directionalLight, directLight );\n\t\t\tdirectLight.color *= dCloud;",
    )
    .replace(
      "getDirectionalLightInfo( directionalLights[0], directLight );",
      "getDirectionalLightInfo( directionalLights[0], directLight );\n\t\tdirectLight.color *= dCloud;",
    )

  C.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
varying vec3 vFogRay;
#endif`
  C.fog_vertex = /* glsl */ `
#ifdef USE_FOG
vFogRay = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;
#endif`
  C.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
${DECL}
uniform vec3 fogColor;
varying vec3 vFogRay;
#ifdef FOG_EXP2
uniform float fogDensity;
#else
uniform float fogNear;
uniform float fogFar;
#endif
#endif`
  // Height fog with analytic integration along the view ray. Color comes from
  // the prefiltered sky so distant terrain dissolves into the actual horizon.
  C.fog_fragment = /* glsl */ `
#ifdef USE_FOG
{
  float fogDist = length( vFogRay );
  vec3 fogDir = vFogRay / max( fogDist, 1e-4 );
  #ifdef FOG_EXP2
    float fb = max( dFogFalloff, 1e-5 );
    float fk = fb * fogDir.y * fogDist;
    float fInteg = abs( fk ) > 1e-3 ? ( 1.0 - exp( -fk ) ) / ( fb * fogDir.y ) : fogDist;
    float fogFactor = 1.0 - exp( -fogDensity * exp( -fb * ( cameraPosition.y - dFogBase ) ) * fInteg );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, fogDist );
  #endif
  vec3 fogCol = fogColor;
  #ifdef ENVMAP_TYPE_CUBE_UV
    vec3 skyDir = normalize( vec3( fogDir.x, max( fogDir.y, 0.02 ), fogDir.z ) );
    fogCol = textureCubeUV( envMap, envMapRotation * skyDir, 0.3 ).rgb;
  #endif
  fogCol += dSunColor * pow( max( dot( fogDir, dSunDir ), 0.0 ), 8.0 );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogCol, fogFactor );
}
#endif`
}

export type ShaderHook = (shader: THREE.WebGLProgramParametersWithUniforms) => void

const tracked = new Set<THREE.Material>()
let cascades = 3

const isLit = (m: THREE.Material) =>
  (m as THREE.MeshStandardMaterial).isMeshStandardMaterial ||
  (m as THREE.MeshLambertMaterial).isMeshLambertMaterial ||
  (m as THREE.MeshPhongMaterial).isMeshPhongMaterial ||
  (m as THREE.MeshToonMaterial).isMeshToonMaterial

function applyDefines(m: THREE.Material) {
  if (!isLit(m)) return
  const d = (m.defines ??= {})
  if (d.USE_CSM === 1 && d.CSM_CASCADES === cascades) return
  d.USE_CSM = 1
  d.CSM_CASCADES = cascades
  d.CSM_FADE = ""
  m.needsUpdate = true
}

/**
 * Hook a material into the shared shading. Every lit material must go through
 * this, since the CSM light chunk replaces the default directional light loop.
 * `hook` and `key` let callers add their own shader edits (terrain, grass).
 */
export function patchMaterial(m: THREE.Material, hook?: ShaderHook, key = "") {
  installChunks()
  if (tracked.has(m)) return m
  tracked.add(m)
  m.addEventListener("dispose", () => tracked.delete(m))
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared)
    hook?.(shader)
  }
  m.customProgramCacheKey = () => `debris:${key}`
  applyDefines(m)
  return m
}

/** Patch every material under an object. */
export function patchTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const mat = (o as THREE.Mesh).material
    if (!mat) return
    for (const m of Array.isArray(mat) ? mat : [mat]) patchMaterial(m)
  })
}

export function setCascadeCount(n: number) {
  installChunks()
  cascades = n
  while (shared.CSM_cascades.value.length < n) shared.CSM_cascades.value.push(new THREE.Vector2())
  shared.CSM_cascades.value.length = n
  for (const m of tracked) applyDefines(m)
}

/** Force recompiles, e.g. after toggling the shadow map. */
export function invalidateMaterials() {
  for (const m of tracked) m.needsUpdate = true
}
