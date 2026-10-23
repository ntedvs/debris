import * as THREE from "three"
import { CSM } from "three/examples/jsm/csm/CSM.js"
import { Sky } from "three/examples/jsm/objects/Sky.js"
import {
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
} from "postprocessing"
import { N8AOPostPass } from "n8ao"
import type { BuiltMap } from "../map/builder"
import type { MapFile } from "../map/schema"
import { noiseTexture } from "./noise-texture"
import { installChunks, invalidateMaterials, patchTree, setCascadeCount, shared } from "./shading"
import { GrassField, type GrassQuality } from "./terrain"

type SkyParams = {
  elevation: number
  azimuth: number
  turbidity: number
  rayleigh: number
  mie: number
  sunIntensity: number
  sunColor: string
  hemiSky: string
  hemiGround: string
  hemiIntensity: number
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
    sunIntensity: 3.2,
    sunColor: "#fff4e5",
    hemiSky: "#bcd6ff",
    hemiGround: "#5a5040",
    hemiIntensity: 0.45,
    exposure: 0.55,
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
    sunIntensity: 2.6,
    sunColor: "#ffc488",
    hemiSky: "#ffd7b0",
    hemiGround: "#4a3a2a",
    hemiIntensity: 0.4,
    exposure: 0.5,
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
    sunIntensity: 0.9,
    sunColor: "#e8ecf0",
    hemiSky: "#d8dde3",
    hemiGround: "#5f5c55",
    hemiIntensity: 1.1,
    exposure: 0.5,
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
    sunIntensity: 1.2,
    sunColor: "#ff9a62",
    hemiSky: "#8a8fbf",
    hemiGround: "#2e2a30",
    hemiIntensity: 0.5,
    exposure: 0.55,
    fog: "#8c7f8f",
    fogFalloff: 0.016,
    clouds: 0.3,
    cloudDensity: 0.4,
    cloudShadow: 0.3,
  },
}

export type GraphicsQuality = "low" | "medium" | "high"

type QualityDef = {
  pixelRatio: number
  ao: "Performance" | "Low" | null
  /** Far edge of each shadow cascade, meters. The last one is the shadow distance. */
  cascades: number[]
  shadowSize: number
  grass: GrassQuality
}

const QUALITY: Record<GraphicsQuality, QualityDef> = {
  low: {
    pixelRatio: 1,
    ao: null,
    cascades: [25, 120],
    shadowSize: 1024,
    grass: { near: { spacing: 0.28, radius: 12 }, far: { spacing: 0.85, radius: 30 } },
  },
  medium: {
    pixelRatio: 1.5,
    ao: "Performance",
    cascades: [12, 50, 180],
    shadowSize: 1536,
    grass: { near: { spacing: 0.2, radius: 14 }, far: { spacing: 0.6, radius: 42 } },
  },
  high: {
    pixelRatio: 2,
    ao: "Low",
    cascades: [12, 55, 250],
    shadowSize: 2048,
    grass: { near: { spacing: 0.16, radius: 16 }, far: { spacing: 0.45, radius: 55 } },
  },
}

/**
 * Renderer, sky, lighting, shadows and post. Map geometry gets added to `scene`.
 *
 * Pipeline: scene (linear HDR, half float) -> N8AO -> tone mapping -> SMAA.
 * Shadows are 2-3 cascades fitted to the active camera. Fog is height based
 * and colored from the prefiltered sky, see shading.ts.
 */
export class SceneRenderer {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly hemi = new THREE.HemisphereLight()
  private sky = new Sky()
  private pmrem: THREE.PMREMGenerator
  private envRT: THREE.WebGLRenderTarget | null = null
  private sunDir = new THREE.Vector3(0, 1, 0)
  private sun = { color: new THREE.Color(), intensity: 0 }
  private composer: EffectComposer
  private renderPass: RenderPass
  private ao: N8AOPostPass
  private csm: CSM | null = null
  private camera: THREE.PerspectiveCamera = new THREE.PerspectiveCamera()
  private projKey = ""
  private quality: QualityDef = QUALITY.medium
  private grass: GrassField | null = null
  private groundHeight: (x: number, z: number) => number = () => 0
  private wind = new THREE.Vector2()
  private windSpeed = 0
  private size = { w: 1, h: 1 }

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

    this.sky.scale.setScalar(45000)
    this.scene.add(this.sky)
    this.scene.add(this.hemi)

    this.composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType })
    this.renderPass = new RenderPass(this.scene, this.camera)
    this.composer.addPass(this.renderPass)
    this.ao = new N8AOPostPass(this.scene, this.camera, 1, 1)
    Object.assign(this.ao.configuration, {
      aoRadius: 2.2,
      distanceFalloff: 1.2,
      intensity: 2.4,
      halfRes: true,
      depthAwareUpsampling: true,
      transparencyAware: false,
      gammaCorrection: false,
    })
    this.ao.configuration.color.set(0x000000)
    this.composer.addPass(this.ao)
    this.composer.addPass(
      new EffectPass(this.camera, new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC })),
    )
    // SMAA after tone mapping so edges are detected on display values
    this.composer.addPass(new EffectPass(this.camera, new SMAAEffect({ preset: SMAAPreset.HIGH })))
  }

  setQuality(name: GraphicsQuality) {
    const q = QUALITY[name] ?? QUALITY.medium
    this.quality = q
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio))
    this.composer.setSize(this.size.w, this.size.h, false)
    this.ao.enabled = q.ao !== null
    if (q.ao) {
      this.ao.setQualityMode(q.ao)
      this.ao.configuration.halfRes = true
    }
    this.buildShadows()
    this.grass?.setQuality(q.grass)
    patchTree(this.scene)
  }

  private buildShadows() {
    const q = this.quality
    if (this.csm) {
      this.csm.remove()
      for (const l of this.csm.lights) l.shadow.map?.dispose()
    }
    setCascadeCount(q.cascades.length)
    const maxFar = q.cascades[q.cascades.length - 1]!
    this.csm = new CSM({
      camera: this.camera,
      parent: this.scene,
      cascades: q.cascades.length,
      maxFar,
      mode: "custom",
      customSplitsCallback: (_n, _near, far, breaks) => {
        for (const d of q.cascades) breaks.push(Math.min(1, d / far))
      },
      shadowMapSize: q.shadowSize,
      lightDirection: this.sunDir.clone().negate(),
      lightIntensity: this.sun.intensity,
      lightNear: 1,
      lightFar: 1500,
      lightMargin: 250,
      shadowBias: -0.00015,
    })
    this.csm.fade = true
    // CSM injects its stock light chunks on construction; put ours back
    installChunks(true)
    this.applySun()
    this.projKey = ""
  }

  private applySun() {
    if (!this.csm) return
    this.csm.lightDirection.copy(this.sunDir).negate()
    for (const l of this.csm.lights) {
      l.color.copy(this.sun.color)
      l.intensity = this.sun.intensity
    }
  }

  applyEnvironment(env: MapFile["environment"]) {
    const p = { ...SKY_PRESETS[env.sky.preset] }
    if (env.sky.sunElevation !== undefined) p.elevation = env.sky.sunElevation
    if (env.sky.sunAzimuth !== undefined) p.azimuth = env.sky.sunAzimuth

    const u = this.sky.material.uniforms
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
    this.hemi.color.set(p.hemiSky)
    this.hemi.groundColor.set(p.hemiGround)
    this.hemi.intensity = p.hemiIntensity
    this.renderer.toneMappingExposure = p.exposure

    const fog = env.fog
    this.scene.fog = new THREE.FogExp2(fog?.color ?? p.fog, fog?.density ?? 0.0025)
    shared.dFogFalloff.value = p.fogFalloff
    shared.dSunDir.value.copy(this.sunDir)
    shared.dSunColor.value.copy(this.sun.color).multiplyScalar(this.sun.intensity * 0.05)
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
    this.envRT = this.pmrem.fromScene(envScene, 0, 0.1, 2000)
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
  }

  /** Hook any newly added objects into the shared shading. */
  track(root: THREE.Object3D) {
    patchTree(root)
  }

  setShadows(enabled: boolean) {
    if (this.renderer.shadowMap.enabled === enabled) return
    this.renderer.shadowMap.enabled = enabled
    invalidateMaterials()
  }

  resize(width: number, height: number) {
    this.size = { w: width, h: height }
    this.composer.setSize(width, height, false)
    this.projKey = ""
  }

  /** Per-frame animation: clouds, wind, grass and downwash from the quad. */
  update(dt: number, camera: THREE.Camera, drone: THREE.Vector3, downwash: number) {
    shared.dTime.value += dt
    this.sky.material.uniforms.time!.value = shared.dTime.value
    // Clouds drift with the wind aloft
    const aloft = this.windSpeed * 2.5 + 3
    const len = this.wind.length() || 1
    shared.dCloudOffset.value.x += (this.wind.x / len) * aloft * dt * shared.dCloudScale.value
    shared.dCloudOffset.value.y += (this.wind.y / len) * aloft * dt * shared.dCloudScale.value
    this.grass?.update(camera, this.groundHeight, this.wind, drone, downwash)
  }

  render(camera: THREE.PerspectiveCamera, dt: number) {
    if (camera !== this.camera) {
      this.camera = camera
      this.composer.setMainCamera(camera)
      this.ao.camera = camera
      this.projKey = ""
    }
    const csm = this.csm
    if (csm) {
      // Fit cascades to this frame's camera, not last frame's
      camera.updateWorldMatrix(true, false)
      const key = `${camera.fov}:${camera.aspect}:${camera.near}`
      if (key !== this.projKey) {
        this.projKey = key
        csm.camera = camera
        csm.updateFrustums()
        const v = shared.CSM_cascades.value
        csm.breaks.forEach((b, i) => v[i]?.set(csm.breaks[i - 1] ?? 0, b))
        shared.cameraNear.value = camera.near
        shared.shadowFar.value = Math.min(camera.far, csm.maxFar)
        // Normal offset scaled to each cascade's texel size kills acne without peter panning
        for (const l of csm.lights) {
          const c = l.shadow.camera
          l.shadow.normalBias = ((c.right - c.left) / csm.shadowMapSize) * 1.5
        }
      }
      csm.update()
    }
    this.composer.render(dt)
  }
}
