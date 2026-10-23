declare module "n8ao" {
  import type { Camera, Color, Scene } from "three"
  import { Pass } from "postprocessing"

  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number)
    camera: Camera
    configuration: {
      aoRadius: number
      distanceFalloff: number
      intensity: number
      color: Color
      halfRes: boolean
      depthAwareUpsampling: boolean
      gammaCorrection: boolean
      transparencyAware: boolean
      screenSpaceRadius: boolean
      aoSamples: number
      denoiseSamples: number
      denoiseRadius: number
      accumulate: boolean
    }
    setQualityMode(mode: "Performance" | "Low" | "Medium" | "High" | "Ultra"): void
  }
}
