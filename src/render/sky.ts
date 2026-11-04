import * as THREE from "three"
import { Sky } from "three/examples/jsm/objects/Sky.js"

const DISPLAY_FRAG = /* glsl */ `
varying vec3 vWorldPosition;
varying vec3 vSunDirection;
varying vec3 vBetaR;
varying vec3 vBetaM;
varying float vSunE;
uniform samplerCube tSky;
uniform float showSunDisc;
const float pi = 3.141592653589793;
const float rayleighZenithLength = 8.4E3;
const float mieZenithLength = 1.25E3;
const float sunAngularDiameterCos = 0.999956676946448443553574619906976478926848692873900859324;
void main() {
  vec3 direction = normalize( vWorldPosition - cameraPosition );
  vec4 s = textureCube( tSky, direction );
  vec3 col = s.rgb;
  // The sun disc is too small for the cube map, so it's drawn here, behind
  // the clouds (alpha holds how much they cover it)
  float cosTheta = dot( direction, vSunDirection );
  if ( showSunDisc > 0.5 && cosTheta > sunAngularDiameterCos - 2e-5 ) {
    float zenithAngle = acos( max( 0.0, direction.y ) );
    float inverse = 1.0 / ( cos( zenithAngle ) + 0.15 * pow( 93.885 - ( ( zenithAngle * 180.0 ) / pi ), -1.253 ) );
    vec3 Fex = exp( -( vBetaR * rayleighZenithLength * inverse + vBetaM * mieZenithLength * inverse ) );
    float sundisc = clamp( ( cosTheta - sunAngularDiameterCos ) * 50000.0, 0.0, 1.0 );
    col += ( 760.0 * sundisc ) * min( vSunE * Fex, 80.0 ) * ( 1.0 - s.a );
  }
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

/**
 * The sky only depends on view direction and changes slowly (drifting
 * clouds), so the full scattering and cloud shader renders into a cube map,
 * one face per frame, and the visible sky is a single cube fetch per pixel.
 */
export class SkyCache {
  /** The real sky shader. Set its uniforms; they're shared with the display mesh. */
  readonly source = new Sky()
  /** Add this to the scene. */
  readonly mesh: THREE.Mesh
  private scene = new THREE.Scene()
  private target: THREE.WebGLCubeRenderTarget
  private cube: THREE.CubeCamera
  private face = 0
  private full = true

  constructor(size = 768) {
    this.target = new THREE.WebGLCubeRenderTarget(size, {
      type: THREE.HalfFloatType,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    })
    this.cube = new THREE.CubeCamera(0.1, 10, this.target)
    const mat = this.source.material as THREE.ShaderMaterial
    const u = mat.uniforms
    // Cube faces: no sun disc, and alpha = how much cloud covers the sun
    mat.fragmentShader = mat.fragmentShader
      .replace("// Clouds", "float dCloudA = 0.0;\n\t\t\t// Clouds")
      .replace(
        "// Occlude the sun disc/glow behind opaque cloud",
        "dCloudA = alpha * dot( Fex, vec3( 1.0 / 3.0 ) );\n\t\t\t\t// Occlude the sun disc/glow behind opaque cloud",
      )
      .replace("gl_FragColor = vec4( texColor, 1.0 );", "gl_FragColor = vec4( texColor, dCloudA );")
    u.showSunDisc!.value = 0
    this.source.scale.setScalar(45000)
    this.source.frustumCulled = false
    this.scene.add(this.source)

    const display = new THREE.ShaderMaterial({
      name: "SkyDisplay",
      vertexShader: mat.vertexShader,
      fragmentShader: DISPLAY_FRAG,
      uniforms: { ...u, tSky: { value: this.target.texture }, showSunDisc: { value: 1 } },
      side: THREE.BackSide,
      depthWrite: false,
    })
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), display)
    this.mesh.scale.setScalar(45000)
    this.mesh.frustumCulled = false
  }

  get uniforms() {
    return (this.source.material as THREE.ShaderMaterial).uniforms
  }

  /** Re-render all faces next frame, e.g. after the sky changed. */
  invalidate() {
    this.full = true
  }

  /** Render one cube face (all six after an invalidate). Call outside other passes. */
  update(renderer: THREE.WebGLRenderer) {
    const cube = this.cube
    if (cube.coordinateSystem !== renderer.coordinateSystem) {
      cube.coordinateSystem = renderer.coordinateSystem
      cube.updateCoordinateSystem()
    }
    cube.updateMatrixWorld(true)
    const prev = renderer.getRenderTarget()
    const faces = this.full ? [0, 1, 2, 3, 4, 5] : [this.face]
    this.full = false
    this.face = (this.face + 1) % 6
    for (const f of faces) {
      renderer.setRenderTarget(this.target, f)
      renderer.render(this.scene, cube.children[f] as THREE.Camera)
    }
    renderer.setRenderTarget(prev)
  }

  dispose() {
    this.target.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.mesh.geometry.dispose()
  }
}
