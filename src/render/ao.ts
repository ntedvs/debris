import * as THREE from "three"
import { Pass } from "postprocessing"

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4( position.xy, 1.0, 1.0 ); }`

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDepth;
uniform mat4 projInv;
uniform mat4 proj;
uniform vec2 texel;     // full res depth texel
uniform float radius;
uniform float falloff;
uniform float intensity;
uniform float frame;
varying vec2 vUv;

vec3 viewPos( vec2 uv, float d ) {
  vec4 p = projInv * vec4( vec3( uv, d ) * 2.0 - 1.0, 1.0 );
  return p.xyz / p.w;
}
vec3 viewAt( vec2 uv ) { return viewPos( uv, texture2D( tDepth, uv ).r ); }

void main() {
  float d = texture2D( tDepth, vUv ).r;
  if ( d >= 1.0 ) { gl_FragColor = vec4( 1.0 ); return; }
  if ( viewPos( vUv, d ).z < -150.0 ) { gl_FragColor = vec4( 1.0 ); return; }
  vec3 p = viewPos( vUv, d );
  // Normal from the flatter of each pair of neighbors, so edges don't smear
  vec2 o = texel * 2.0;
  vec3 l = viewAt( vUv - vec2( o.x, 0.0 ) ), r = viewAt( vUv + vec2( o.x, 0.0 ) );
  vec3 b = viewAt( vUv - vec2( 0.0, o.y ) ), t = viewAt( vUv + vec2( 0.0, o.y ) );
  vec3 dx = abs( r.z - p.z ) < abs( p.z - l.z ) ? r - p : p - l;
  vec3 dy = abs( t.z - p.z ) < abs( p.z - b.z ) ? t - p : p - b;
  vec3 n = normalize( cross( dx, dy ) );

  // Screen space radius of the world radius at this depth
  float rs = radius * proj[ 1 ][ 1 ] / -p.z * 0.5;
  rs = min( rs, 0.15 );
  float phi = fract( 52.9829189 * fract( dot( gl_FragCoord.xy + 5.588238 * frame, vec2( 0.06711056, 0.00583715 ) ) ) ) * 6.2831853;
  float occ = 0.0;
  const int N = 8;
  for ( int i = 0; i < N; i++ ) {
    // Vogel disk, rotated per pixel and per frame; TAA averages the noise
    float fi = float( i ) + 0.5;
    float a = fi * 2.3999632 + phi;
    vec2 s = vec2( cos( a ), sin( a ) ) * sqrt( fi / float( N ) ) * rs;
    vec3 q = viewAt( vUv + s * vec2( 1.0, texel.x / texel.y ) ) - p;
    float ql = length( q );
    float w = 1.0 - smoothstep( radius * 0.5, radius * falloff, ql );
    occ += max( dot( n, q ) / max( ql, 1e-3 ) - 0.1, 0.0 ) * w;
  }
  float ao = pow( max( 1.0 - occ / float( N ), 0.0 ), intensity );
  // Depth reconstructed normals fall apart far away at grazing angles
  ao = mix( ao, 1.0, smoothstep( 60.0, 150.0, -p.z ) );
  gl_FragColor = vec4( ao, ao, ao, 1.0 );
}`

/**
 * Lean screen space ambient occlusion at half resolution: depth reconstructed
 * normals, 8 samples, no denoise. The sample pattern rotates every frame and
 * TAA (which applies the AO) accumulates it into a smooth result.
 */
export class AOPass extends Pass {
  readonly target: THREE.WebGLRenderTarget
  private mat: THREE.ShaderMaterial
  private frame = 0
  mainCam: THREE.PerspectiveCamera | null = null

  constructor({ radius = 1.5, falloff = 1.2, intensity = 1.8 } = {}) {
    super("AOPass")
    this.needsDepthTexture = true
    this.needsSwap = false
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.UnsignedByteType,
      format: THREE.RedFormat,
      depthBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    })
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        tDepth: { value: null },
        projInv: { value: new THREE.Matrix4() },
        proj: { value: new THREE.Matrix4() },
        texel: { value: new THREE.Vector2() },
        radius: { value: radius },
        falloff: { value: falloff },
        intensity: { value: intensity },
        frame: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    })
    this.fullscreenMaterial = this.mat
  }

  override setDepthTexture(depthTexture: THREE.Texture) {
    this.mat.uniforms.tDepth!.value = depthTexture
  }

  override render(renderer: THREE.WebGLRenderer) {
    const cam = this.mainCam
    if (!cam) return
    const u = this.mat.uniforms
    u.proj!.value.copy(cam.projectionMatrix)
    u.projInv!.value.copy(cam.projectionMatrixInverse)
    u.frame!.value = this.frame = (this.frame + 1) % 64
    renderer.setRenderTarget(this.target)
    renderer.render(this.scene, this.camera)
  }

  override setSize(width: number, height: number) {
    this.target.setSize(Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2)))
    this.mat.uniforms.texel!.value.set(1 / width, 1 / height)
  }

  override dispose() {
    super.dispose()
    this.target.dispose()
    this.mat.dispose()
  }
}
