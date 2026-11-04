import * as THREE from "three"
import { Sky } from "three/examples/jsm/objects/Sky.js"
import {
  BrightnessContrastEffect,
  EffectComposer,
  EffectPass,
  HueSaturationEffect,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
} from "postprocessing"
import type { BuiltMap } from "../map/builder"
import type { MapFile } from "../map/schema"
import { noiseTexture } from "./noise-texture"
import { AutoExposureEffect, CameraEffect, type CameraFxParams } from "./post"
import { CascadedShadows } from "./shadows"
import { SkyCache } from "./sky"
import { TAAPass } from "./taa"
import { AOPass } from "./ao"
import { installChunks, invalidateMaterials, patchTree, shared } from "./shading"
import { GrassField, type GrassQuality } from "./terrain"

type SkyParams = {
  elevation: number
  azimuth: number
  turbidity: number
  rayleigh: number
  mie: number
  /**
   * Sun illuminance. The Sky shader's radiance is around 1 to 4, so a clear
   * day needs ~55 for a real sun to sky ratio (sunlit about 5x brighter than shade).
   */
  sunIntensity: number
  sunColor: string
  hemiSky: string
  /** Average ground albedo, lit by sun and sky, becomes the bounce light in the env map. */
  hemiGround: string
  hemiIntensity: number
  /** Exposure compensation on top of auto exposure. */
  exposure: number
  fog: string
  /** Height fog falloff per meter. Higher keeps haze closer to the ground. */
  fogFalloff: number
  clouds: number
  cloudDensity: number
  /** How much a cloud dims the sun on the ground, 0..1. */
  cloudShadow: number
}

const SKY_PRESETS: Record<MapFile["environment"]["sky"]["preset"], SkyParams> = {
  day: {
    elevation: 48,
    azimuth: 150,
    turbidity: 4,
    rayleigh: 1.2,
    mie: 0.004,
    sunIntensity: 55,
    sunColor: "#fff4e5",
    hemiSky: "#bcd6ff",
    hemiGround: "#5a5040",
    hemiIntensity: 0.45,
    exposure: 1,
    fog: "#c3d3e6",
    fogFalloff: 0.01,
    clouds: 0.38,
    cloudDensity: 0.5,
    cloudShadow: 0.55,
  },
  golden: {
    elevation: 9,
    azimuth: 250,
    turbidity: 7,
    rayleigh: 2.2,
    mie: 0.006,
    sunIntensity: 40,
    sunColor: "#ffc488",
    hemiSky: "#ffd7b0",
    hemiGround: "#4a3a2a",
    hemiIntensity: 0.4,
    exposure: 1,
    fog: "#e3c4a2",
    fogFalloff: 0.014,
    clouds: 0.3,
    cloudDensity: 0.45,
    cloudShadow: 0.45,
  },
  overcast: {
    elevation: 40,
    azimuth: 160,
    turbidity: 18,
    rayleigh: 0.4,
    mie: 0.02,
    sunIntensity: 9,
    sunColor: "#e8ecf0",
    hemiSky: "#d8dde3",
    hemiGround: "#5f5c55",
    hemiIntensity: 1.1,
    exposure: 1,
    fog: "#b9bec4",
    fogFalloff: 0.006,
    clouds: 0.85,
    cloudDensity: 0.8,
    cloudShadow: 0.2,
  },
  dusk: {
    elevation: 1.5,
    azimuth: 260,
    turbidity: 6,
    rayleigh: 3,
    mie: 0.008,
    sunIntensity: 14,
    sunColor: "#ff9a62",
    hemiSky: "#8a8fbf",
    hemiGround: "#2e2a30",
    hemiIntensity: 0.5,
    exposure: 1,
    fog: "#8c7f8f",
    fogFalloff: 0.016,
    clouds: 0.3,
    cloudDensity: 0.4,
    cloudShadow: 0.3,
  },
}

export type GraphicsQuality = "low" | "medium" | "high"

/**
 * Contrast pushes near-black below zero, and the sRGB to linear conversion
 * postprocessing runs next turns negative values into NaN (pow of a negative),
 * which displays as white. Clamp the output.
 */
function contrastEffect(contrast: number) {
  const e = new BrightnessContrastEffect({ contrast })
  const src = e.getFragmentShader()
  const from = "outputColor=vec4(color+vec3(0.5),inputColor.a);"
  if (!src.includes(from)) throw new Error("BrightnessContrastEffect shader changed")
  ;(e as unknown as { setFragmentShader(s: string): void }).setFragmentShader(
    src.replace(from, "outputColor=vec4(max(color+vec3(0.5),0.0),inputColor.a);"),
  )
  return e
}

type QualityDef = {
  pixelRatio: number
  /** Scene resolution relative to output; TAA upsamples. */
  renderScale: number
  ao: boolean
  /** Coverage radius of each shadow cascade around the camera, meters. The last one is the shadow distance. */
  cascades: number[]
  shadowSize: number
  grass: GrassQuality
}

const QUALITY: Record<GraphicsQuality, QualityDef> = {
  low: {
    pixelRatio: 1,
    renderScale: 0.8,
    ao: false,
    cascades: [25, 120],
    shadowSize: 1024,
    grass: { near: { spacing: 0.28, radius: 12 }, far: { spacing: 0.85, radius: 30 } },
  },
  medium: {
    pixelRatio: 1.5,
    renderScale: 0.75,
    ao: true,
    cascades: [12, 50, 180],
    shadowSize: 1536,
    grass: { near: { spacing: 0.2, radius: 14 }, far: { spacing: 0.6, radius: 42 } },
  },
  high: {
    pixelRatio: 2,
    renderScale: 0.67,
    ao: true,
    cascades: [12, 55, 250],
    shadowSize: 2048,
    grass: { near: { spacing: 0.16, radius: 16 }, far: { spacing: 0.45, radius: 55 } },
  },
}

/**
 * Renderer, sky, lighting, shadows and post. Map geometry gets added to `scene`.
 *
 * Pipeline: scene (linear HDR, half float, jittered, below output resolution)
 * -> AO (half of that) -> TAA (applies AO, upsamples to output resolution)
 * -> one post pass: lens, bloom, exposure, AgX, grade, sensor noise.
 *
 * Shadows are 2-3 cached cascades around the camera, see shadows.ts. The sky
 * is cached in a cube map, see sky.ts. Fog is height based and colored from
 * the prefiltered sky, see shading.ts.
 */
export class SceneRenderer {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly hemi = new THREE.HemisphereLight()
  private sky = new SkyCache()
  private pmrem: THREE.PMREMGenerator
  private envRT: THREE.WebGLRenderTarget | null = null
  private sunDir = new THREE.Vector3(0, 1, 0)
  private sun = { color: new THREE.Color(), intensity: 0 }
  private composer: EffectComposer
  private renderPass: RenderPass
  private ao = new AOPass()
  private taa = new TAAPass()
  private exposure = new AutoExposureEffect()
  private cameraFx = new CameraEffect()
  private shadows: CascadedShadows | null = null
  private camera: THREE.PerspectiveCamera = new THREE.PerspectiveCamera()
  private quality: QualityDef = QUALITY.medium
  private grass: GrassField | null = null
  private groundHeight: (x: number, z: number) => number = () => 0
  private wind = new THREE.Vector2()
  private windSpeed = 0
  private size = { w: 1, h: 1 }
  private camPos = new THREE.Vector3()

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      stencil: false,
      depth: true,
      powerPreference: "high-performance",
    })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    // Tone mapping happens in post
    this.renderer.toneMapping = THREE.NoToneMapping
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.pmrem = new THREE.PMREMGenerator(this.renderer)
    shared.dNoise.value = noiseTexture()

    this.scene.add(this.sky.mesh)
    this.scene.add(this.hemi)

    this.composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType })
    this.renderPass = new RenderPass(this.scene, this.camera)
    this.composer.addPass(this.renderPass)
    this.composer.addPass(this.ao)
    // Antialiasing and upsampling on the HDR image, before bloom so it doesn't flicker
    this.composer.addPass(this.taa)
    // One pass at output resolution: lens (distortion, motion blur, CA,
    // bloom) on the HDR image, then exposure, AgX, a little contrast and
    // saturation back since AgX is deliberately flat, then sensor noise.
    // Runs from inside the TAA pass, see TAAPass.chain.
    const post = new EffectPass(
      this.camera,
      this.cameraFx,
      this.exposure,
      new ToneMappingEffect({ mode: ToneMappingMode.AGX }),
      contrastEffect(0.1),
      new HueSaturationEffect({ saturation: 0.18 }),
      this.cameraFx.sensor,
    )
    post.enabled = false
    this.composer.addPass(post)
    this.taa.chain = [post]
  }

  setQuality(name: GraphicsQuality) {
    const q = QUALITY[name] ?? QUALITY.medium
    this.quality = q
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio))
    this.applySize()
    this.ao.enabled = q.ao
    this.taa.setAO(q.ao ? this.ao.target.texture : null)
    this.buildShadows()
    this.grass?.setQuality(q.grass)
    patchTree(this.scene)
  }

  private buildShadows() {
    const q = this.quality
    this.shadows?.dispose()
    installChunks()
    this.shadows = new CascadedShadows(this.scene, q.cascades, q.shadowSize)
    this.applySun()
  }

  private applySun() {
    this.shadows?.setSun(this.sunDir, this.sun.color, this.sun.intensity)
  }

  applyEnvironment(env: MapFile["environment"]) {
    const p = { ...SKY_PRESETS[env.sky.preset] }
    if (env.sky.sunElevation !== undefined) p.elevation = env.sky.sunElevation
    if (env.sky.sunAzimuth !== undefined) p.azimuth = env.sky.sunAzimuth

    const u = this.sky.uniforms
    this.sky.invalidate()
    u.turbidity!.value = p.turbidity
    u.rayleigh!.value = p.rayleigh
    u.mieCoefficient!.value = p.mie
    u.mieDirectionalG!.value = 0.8
    u.cloudCoverage!.value = p.clouds
    u.cloudDensity!.value = p.cloudDensity
    u.cloudElevation!.value = 0.55
    u.cloudScale!.value = 0.00025
    u.cloudSpeed!.value = 0.00003
    const el = THREE.MathUtils.degToRad(p.elevation)
    const az = THREE.MathUtils.degToRad(p.azimuth)
    // Azimuth clockwise from north (-Z)
    this.sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el))
    u.sunPosition!.value.copy(this.sunDir)

    this.sun.color.set(p.sunColor)
    this.sun.intensity = p.sunIntensity * Math.min(1, Math.max(0.15, Math.sin(el) * 3))
    this.applySun()
    // Sky light comes from the env map only. The hemisphere light stays as a
    // faint fill so nothing in deep shade goes fully black.
    this.hemi.color.set(p.hemiSky)
    this.hemi.groundColor.set(p.hemiGround)
    this.hemi.intensity = p.hemiIntensity * 0.15
    this.renderer.toneMappingExposure = p.exposure
    this.exposure.reset()

    const fog = env.fog
    this.scene.fog = new THREE.FogExp2(fog?.color ?? p.fog, fog?.density ?? 0.0025)
    shared.dFogFalloff.value = p.fogFalloff
    shared.dSunDir.value.copy(this.sunDir)
    shared.dSunColor.value.copy(this.sun.color).multiplyScalar(this.sun.intensity * 0.012)
    shared.dCloudShadow.value = p.cloudShadow * Math.min(1, p.clouds * 2)

    const wind = env.wind
    const wdir = THREE.MathUtils.degToRad(wind?.direction ?? 0)
    // Direction the wind blows toward, in world XZ
    this.wind.set(-Math.sin(wdir), Math.cos(wdir)).multiplyScalar(wind?.speed ?? 0)
    this.windSpeed = wind?.speed ?? 0

    // Image based lighting from the sky, without the sun disc (the sun is a real light)
    this.envRT?.dispose()
    const envScene = new THREE.Scene()
    const skyCopy = new Sky()
    skyCopy.scale.setScalar(1000)
    const cu = THREE.UniformsUtils.clone(u)
    cu.showSunDisc!.value = 0
    ;(skyCopy.material as THREE.ShaderMaterial).uniforms = cu
    envScene.add(skyCopy)
    // Ground below the horizon, so the lower hemisphere bounces sunlit ground
    // color instead of the sky shader's blue haze
    const irr = (this.sun.intensity * Math.max(0.05, Math.sin(el))) / Math.PI + 0.25
    const groundMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(p.hemiGround).multiplyScalar(irr * 0.9),
      side: THREE.DoubleSide,
    })
    const groundDisc = new THREE.Mesh(new THREE.CircleGeometry(900, 32), groundMat)
    groundDisc.rotation.x = -Math.PI / 2
    groundDisc.position.y = -2
    envScene.add(groundDisc)
    this.envRT = this.pmrem.fromScene(envScene, 0, 0.1, 2000)
    groundDisc.geometry.dispose()
    groundMat.dispose()
    this.scene.environment = this.envRT.texture
    this.scene.environmentIntensity = 0.6
  }

  setMap(built: BuiltMap) {
    if (this.grass) {
      this.scene.remove(this.grass.group)
      this.grass.dispose()
    }
    this.grass = new GrassField(built.ground)
    this.grass.setQuality(this.quality.grass)
    this.scene.add(this.grass.group)
    this.groundHeight = built.groundHeight
    this.shadows?.invalidate()
  }

  /** Hook any newly added objects into the shared shading. */
  track(root: THREE.Object3D) {
    patchTree(root)
  }

  setShadows(enabled: boolean) {
    if (this.renderer.shadowMap.enabled === enabled) return
    this.renderer.shadowMap.enabled = enabled
    this.shadows?.invalidate()
    invalidateMaterials()
  }

  resize(width: number, height: number) {
    this.size = { w: width, h: height }
    this.applySize()
  }

  /** Canvas at output resolution, scene buffers at render resolution. */
  private applySize() {
    const c = this.composer as EffectComposer & {
      inputBuffer: THREE.WebGLRenderTarget
      outputBuffer: THREE.WebGLRenderTarget
      depthRenderTarget: THREE.WebGLRenderTarget | null
    }
    c.setSize(this.size.w, this.size.h, false)
    const out = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    const rw = Math.max(1, Math.round(out.x * this.quality.renderScale))
    const rh = Math.max(1, Math.round(out.y * this.quality.renderScale))
    c.inputBuffer.setSize(rw, rh)
    c.outputBuffer.setSize(rw, rh)
    c.depthRenderTarget?.setSize(rw, rh)
    this.renderPass.setSize(rw, rh)
    this.ao.setSize(rw, rh)
    this.taa.setSizes(rw, rh, out.x, out.y)
  }

  /** Per-frame animation: clouds, wind, grass and downwash from the quad. */
  update(dt: number, camera: THREE.Camera, drone: THREE.Vector3, downwash: number) {
    shared.dTime.value += dt
    shared.dFrame.value = (shared.dFrame.value + 1) % 64
    this.sky.uniforms.time!.value = shared.dTime.value
    // Clouds drift with the wind aloft
    const aloft = this.windSpeed * 2.5 + 3
    const len = this.wind.length() || 1
    shared.dCloudOffset.value.x += (this.wind.x / len) * aloft * dt * shared.dCloudScale.value
    shared.dCloudOffset.value.y += (this.wind.y / len) * aloft * dt * shared.dCloudScale.value
    this.grass?.update(camera, this.groundHeight, this.wind, drone, downwash)
    shared.dDrone.value.set(drone.x, drone.y, drone.z, 0.14)
  }

  /** Lens, sensor and exposure behavior for the camera being rendered. */
  setCameraFx(p: CameraFxParams, exposureStrength: number) {
    this.cameraFx.set(p)
    this.exposure.strength = exposureStrength
  }

  render(camera: THREE.PerspectiveCamera, dt: number) {
    this.cameraFx.track(camera, dt)
    if (camera !== this.camera) {
      this.camera = camera
      this.composer.setMainCamera(camera)
      this.ao.mainCam = camera
    }
    camera.updateWorldMatrix(true, false)
    this.shadows?.update(camera.getWorldPosition(this.camPos))
    this.sky.update(this.renderer)
    this.taa.jitter(camera)
    this.composer.render(dt)
    this.taa.restore(camera)
  }

  /** Forget temporal history, e.g. after a teleport. */
  resetHistory() {
    this.taa.reset()
  }
}
