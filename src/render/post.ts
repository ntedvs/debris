import * as THREE from "three"
import { Effect, EffectAttribute, LuminancePass, MipmapBlurPass } from "postprocessing"

// ---------- lens ----------

/**
 * FPV lens model. Output radius follows r = tan(k * theta) / k: k = 1 is a
 * pinhole, 0.5 is stereographic, toward 0 is a true fisheye. Real FPV lenses
 * sit around 0.5 to 0.65.
 */
export const LENS_K = 0.58

export type Lens = {
  k: number
  /** Output projection value at the horizontal edge, g(hfov / 2). */
  gOut: number
  /** Tangent of the half horizontal FOV of the rectilinear render. */
  tanIn: number
  /** Vertical FOV the scene camera must render with, degrees. */
  renderVFov: number
}

const DEG = Math.PI / 180
const IDENTITY = new THREE.Quaternion()

/** Rectilinear render that covers a fisheye output of `hfov` degrees, corners included. */
export function fisheyeLens(hfov: number, aspect: number, k = LENS_K): Lens {
  const g = (t: number) => Math.tan(k * t) / k
  const gOut = g((hfov / 2) * DEG)
  // Corner of the output, in half-width units
  const d = Math.hypot(1, 1 / aspect)
  const thD = Math.min(Math.atan(k * d * gOut) / k, 80 * DEG)
  const tanIn = Math.tan(thD) / d
  return { k, gOut, tanIn, renderVFov: (2 * Math.atan(tanIn / aspect)) / DEG }
}

// ---------- auto exposure ----------

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`

const LOG_LUM_FRAG = /* glsl */ `
uniform sampler2D src;
varying vec2 vUv;
void main() {
  float acc = 0.0;
  for ( int y = 0; y < 4; y++ ) for ( int x = 0; x < 4; x++ ) {
    vec2 o = ( vec2( x, y ) - 1.5 ) / 256.0;
    vec3 c = texture2D( src, vUv + o ).rgb;
    acc += log( max( dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 ) );
  }
  // Center weighted metering, like a camera
  vec2 d = ( vUv - 0.5 ) * vec2( 1.0, 0.8 );
  float w = 1.0 - 0.75 * smoothstep( 0.1, 0.7, length( d ) );
  gl_FragColor = vec4( acc / 16.0 * w, w, 0.0, 1.0 );
}`

const ADAPT_FRAG = /* glsl */ `
uniform sampler2D lum;
uniform sampler2D prev;
uniform float rate;
uniform float lod;
varying vec2 vUv;
void main() {
  vec2 a = textureLod( lum, vec2( 0.5 ), lod ).rg;
  float target = a.x / max( a.y, 1e-4 );
  float p = texture2D( prev, vec2( 0.5 ) ).r;
  gl_FragColor = vec4( mix( p, target, rate ), 0.0, 0.0, 1.0 );
}`

const EXPOSURE_FRAG = /* glsl */ `
uniform sampler2D exposureTex;
uniform float key;
uniform float ref;
uniform float strength;
uniform vec2 range;
void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
  float L = exp( texture2D( exposureTex, vec2( 0.5 ) ).r );
  // Full compensation at strength 1; below that, scenes darker or brighter
  // than a typical sunny one keep some of the difference
  float e = key / ( pow( L, strength ) * pow( ref, 1.0 - strength ) );
  e = clamp( e, range.x, range.y );
  outputColor = vec4( inputColor.rgb * e, inputColor.a );
}`

/**
 * Camera style auto exposure on the linear HDR image: log-average luminance
 * at 64x64, mipmapped to 1x1 and smoothed over time. `strength` < 1 only
 * partly compensates, so bright skies still darken the ground a bit.
 * `ref` is the log-average luminance of a typical sunny scene.
 */
export class AutoExposureEffect extends Effect {
  private lumRT = new THREE.WebGLRenderTarget(64, 64, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: false,
  })
  private adapt = [0, 1].map(
    () =>
      new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        depthBuffer: false,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
      }),
  )
  private flip = 0
  private snap = true
  private quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2))
  private cam = new THREE.OrthographicCamera()
  private lumMat = new THREE.ShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader: LOG_LUM_FRAG,
    uniforms: { src: { value: null } },
    depthTest: false,
    depthWrite: false,
  })
  private adaptMat = new THREE.ShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader: ADAPT_FRAG,
    uniforms: {
      lum: { value: this.lumRT.texture },
      prev: { value: null },
      rate: { value: 1 },
      lod: { value: 6 },
    },
    depthTest: false,
    depthWrite: false,
  })
  /** Adaptation speed, 1/s. */
  speed = 2.2

  constructor({
    key = 0.18,
    ref = 3,
    strength = 0.75,
    range = [0.02, 2] as [number, number],
  } = {}) {
    super("AutoExposureEffect", EXPOSURE_FRAG, {
      uniforms: new Map<string, THREE.Uniform>([
        ["exposureTex", new THREE.Uniform(null)],
        ["key", new THREE.Uniform(key)],
        ["ref", new THREE.Uniform(ref)],
        ["strength", new THREE.Uniform(strength)],
        ["range", new THREE.Uniform(new THREE.Vector2(...range))],
      ]),
    })
    this.quad.frustumCulled = false
  }

  set strength(v: number) {
    this.uniforms.get("strength")!.value = v
  }

  /** Jump straight to the current brightness next frame, e.g. after a map load. */
  reset() {
    this.snap = true
  }

  override update(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget, dt = 0) {
    const prevTarget = renderer.getRenderTarget()
    this.lumMat.uniforms.src!.value = inputBuffer.texture
    this.quad.material = this.lumMat
    renderer.setRenderTarget(this.lumRT)
    renderer.render(this.quad, this.cam)

    const src = this.adapt[this.flip]!
    const dst = this.adapt[1 - this.flip]!
    this.adaptMat.uniforms.prev!.value = src.texture
    this.adaptMat.uniforms.rate!.value = this.snap ? 1 : 1 - Math.exp(-dt * this.speed)
    this.snap = false
    this.quad.material = this.adaptMat
    renderer.setRenderTarget(dst)
    renderer.render(this.quad, this.cam)
    this.flip = 1 - this.flip
    this.uniforms.get("exposureTex")!.value = dst.texture
    renderer.setRenderTarget(prevTarget)
  }

  override dispose() {
    super.dispose()
    this.lumRT.dispose()
    for (const t of this.adapt) t.dispose()
    this.lumMat.dispose()
    this.adaptMat.dispose()
    this.quad.geometry.dispose()
  }
}

// ---------- FPV camera ----------

const CAMERA_FRAG = /* glsl */ `
uniform vec4 lens;      // k, gOut, tanIn, distortion on
uniform mat3 reproj;    // current view dir -> view dir at shutter open
uniform float blurOn;
uniform float ca;
uniform float uTime;
uniform vec2 uRes;
uniform sampler2D bloomTex;
uniform float bloomIntensity;

float fxHash( vec2 p ) { return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }

void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
  float asp = uRes.x / uRes.y;
  // Half-width units: x in -1..1
  vec2 p = ( uv - 0.5 ) * 2.0 * vec2( 1.0, 1.0 / asp );
  float r = length( p );
  vec2 ip = p;
  if ( lens.w > 0.5 && r > 1e-5 ) {
    float th = atan( lens.x * r * lens.y ) / lens.x;
    ip = p * ( tan( th ) / lens.z ) / r;
  }
  vec2 iuv = ip * vec2( 1.0, asp ) * 0.5 + 0.5;

  // Rotational motion blur over the shutter
  vec2 vel = vec2( 0.0 );
  if ( blurOn > 0.5 ) {
    vec3 pd = reproj * vec3( ip * lens.z, -1.0 );
    if ( pd.z < -0.05 ) vel = ( pd.xy / ( -pd.z * lens.z ) - ip ) * vec2( 1.0, asp ) * 0.5;
  }
  float px = length( vel * uRes );
  // One fetch per blur tap; samples spaced ~3 px apart and jittered, the
  // grain hides the remaining noise
  int n = int( clamp( ceil( px / 3.0 ), 1.0, 8.0 ) );
  float jit = fxHash( uv * uRes + fract( uTime ) * 61.0 );
  vec2 caOff = ( iuv - 0.5 ) * ca * r * r;
  vec3 acc = vec3( 0.0 );
  for ( int i = 0; i < 8; i++ ) {
    if ( i >= n ) break;
    vec2 s = iuv + vel * ( n > 1 ? ( float( i ) + jit ) / float( n ) : 0.0 );
    acc += texture2D( inputBuffer, s ).rgb;
  }
  vec3 col = acc / float( n );
  // Lateral chromatic aberration: red and blue shifted, relative to green
  if ( ca > 0.0 ) {
    vec2 s = iuv + vel * ( n > 1 ? 0.5 : 0.0 );
    vec3 c0 = n > 1 ? texture2D( inputBuffer, s ).rgb : col;
    col.r += texture2D( inputBuffer, s + caOff ).r - c0.r;
    col.b += texture2D( inputBuffer, s - caOff ).b - c0.b;
    col = max( col, 0.0 );
  }
  // Bloom, through the same lens (screen blend)
  vec3 b = texture2D( bloomTex, iuv ).rgb * bloomIntensity;
  col = col + b - min( col * b, 1.0 );
  outputColor = vec4( col, inputColor.a );
}`

const SENSOR_FRAG = /* glsl */ `
uniform float vignette;
uniform float grain;
uniform float uTime;
uniform vec2 uRes;

float fxHash2( vec2 p ) { return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }

void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
  float asp = uRes.x / uRes.y;
  vec2 p = ( uv - 0.5 ) * 2.0 * vec2( 1.0, 1.0 / asp );
  vec3 col = inputColor.rgb;
  // Optical vignetting toward the corners
  float rc = length( p ) / length( vec2( 1.0, 1.0 / asp ) );
  col *= 1.0 - vignette * pow( rc, 2.6 );
  // Sensor noise, stronger in the shadows
  float lum = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
  float g = fxHash2( floor( uv * uRes ) + floor( uTime * 60.0 ) * 7.13 ) - 0.5;
  col += g * grain * ( 0.35 + 0.65 * ( 1.0 - smoothstep( 0.0, 0.5, lum ) ) );
  outputColor = vec4( max( col, 0.0 ), inputColor.a );
}`

/** Vignette and sensor noise, on the display referred image (after tone mapping). */
export class SensorEffect extends Effect {
  constructor() {
    super("SensorEffect", SENSOR_FRAG, {
      uniforms: new Map<string, THREE.Uniform>([
        ["vignette", new THREE.Uniform(0)],
        ["grain", new THREE.Uniform(0)],
        ["uTime", new THREE.Uniform(0)],
        ["uRes", new THREE.Uniform(new THREE.Vector2(1, 1))],
      ]),
    })
  }

  override update(_r: THREE.WebGLRenderer, _i: THREE.WebGLRenderTarget, dt = 0) {
    this.uniforms.get("uTime")!.value += dt
  }

  override setSize(width: number, height: number) {
    ;(this.uniforms.get("uRes")!.value as THREE.Vector2).set(width, height)
  }
}

export type CameraFxParams = {
  lens: Lens | null
  blur: boolean
  ca: number
  vignette: number
  grain: number
}

/**
 * What an FPV camera's optics do to the (HDR) image: fisheye distortion of a
 * wider rectilinear render, rotational motion blur over the shutter, lateral
 * chromatic aberration, and bloom. Vignetting and sensor noise come later in
 * the same pass, see `sensor`.
 */
export class CameraEffect extends Effect {
  private prevQ = new THREE.Quaternion()
  private hasPrev = false
  private q = new THREE.Quaternion()
  private dq = new THREE.Quaternion()
  private m4 = new THREE.Matrix4()
  /** Shutter time, seconds. */
  shutter = 1 / 90
  private params: CameraFxParams = { lens: null, blur: false, ca: 0, vignette: 0, grain: 0 }
  /** Add after tone mapping, in the same pass. */
  readonly sensor = new SensorEffect()
  private luminance: LuminancePass
  private blur = new MipmapBlurPass()

  constructor({
    bloomThreshold = 7,
    bloomSmoothing = 3,
    bloomIntensity = 0.35,
    bloomRadius = 0.7,
  } = {}) {
    super("CameraEffect", CAMERA_FRAG, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([
        ["lens", new THREE.Uniform(new THREE.Vector4(1, 1, 1, 0))],
        ["reproj", new THREE.Uniform(new THREE.Matrix3())],
        ["blurOn", new THREE.Uniform(0)],
        ["ca", new THREE.Uniform(0)],
        ["uTime", new THREE.Uniform(0)],
        ["uRes", new THREE.Uniform(new THREE.Vector2(1, 1))],
        ["bloomTex", new THREE.Uniform(null)],
        ["bloomIntensity", new THREE.Uniform(bloomIntensity)],
      ]),
    })
    // Bloom: HDR threshold and a mip chain blur, from a quarter resolution
    // copy. It's a wide, soft glow; resolution buys nothing.
    this.luminance = new LuminancePass({ colorOutput: true } as ConstructorParameters<
      typeof LuminancePass
    >[0])
    const lm = this.luminance.fullscreenMaterial as unknown as {
      threshold: number
      smoothing: number
    }
    lm.threshold = bloomThreshold
    lm.smoothing = bloomSmoothing
    this.blur.radius = bloomRadius
    this.blur.levels = 8
    this.uniforms.get("bloomTex")!.value = this.blur.texture
  }

  set(p: CameraFxParams) {
    this.params = p
    const u = this.uniforms
    u.get("ca")!.value = p.ca
    this.sensor.uniforms.get("vignette")!.value = p.vignette
    this.sensor.uniforms.get("grain")!.value = p.grain
    const l = u.get("lens")!.value as THREE.Vector4
    if (p.lens) l.set(p.lens.k, p.lens.gOut, p.lens.tanIn, 1)
    else l.set(1, 1, 1, 0)
  }

  /** Call once per frame with the camera being rendered. */
  track(camera: THREE.PerspectiveCamera, dt: number) {
    const u = this.uniforms
    const l = u.get("lens")!.value as THREE.Vector4
    if (!this.params.lens) l.z = Math.tan((camera.fov * DEG) / 2) * camera.aspect
    camera.getWorldQuaternion(this.q)
    let on = 0
    if (this.params.blur && this.hasPrev && dt > 1e-4) {
      // Rotation from now back to shutter open, scaled from this frame's motion
      this.dq.copy(this.q).invert().multiply(this.prevQ)
      const f = Math.min(1.5, this.shutter / dt)
      this.dq.slerp(IDENTITY, 1 - f)
      const angle = 2 * Math.acos(Math.min(1, Math.abs(this.dq.w)))
      // Skip resets and teleports
      if (angle > 1e-4 && angle < 0.5) {
        this.m4.makeRotationFromQuaternion(this.dq)
        ;(u.get("reproj")!.value as THREE.Matrix3).setFromMatrix4(this.m4)
        on = 1
      }
    }
    u.get("blurOn")!.value = on
    this.prevQ.copy(this.q)
    this.hasPrev = true
  }

  override update(renderer: THREE.WebGLRenderer, input: THREE.WebGLRenderTarget, dt = 0) {
    this.uniforms.get("uTime")!.value += dt
    const lum = this.luminance as unknown as { renderTarget: THREE.WebGLRenderTarget }
    this.luminance.render(renderer, input, null as unknown as THREE.WebGLRenderTarget)
    this.blur.render(renderer, lum.renderTarget, null as unknown as THREE.WebGLRenderTarget)
  }

  override initialize(renderer: THREE.WebGLRenderer, alpha: boolean, frameBufferType: number) {
    this.luminance.initialize(renderer, alpha, frameBufferType)
    this.blur.initialize(renderer, alpha, frameBufferType)
  }

  override setSize(width: number, height: number) {
    ;(this.uniforms.get("uRes")!.value as THREE.Vector2).set(width, height)
    const w = Math.max(1, Math.round(width / 4))
    const h = Math.max(1, Math.round(height / 4))
    this.luminance.setSize(w, h)
    this.blur.setSize(w, h)
  }

  override dispose() {
    super.dispose()
    this.luminance.dispose()
    this.blur.dispose()
  }
}
