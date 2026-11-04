import * as THREE from "three"

// Pristine chunks, captured before any overrides
const BASE = {
  lights_pars_begin: THREE.ShaderChunk.lights_pars_begin,
  lights_fragment_begin: THREE.ShaderChunk.lights_fragment_begin,
  lights_physical_pars_fragment: THREE.ShaderChunk.lights_physical_pars_fragment,
  shadowmap_vertex: THREE.ShaderChunk.shadowmap_vertex,
  shadowmap_pars_fragment: THREE.ShaderChunk.shadowmap_pars_fragment,
}

/**
 * Diffuse only shading. The look was tuned on a light loop that never set up
 * the specular terms, so materials render as Fresnel weighted Lambert plus
 * diffuse sky light. Doing exactly that, and nothing else, skips GGX, the DFG
 * lookup and the specular environment fetch on every fragment.
 */
const DIFFUSE = /* glsl */ `
void RE_Direct_Diffuse( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
  vec3 halfDir = normalize( directLight.direction + geometryViewDir );
  vec3 F = F_Schlick( material.specularColor, material.specularF90, saturate( dot( geometryViewDir, halfDir ) ) );
  reflectedLight.directDiffuse += dotNL * directLight.color * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Diffuse
#undef RE_IndirectSpecular
`

/**
 * Shared shader state for every lit material in the scene: height fog, cloud
 * and drone shadows and the noise texture. Uniform objects are shared by
 * reference, so updating `.value` here updates every program.
 */
export const shared = {
  dNoise: { value: null as THREE.Texture | null },
  dSunDir: { value: new THREE.Vector3(0, 1, 0) },
  dSunColor: { value: new THREE.Color(0, 0, 0) },
  dFogFalloff: { value: 0.012 },
  dFogBase: { value: 0 },
  dCloudShadow: { value: 0 },
  dCloudOffset: { value: new THREE.Vector2() },
  dCloudScale: { value: 1 / 900 },
  dTime: { value: 0 },
  /** Frame counter, rotates temporal sampling patterns. */
  dFrame: { value: 0 },
  /** Drone position and shadow radius, for its analytic shadow. w = 0 disables. */
  dDrone: { value: new THREE.Vector4() },
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
uniform vec4 dDrone;
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
// The quad is too small and moves too much for the cached shadow maps, so
// it casts an analytic soft shadow: a sphere occluding the sun.
float dDroneShadowAt(vec3 wp) {
  if (dDrone.w <= 0.0) return 1.0;
  vec3 d = dDrone.xyz - wp;
  float along = dot(d, dSunDir);
  if (along < dDrone.w) return 1.0;
  float off = sqrt(max(dot(d, d) - along * along, 0.0));
  // Penumbra widens with distance (sun is ~0.5 degrees across)
  float pen = dDrone.w * 0.5 + along * 0.0093;
  float occ = 1.0 - smoothstep(dDrone.w - pen, dDrone.w + pen, off);
  return 1.0 - occ * 0.8 * (1.0 - smoothstep(4.0, 12.0, along));
}
#endif
`

/**
 * One sun, shaded once. Its shadow comes from the first cascade that covers
 * the fragment, dithered into the next one near the edge so only one map is
 * sampled; the last cascade fades out instead.
 */
const SUN = /* glsl */ `
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
{
  getDirectionalLightInfo( directionalLights[ 0 ], directLight );
  vec3 dWp = dWorldFromView( geometryPosition );
  float dSh = dCloudShadowAt( dWp ) * dDroneShadowAt( dWp );
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  if ( receiveShadow ) dSh *= dSunShadow( dWp, ( vec4( geometryNormal, 0.0 ) * viewMatrix ).xyz );
  #endif
  directLight.color *= dSh;
  RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
}
#endif
`

/**
 * Cascade shadow lookup, fragment side. Shadow coordinates are computed here
 * for the one cascade used instead of interpolating all of them from the
 * vertex shader. A couple of PCF taps on a Vogel disk rotated every frame;
 * TAA integrates them into a soft edge.
 */
const SHADOW_PARS = /* glsl */ `
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
uniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];
uniform float dFrame;
float dShadowMap( sampler2DShadow map, DirectionalLightShadow s, vec3 c ) {
  float phi = fract( 52.9829189 * fract( dot( gl_FragCoord.xy + 5.588238 * dFrame, vec2( 0.06711056, 0.00583715 ) ) ) ) * 6.2831853;
  float r = s.shadowRadius / s.shadowMapSize.x;
  vec2 o0 = vec2( cos( phi ), sin( phi ) ) * r * 0.5;
  vec2 o1 = vec2( -o0.y, o0.x ) * 1.6;
  c.z += s.shadowBias;
  float v = texture( map, vec3( c.xy + o0, c.z ) ) + texture( map, vec3( c.xy - o1, c.z ) );
  return mix( 1.0, v * 0.5, s.shadowIntensity );
}
float dSunShadow( vec3 wp, vec3 wn ) {
  float dither = fract( 52.9829189 * fract( dot( gl_FragCoord.xy + 7.123 * dFrame, vec2( 0.06711056, 0.00583715 ) ) ) );
  vec3 c; vec2 e; float t;
  ${[0, 1, 2]
    .map(
      (i) => `
  #if NUM_DIR_LIGHT_SHADOWS > ${i}
  {
    DirectionalLightShadow s = directionalLightShadows[ ${i} ];
    c = ( directionalShadowMatrix[ ${i} ] * vec4( wp + wn * s.shadowNormalBias, 1.0 ) ).xyz;
    e = min( c.xy, 1.0 - c.xy );
    t = min( e.x, e.y ) / 0.06;
    if ( t > 0.0 && c.z <= 1.0 ) {
      #if NUM_DIR_LIGHT_SHADOWS == ${i + 1}
        return mix( 1.0, dShadowMap( directionalShadowMap[ ${i} ], s, c ), clamp( t, 0.0, 1.0 ) );
      #else
        // Dither into the next cascade near the edge
        if ( t > dither ) return dShadowMap( directionalShadowMap[ ${i} ], s, c );
      #endif
    }
  }
  #endif`,
    )
    .join("")}
  return 1.0;
}
#endif
`

function lightsFragment() {
  // No specular, so no DFG lookup or energy compensation
  const src = BASE.lights_fragment_begin
    .replace(
      "material.dfg = texture2D( dfgLUT, vec2( material.roughness, dotNVms ) ).rg;",
      "material.dfg = vec2( 0.0 );",
    )
    .replace(
      "material.multiScatteringCompensation = 1.0 + material.specularColorBlended * ( 1.0 / EssMs - 1.0 );",
      "material.multiScatteringCompensation = vec3( 0.0 );",
    )
  const a = src.indexOf("#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )")
  const b = src.indexOf("#if ( NUM_RECT_AREA_LIGHTS > 0 )")
  if (a < 0 || b < a) throw new Error("lights_fragment_begin layout changed")
  return src.slice(0, a) + SUN + "\n" + src.slice(b)
}

let installed = false

/** Install the shader chunk overrides. */
export function installChunks() {
  if (installed) return
  installed = true
  const C = THREE.ShaderChunk

  C.lights_pars_begin = DECL + BASE.lights_pars_begin
  C.shadowmap_pars_fragment = BASE.shadowmap_pars_fragment + SHADOW_PARS
  C.lights_fragment_begin = lightsFragment()
  C.lights_physical_pars_fragment = BASE.lights_physical_pars_fragment + DIFFUSE
  // Directional shadow coords are computed per fragment, see SHADOW_PARS
  const sv = BASE.shadowmap_vertex
  const a = sv.indexOf("\t#if NUM_DIR_LIGHT_SHADOWS > 0")
  const b = sv.indexOf("\t#if NUM_POINT_LIGHT_SHADOWS > 0")
  if (a < 0 || b < a) throw new Error("shadowmap_vertex layout changed")
  C.shadowmap_vertex = sv.slice(0, a) + sv.slice(b)
  // Indirect: hemisphere fill plus diffuse sky light from the env map
  C.lights_fragment_end = /* glsl */ `
#if defined( RE_IndirectDiffuse )
  #if defined( LAMBERT ) || defined( PHONG )
  irradiance += iblIrradiance;
  #endif
  RE_IndirectDiffuse( irradiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  #ifdef STANDARD
  reflectedLight.indirectDiffuse += material.diffuseContribution * iblIrradiance * RECIPROCAL_PI;
  #endif
#endif`

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

/**
 * Hook a material into the shared shading. `hook` and `key` let callers add
 * their own shader edits (terrain, grass).
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

/** Force recompiles, e.g. after toggling the shadow map. */
export function invalidateMaterials() {
  for (const m of tracked) m.needsUpdate = true
}
