import * as THREE from "three"
import { Pass } from "postprocessing"

/** Halton low discrepancy sequence, for subpixel jitter. */
function halton(i: number, b: number) {
  let f = 1
  let r = 0
  while (i > 0) {
    f /= b
    r += f * (i % b)
    i = Math.floor(i / b)
  }
  return r
}
const JITTER = Array.from(
  { length: 16 },
  (_, i) => [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5] as const,
)

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4( position.xy, 1.0, 1.0 ); }`

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tColor;   // render resolution, jittered
uniform sampler2D tHistory; // output resolution
uniform sampler2D tDepth;   // render resolution
uniform sampler2D tAO;
uniform float aoOn;
uniform mat4 invViewProj;   // jittered
uniform mat4 prevViewProj;  // unjittered
uniform vec2 texel;         // output texel
uniform vec2 renderSize;
uniform vec2 jitter;        // render pixels
uniform float scale;        // output pixels per render pixel
uniform float wNorm;
uniform float blend;
varying vec2 vUv;

// Reversible tonemap so bright pixels don't dominate the blend (Karis)
vec3 tm( vec3 c ) { return c / ( 1.0 + max( c.r, max( c.g, c.b ) ) ); }
vec3 itm( vec3 c ) { return c / max( 1.0 - max( c.r, max( c.g, c.b ) ), 1e-4 ); }
vec3 toYCoCg( vec3 c ) { return vec3( 0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b ); }
vec3 fromYCoCg( vec3 c ) { return vec3( c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z ); }

// 5 tap Catmull-Rom, keeps the history sharp under reprojection
vec3 history( vec2 uv ) {
  #ifdef HISTORY_BILINEAR
  return texture2D( tHistory, uv ).rgb;
  #endif
  vec2 res = 1.0 / texel;
  vec2 p = uv * res;
  vec2 tc = floor( p - 0.5 ) + 0.5;
  vec2 f = p - tc;
  vec2 w0 = f * ( -0.5 + f * ( 1.0 - 0.5 * f ) );
  vec2 w1 = 1.0 + f * f * ( -2.5 + 1.5 * f );
  vec2 w2 = f * ( 0.5 + f * ( 2.0 - 1.5 * f ) );
  vec2 w3 = f * f * ( -0.5 + 0.5 * f );
  vec2 w12 = w1 + w2;
  vec2 t0 = ( tc - 1.0 ) * texel;
  vec2 t3 = ( tc + 2.0 ) * texel;
  vec2 t12 = ( tc + w2 / w12 ) * texel;
  vec3 c = texture2D( tHistory, vec2( t12.x, t0.y ) ).rgb * ( w12.x * w0.y )
    + texture2D( tHistory, vec2( t0.x, t12.y ) ).rgb * ( w0.x * w12.y )
    + texture2D( tHistory, vec2( t12.x, t12.y ) ).rgb * ( w12.x * w12.y )
    + texture2D( tHistory, vec2( t3.x, t12.y ) ).rgb * ( w3.x * w12.y )
    + texture2D( tHistory, vec2( t12.x, t3.y ) ).rgb * ( w12.x * w3.y );
  float wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max( c / wsum, 0.0 );
}

void main() {
  // Render pixel whose jittered sample lies closest to this output pixel.
  // Pixel k samples the scene at k + 0.5 + jitter (render pixels).
  vec2 q = vUv * renderSize;
  ivec2 k = ivec2( floor( q - jitter ) );
  ivec2 kMax = ivec2( renderSize ) - 1;
  k = clamp( k, ivec2( 0 ), kMax );
  vec2 dk = ( vec2( k ) + 0.5 + jitter - q ) * scale;
  // How much this frame's sample counts here: Gaussian in output pixels
  float w = exp( -2.29 * dot( dk, dk ) ) * wNorm;

  // Ambient occlusion is applied here so its per-frame noise is accumulated.
  // It's smooth, so one value stands in for the whole neighborhood.
  float ao = aoOn > 0.5 ? texture2D( tAO, vUv ).r : 1.0;
  vec3 cur = texelFetch( tColor, k, 0 ).rgb * ao;
  // Plus shaped neighborhood (5 color, 5 depth taps) in perceptual YCoCg
  vec3 curT = toYCoCg( tm( cur ) );
  vec3 m1 = curT, m2 = curT * curT;
  float dMin = texelFetch( tDepth, k, 0 ).r;
  ivec2 dk2 = k;
  for ( int i = 0; i < 4; i++ ) {
    ivec2 o = ivec2( i == 0 ? 1 : i == 1 ? -1 : 0, i == 2 ? 1 : i == 3 ? -1 : 0 );
    ivec2 kk = clamp( k + o, ivec2( 0 ), kMax );
    vec3 c = toYCoCg( tm( texelFetch( tColor, kk, 0 ).rgb * ao ) );
    m1 += c;
    m2 += c * c;
    // Nearest depth, so edges reproject with the foreground
    float d = texelFetch( tDepth, kk, 0 ).r;
    if ( d < dMin ) { dMin = d; dk2 = kk; }
  }
  vec3 mean = m1 / 5.0;
  vec3 sd = sqrt( max( m2 / 5.0 - mean * mean, 0.0 ) );
  vec3 lo = mean - 1.25 * sd, hi = mean + 1.25 * sd;

  // Camera motion of the nearest sample, so edges move with the foreground
  vec2 sUv = ( vec2( dk2 ) + 0.5 ) / renderSize;
  vec4 wp = invViewProj * vec4( vec3( sUv, dMin ) * 2.0 - 1.0, 1.0 );
  wp /= wp.w;
  vec4 pp = prevViewProj * wp;
  vec2 motion = pp.xy / pp.w * 0.5 + 0.5 - ( sUv + jitter / renderSize );
  vec2 puv = vUv + motion;

  vec3 res;
  if ( blend >= 1.0 || any( lessThan( puv, vec2( 0.0 ) ) ) || any( greaterThan( puv, vec2( 1.0 ) ) ) || pp.w <= 0.0 ) {
    // No history: smooth upsample
    res = texture2D( tColor, vUv ).rgb * ao;
  } else {
    vec3 h = toYCoCg( tm( history( puv ) ) );
    // Clip toward the mean (not clamp) to avoid color shifts
    vec3 c = 0.5 * ( hi + lo ), e = 0.5 * ( hi - lo ) + 1e-4;
    vec3 v = h - c;
    vec3 u = abs( v / e );
    float m = max( u.x, max( u.y, u.z ) );
    if ( m > 1.0 ) h = c + v / m;
    // Less history when it was far outside the neighborhood (disocclusion, fast motion)
    float a = mix( blend, 0.5, clamp( ( m - 1.0 ) * 0.25, 0.0, 0.4 ) ) * w;
    // Clip in perceptual space, blend in linear: averaging tonemapped values
    // darkens fine high contrast detail like foliage
    res = mix( itm( fromYCoCg( h ) ), cur, clamp( a, 0.0, 1.0 ) );
  }
  gl_FragColor = vec4( res, 1.0 );
}`

/**
 * Temporal antialiasing and upsampling. The camera is jittered by a subpixel
 * offset each frame and the result is accumulated with the reprojected
 * history (camera motion via depth), clipped to the current neighborhood.
 * Replaces MSAA and SMAA: resolves edges, thin geometry, grass and alpha
 * tested leaves.
 *
 * The scene can render below output resolution: each frame's jittered samples
 * land in the output resolution history weighted by how close they are to
 * each output pixel, so detail builds up over a few frames.
 *
 * Everything after TAA runs at output resolution, so TAA drives those passes
 * itself (`chain`) instead of the composer.
 */
export class TAAPass extends Pass {
  private targets: THREE.WebGLRenderTarget[]
  private post: THREE.WebGLRenderTarget[]
  private read = 0
  private index = 0
  private valid = false
  private saved = new THREE.Matrix4()
  private prevViewProj = new THREE.Matrix4()
  private mat: THREE.ShaderMaterial
  private mainCam: THREE.PerspectiveCamera | null = null
  private renderSize = new THREE.Vector2(1, 1)
  private outSize = new THREE.Vector2(1, 1)
  /**
   * Passes after TAA, at output resolution. The last one renders to screen.
   * Add them to the composer disabled so they still get initialized.
   */
  chain: Pass[] = []
  /** Weight of the current frame, lower is smoother. */
  blend = 0.1

  constructor() {
    super("TAAPass")
    this.needsDepthTexture = true
    const rt = () =>
      new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        depthBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      })
    this.targets = [rt(), rt()]
    this.post = [rt(), rt()]
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        tColor: { value: null },
        tHistory: { value: null },
        tDepth: { value: null },
        invViewProj: { value: new THREE.Matrix4() },
        prevViewProj: { value: new THREE.Matrix4() },
        texel: { value: new THREE.Vector2() },
        renderSize: { value: new THREE.Vector2() },
        jitter: { value: new THREE.Vector2() },
        scale: { value: 1 },
        wNorm: { value: 1 },
        blend: { value: 1 },
        tAO: { value: null },
        aoOn: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    })
    this.fullscreenMaterial = this.mat
  }

  override setDepthTexture(depthTexture: THREE.Texture) {
    this.mat.uniforms.tDepth!.value = depthTexture
  }

  /** Occlusion to apply, or null. */
  setAO(t: THREE.Texture | null) {
    this.mat.uniforms.tAO!.value = t
    this.mat.uniforms.aoOn!.value = t ? 1 : 0
  }

  /** Drop the history, e.g. after a teleport or a camera switch. */
  reset() {
    this.valid = false
  }

  /** Offset the camera projection for this frame. Call before rendering the scene. */
  jitter(camera: THREE.PerspectiveCamera) {
    if (camera !== this.mainCam) {
      this.mainCam = camera
      this.valid = false
    }
    this.saved.copy(camera.projectionMatrix)
    const [jx, jy] = JITTER[this.index++ % JITTER.length]!
    this.mat.uniforms.jitter!.value.set(jx, jy)
    const p = camera.projectionMatrix.elements
    // Shifts the image by -jitter render pixels, so pixel k samples k + 0.5 + jitter
    p[8]! += (jx * 2) / this.renderSize.x
    p[9]! += (jy * 2) / this.renderSize.y
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
    camera.updateMatrixWorld()
    this.mat.uniforms.invViewProj!.value.multiplyMatrices(
      camera.matrixWorld,
      camera.projectionMatrixInverse,
    )
  }

  /** Undo the jitter. Call after the frame is rendered. */
  restore(camera: THREE.PerspectiveCamera) {
    camera.projectionMatrix.copy(this.saved)
    camera.projectionMatrixInverse.copy(this.saved).invert()
    // Unjittered, for reprojecting next frame
    this.prevViewProj.multiplyMatrices(this.saved, camera.matrixWorldInverse)
  }

  override render(
    renderer: THREE.WebGLRenderer,
    inputBuffer: THREE.WebGLRenderTarget,
    _outputBuffer: THREE.WebGLRenderTarget,
    deltaTime?: number,
  ) {
    const u = this.mat.uniforms
    const src = this.targets[this.read]!
    const dst = this.targets[1 - this.read]!
    u.tColor!.value = inputBuffer.texture
    u.tHistory!.value = src.texture
    u.prevViewProj!.value.copy(this.prevViewProj)
    u.blend!.value = this.valid ? this.blend : 1
    renderer.setRenderTarget(dst)
    renderer.render(this.scene, this.camera)
    this.read = 1 - this.read
    this.valid = true

    let input = dst
    const passes = this.chain
    passes.forEach((p, i) => {
      const last = i === passes.length - 1
      const out = this.post[i % 2]!
      p.renderToScreen = last
      p.render(renderer, input, out, deltaTime, false)
      input = out
    })
  }

  override setSize(width: number, height: number) {
    this.setSizes(width, height, width, height)
  }

  /** Scene (render) and output resolution. */
  setSizes(rw: number, rh: number, ow: number, oh: number) {
    this.renderSize.set(rw, rh)
    this.outSize.set(ow, oh)
    for (const t of this.targets) t.setSize(ow, oh)
    // Only needed between chained passes
    for (const t of this.post)
      t.setSize(this.chain.length > 1 ? ow : 1, this.chain.length > 1 ? oh : 1)
    const u = this.mat.uniforms
    u.texel!.value.set(1 / ow, 1 / oh)
    u.renderSize!.value.set(rw, rh)
    const scale = ow / rw
    u.scale!.value = scale
    // Average sample weight over jitter positions, so blend means the same at any scale
    let sum = 0
    const n = 16
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const dx = ((x + 0.5) / n - 0.5) * scale
        const dy = ((y + 0.5) / n - 0.5) * scale
        sum += Math.exp(-2.29 * (dx * dx + dy * dy))
      }
    u.wNorm!.value = (n * n) / sum
    for (const p of this.chain) p.setSize(ow, oh)
    this.valid = false
  }

  override dispose() {
    super.dispose()
    for (const t of [...this.targets, ...this.post]) t.dispose()
    this.mat.dispose()
  }
}
