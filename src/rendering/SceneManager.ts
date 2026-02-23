import * as THREE from 'three';
import type { RenderSystem } from '../core/Game';
import type { MapLighting } from '../config/MapLoader';
import type { PIPRenderer } from './PIPRenderer';

export class SceneManager implements RenderSystem {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;

  // Camera rig: orbit-style for RTS
  readonly cameraTarget = new THREE.Vector3(55, 0, 55); // Start at player base area
  private cameraDistance = 50;
  private cameraAngle = Math.PI * 0.44; // ~79 degrees from horizontal - nearly top-down RTS
  private cameraRotation = 0; // Y rotation

  // Zoom limits
  private readonly MIN_ZOOM = 20;
  private readonly MAX_ZOOM = 200;

  // Smooth pan target for animated camera movements
  private panTarget: THREE.Vector3 | null = null;
  private panSpeed = 0.12; // Lerp factor per frame

  // Raycaster for picking
  readonly raycaster = new THREE.Raycaster();
  readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  // Sand particle system
  private sandParticles: THREE.Points | null = null;
  private sandParticlePositions: Float32Array | null = null;

  // PIP (Picture-in-Picture) camera renderer
  private pipRenderer: PIPRenderer | null = null;

  // Sun light for shadow tracking
  private sunLight: THREE.DirectionalLight | null = null;
  private ambientLight: THREE.AmbientLight | null = null;
  private hemiLight: THREE.HemisphereLight | null = null;

  // Per-map base lighting colors (set from test.lit, modulated by day/night)
  private baseSunColor = new THREE.Color(0xffeedd);
  private baseSunIntensity = 1.2;
  private baseAmbientColor = new THREE.Color(0xffe4b5);
  private baseAmbientIntensity = 0.4;
  private baseHemiSkyColor = new THREE.Color(0x87CEEB);
  private baseHemiGroundColor = new THREE.Color(0xC2B280);
  private baseHemiIntensity = 0.3;

  // Map bounds for camera clamping (world units)
  private mapBoundsX = 128 * 2;
  private mapBoundsZ = 128 * 2;

  // Whether this instance created the renderer (vs receiving an external one)
  private ownsRenderer: boolean;

  constructor(existingRenderer?: THREE.WebGLRenderer) {
    this.canvas = document.getElementById('game-canvas') as HTMLCanvasElement;

    this.scene = new THREE.Scene();

    // Desert sky gradient
    const skyCanvas = document.createElement('canvas');
    skyCanvas.width = 2;
    skyCanvas.height = 256;
    const ctx = skyCanvas.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#1a1a3a');    // Zenith: dark blue
    grad.addColorStop(0.4, '#3a2a1a');  // Mid: warm brown
    grad.addColorStop(0.7, '#c08040');  // Horizon: orange haze
    grad.addColorStop(1.0, '#e0a050');  // Below horizon: sandy glow
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 2, 256);
    const skyTex = new THREE.CanvasTexture(skyCanvas);
    skyTex.mapping = THREE.EquirectangularReflectionMapping;
    this.scene.background = skyTex;

    // Distance fog for heat haze effect
    this.scene.fog = new THREE.FogExp2(0xc09050, 0.007);

    // Perspective camera with slight ortho feel (narrow FOV)
    this.camera = new THREE.PerspectiveCamera(
      50, // Wider FOV to see more terrain
      window.innerWidth / window.innerHeight,
      1,
      2000
    );

    if (existingRenderer) {
      this.renderer = existingRenderer;
      this.ownsRenderer = false;
    } else {
      this.ownsRenderer = true;
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: true,
        powerPreference: 'high-performance',
      });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    }
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Lighting - desert sun
    this.ambientLight = new THREE.AmbientLight(0xffe4b5, 0.4);
    this.scene.add(this.ambientLight);

    this.sunLight = new THREE.DirectionalLight(0xffeedd, 1.2);
    this.sunLight.position.set(100, 150, 80);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.left = -120;
    this.sunLight.shadow.camera.right = 120;
    this.sunLight.shadow.camera.top = 120;
    this.sunLight.shadow.camera.bottom = -120;
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 500;
    this.scene.add(this.sunLight);

    // Hemisphere light for ambient sky/ground color
    this.hemiLight = new THREE.HemisphereLight(0x87CEEB, 0xC2B280, 0.3);
    this.scene.add(this.hemiLight);

    // Drifting sand particles
    this.createSandParticles();

    this.updateCameraPosition();

    window.addEventListener('resize', this.onResize);
  }

  private createSandParticles(): void {
    const count = 1500;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = Math.random() * 300 - 50;
      positions[i * 3 + 1] = Math.random() * 15 + 0.5;
      positions[i * 3 + 2] = Math.random() * 300 - 50;
    }
    this.sandParticlePositions = positions;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xd4b06a,
      size: 0.3,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.sandParticles = new THREE.Points(geo, mat);
    this.scene.add(this.sandParticles);
  }

  /** Attach a PIP renderer to be rendered after the main scene each frame. */
  setPIPRenderer(pip: PIPRenderer): void {
    this.pipRenderer = pip;
  }

  /** Get the attached PIP renderer (if any). */
  getPIPRenderer(): PIPRenderer | null {
    return this.pipRenderer;
  }

  init(): void {
    // Already set up in constructor
  }

  render(_alpha: number): void {
    // Smooth camera pan animation
    if (this.panTarget) {
      this.cameraTarget.lerp(this.panTarget, this.panSpeed);
      const dist = this.cameraTarget.distanceTo(this.panTarget);
      if (dist < 0.5) {
        this.cameraTarget.copy(this.panTarget);
        this.panTarget = null;
      }
      this.updateCameraPosition();
    }

    // Animate sand particles - drift with wind
    if (this.sandParticlePositions) {
      const pos = this.sandParticlePositions;
      for (let i = 0; i < pos.length; i += 3) {
        pos[i] += 0.08;      // Wind X
        pos[i + 2] += 0.03;  // Wind Z
        pos[i + 1] += (Math.random() - 0.5) * 0.04; // Flutter
        // Wrap around camera vicinity (both directions)
        if (pos[i] > this.cameraTarget.x + 150) pos[i] = this.cameraTarget.x - 150;
        if (pos[i] < this.cameraTarget.x - 150) pos[i] = this.cameraTarget.x + 150;
        if (pos[i + 2] > this.cameraTarget.z + 150) pos[i + 2] = this.cameraTarget.z - 150;
        if (pos[i + 2] < this.cameraTarget.z - 150) pos[i + 2] = this.cameraTarget.z + 150;
        pos[i + 1] = Math.max(0.3, Math.min(15, pos[i + 1]));
      }
      this.sandParticles!.geometry.attributes.position.needsUpdate = true;
    }

    // Move shadow-casting sun to follow camera so shadows stay sharp
    if (this.sunLight) {
      const ct = this.cameraTarget;
      this.sunLight.position.set(ct.x + 100, 150, ct.z + 80);
      this.sunLight.target.position.copy(ct);
      this.sunLight.target.updateMatrixWorld();
    }

    this.renderer.render(this.scene, this.camera);

    // Render PIP viewport on top if active
    if (this.pipRenderer) {
      this.pipRenderer.render(this.renderer, this.scene);
    }
  }

  /** Set map bounds for camera clamping (in world units) */
  setMapBounds(worldW: number, worldH: number): void {
    this.mapBoundsX = worldW;
    this.mapBoundsZ = worldH;
    // Propagate to PIP camera
    if (this.pipRenderer) {
      this.pipRenderer.setMapBounds(worldW, worldH);
    }
  }

  /** Set per-map lighting colors from test.lit data */
  setMapLighting(lighting: MapLighting): void {
    const toColor = (rgb: [number, number, number]) =>
      new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);

    this.baseSunColor = toColor(lighting.sunColor);
    this.baseAmbientColor = toColor(lighting.ambientColor);
    this.baseHemiGroundColor = toColor(lighting.groundColor);

    if (lighting.skyColor) {
      this.baseHemiSkyColor = toColor(lighting.skyColor);
    }

    // Use first intensity value as sun multiplier
    const intensityMul = lighting.intensity[0] ?? 1.0;
    this.baseSunIntensity = 1.2 * intensityMul;
    this.baseAmbientIntensity = 0.4 * intensityMul;
    this.baseHemiIntensity = 0.3 * intensityMul;

    // Apply immediately
    if (this.sunLight) {
      this.sunLight.color.copy(this.baseSunColor);
      this.sunLight.intensity = this.baseSunIntensity;
    }
    if (this.ambientLight) {
      this.ambientLight.color.copy(this.baseAmbientColor);
      this.ambientLight.intensity = this.baseAmbientIntensity;
    }
    if (this.hemiLight) {
      this.hemiLight.color.copy(this.baseHemiSkyColor);
      this.hemiLight.groundColor.copy(this.baseHemiGroundColor);
      this.hemiLight.intensity = this.baseHemiIntensity;
    }

    // Update fog to match ambient tone
    const fogColor = this.baseAmbientColor.clone().lerp(this.baseSunColor, 0.3);
    this.scene.fog = new THREE.FogExp2(fogColor.getHex(), 0.007);
  }

  /** Smoothly pan the camera to a world position (clamped to map bounds) */
  panTo(x: number, z: number): void {
    const cx = Math.max(-20, Math.min(this.mapBoundsX + 20, x));
    const cz = Math.max(-20, Math.min(this.mapBoundsZ + 20, z));
    this.panTarget = new THREE.Vector3(cx, 0, cz);
  }

  /** Get current camera target position */
  getCameraTarget(): { x: number; z: number } {
    return { x: this.cameraTarget.x, z: this.cameraTarget.z };
  }

  /** Instantly snap camera (cancels any smooth pan) */
  snapTo(x: number, z: number): void {
    this.panTarget = null;
    this.cameraTarget.set(x, 0, z);
    this.updateCameraPosition();
  }

  // Camera controls
  panCamera(dx: number, dz: number): void {
    // Pan relative to camera rotation
    const cos = Math.cos(this.cameraRotation);
    const sin = Math.sin(this.cameraRotation);
    this.cameraTarget.x += dx * cos - dz * sin;
    this.cameraTarget.z += dx * sin + dz * cos;

    // Clamp to map bounds (with some padding)
    this.cameraTarget.x = Math.max(-20, Math.min(this.mapBoundsX + 20, this.cameraTarget.x));
    this.cameraTarget.z = Math.max(-20, Math.min(this.mapBoundsZ + 20, this.cameraTarget.z));

    this.updateCameraPosition();
  }

  zoom(delta: number): void {
    this.cameraDistance = Math.max(
      this.MIN_ZOOM,
      Math.min(this.MAX_ZOOM, this.cameraDistance + delta)
    );
    this.updateCameraPosition();
  }

  rotateCamera(delta: number): void {
    const TWO_PI = Math.PI * 2;
    this.cameraRotation = ((this.cameraRotation + delta) % TWO_PI + TWO_PI) % TWO_PI;
    this.updateCameraPosition();
  }

  getCameraRotation(): number {
    return this.cameraRotation;
  }

  getZoom(): number {
    return this.cameraDistance;
  }

  setZoom(zoom: number): void {
    this.cameraDistance = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, zoom));
    this.updateCameraPosition();
  }

  setRotation(rotation: number): void {
    const TWO_PI = Math.PI * 2;
    this.cameraRotation = ((rotation % TWO_PI) + TWO_PI) % TWO_PI;
    this.updateCameraPosition();
  }

  isPanning(): boolean {
    return this.panTarget !== null;
  }

  screenToWorld(screenX: number, screenY: number): THREE.Vector3 | null {
    const ndc = new THREE.Vector2(
      (screenX / window.innerWidth) * 2 - 1,
      -(screenY / window.innerHeight) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    const result = this.raycaster.ray.intersectPlane(this.groundPlane, hit);
    return result;
  }

  // Camera shake
  private shakeIntensity = 0;
  private shakeDecay = 0.92;

  /** Trigger camera shake (intensity 0-1, decays over time) */
  shake(intensity: number): void {
    this.shakeIntensity = Math.max(this.shakeIntensity, intensity);
  }

  updateCameraPosition(): void {
    const offset = new THREE.Vector3(
      Math.sin(this.cameraRotation) * Math.cos(this.cameraAngle) * this.cameraDistance,
      Math.sin(this.cameraAngle) * this.cameraDistance,
      Math.cos(this.cameraRotation) * Math.cos(this.cameraAngle) * this.cameraDistance
    );
    this.camera.position.copy(this.cameraTarget).add(offset);

    // Apply shake
    if (this.shakeIntensity > 0.01) {
      const s = this.shakeIntensity * 0.5;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.camera.position.z += (Math.random() - 0.5) * s;
      this.shakeIntensity *= this.shakeDecay;
    } else {
      this.shakeIntensity = 0;
    }

    this.camera.lookAt(this.cameraTarget);
  }

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  /**
   * Subtle ambient lighting shift based on game time.
   * Full cycle = 15000 ticks (~10 minutes).
   * Modulates the per-map base colors set by setMapLighting().
   * Dawn=warm gold, Midday=bright white, Dusk=orange, Night=cool blue-tinted.
   */
  updateDayNightCycle(tick: number): void {
    const CYCLE_LENGTH = 15000;
    const phase = (tick % CYCLE_LENGTH) / CYCLE_LENGTH; // 0-1

    // Smooth cosine: 1.0 at midday (phase 0.25), -1.0 at midnight (phase 0.75)
    const sunPhase = Math.cos((phase - 0.25) * Math.PI * 2);

    // Intensity modulation around base values (subtle +-15%)
    const sunMul = 1.0 + sunPhase * 0.12;
    const ambMul = 1.0 + sunPhase * 0.15;

    const coolness = Math.max(0, -sunPhase);
    const dawnDusk = Math.max(0, 1 - Math.abs(sunPhase) * 2.5);

    if (this.sunLight) {
      this.sunLight.intensity = this.baseSunIntensity * sunMul;
      // Modulate base sun color with subtle cool/warm shift
      this.sunLight.color.copy(this.baseSunColor);
      this.sunLight.color.g *= 1.0 - coolness * 0.08 + dawnDusk * 0.02;
      this.sunLight.color.b *= 1.0 - coolness * 0.05 - dawnDusk * 0.15;
    }
    if (this.ambientLight) {
      this.ambientLight.intensity = this.baseAmbientIntensity * ambMul;
      this.ambientLight.color.copy(this.baseAmbientColor);
      this.ambientLight.color.r *= 1.0 - coolness * 0.05;
      this.ambientLight.color.g *= 1.0 - coolness * 0.05 + dawnDusk * 0.03;
      this.ambientLight.color.b *= 1.0 + coolness * 0.1 - dawnDusk * 0.1;
    }
    if (this.hemiLight) {
      this.hemiLight.intensity = this.baseHemiIntensity * (1.0 + sunPhase * 0.15);
    }
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    if (this.sandParticles) {
      this.scene.remove(this.sandParticles);
      this.sandParticles.geometry.dispose();
      (this.sandParticles.material as THREE.PointsMaterial).dispose();
    }
    if (this.scene.background instanceof THREE.Texture) {
      this.scene.background.dispose();
    }
    if (this.pipRenderer) {
      this.pipRenderer.dispose();
      this.pipRenderer = null;
    }
    if (this.ownsRenderer) this.renderer.dispose();
  }
}
