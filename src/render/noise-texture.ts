import * as THREE from "three"
import { fbm } from "../map/noise"

let tex: THREE.DataTexture | null = null

/**
 * Tileable 256x256 RGBA value noise, one octave stack per channel at a
 * different base frequency. Sampled by terrain, grass and cloud shadows, so
 * shaders get fbm for a single fetch.
 */
export function noiseTexture() {
  if (tex) return tex
  const S = 256
  const scales = [4, 8, 16, 32]
  const octaves = [5, 4, 4, 3]
  const data = new Uint8Array(S * S * 4)
  for (let c = 0; c < 4; c++) {
    const sc = scales[c]!
    const vals = new Float32Array(S * S)
    let lo = Infinity
    let hi = -Infinity
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const v = fbm((x / S) * sc, (y / S) * sc, octaves[c]!, 101 + c * 31, sc)
        vals[y * S + x] = v
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    const k = 255 / (hi - lo)
    for (let i = 0; i < S * S; i++) data[i * 4 + c] = (vals[i]! - lo) * k
  }
  tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}
