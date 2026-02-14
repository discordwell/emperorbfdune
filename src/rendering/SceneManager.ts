import * as THREE from 'three';
import type { RenderSystem } from '../core/Game';

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
    this.scene.fog = new THREE.FogExp2(0xc09050, 0.003);

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
    const ambientLight = new THREE.AmbientLight(0xffe4b5, 0.4);
    this.scene.add(ambientLight);

    const sunLight = new THREE.DirectionalLight(0xffeedd, 1.2);
    sunLight.position.set(100, 150, 80);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.camera.left = -200;
    sunLight.shadow.camera.right = 200;
    sunLight.shadow.camera.top = 200;
    sunLight.shadow.camera.bottom = -200;
    sunLight.shadow.camera.near = 1;
    sunLight.shadow.camera.far = 500;
    this.scene.add(sunLight);

    // Hemisphere light for ambient sky/ground color
    const hemiLight = new THREE.HemisphereLight(0x87CEEB, 0xC2B280, 0.3);
    this.scene.add(hemiLight);

    // Drifting sand particles
    this.createSandParticles();

    this.updateCameraPosition();

    window.addEventListener('resize', this.onResize);
  }

  private createSandParticles(): void {
    const count = 600;
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
      opacity: 0.4,
      depthWrite: false,
    });
    this.sandParticles = new THREE.Points(geo, mat);
    this.scene.add(this.sandParticles);
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
        // Wrap around camera vicinity
        if (pos[i] > this.cameraTarget.x + 150) pos[i] = this.cameraTarget.x - 150;
        if (pos[i + 2] > this.cameraTarget.z + 150) pos[i + 2] = this.cameraTarget.z - 150;
        pos[i + 1] = Math.max(0.3, Math.min(15, pos[i + 1]));
      }
      this.sandParticles!.geometry.attributes.position.needsUpdate = true;
    }

    this.renderer.render(this.scene, this.camera);
  }

  /** Smoothly pan the camera to a world position */
  panTo(x: number, z: number): void {
    this.panTarget = new THREE.Vector3(x, 0, z);
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
    const mapSize = 128 * 2; // tiles * tile size
    this.cameraTarget.x = Math.max(-20, Math.min(mapSize + 20, this.cameraTarget.x));
    this.cameraTarget.z = Math.max(-20, Math.min(mapSize + 20, this.cameraTarget.z));

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
    this.cameraRotation += delta;
    this.updateCameraPosition();
  }

  getCameraRotation(): number {
    return this.cameraRotation;
  }

  getZoom(): number {
    return this.cameraDistance;
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

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    if (this.sandParticles) {
      this.sandParticles.geometry.dispose();
      (this.sandParticles.material as THREE.PointsMaterial).dispose();
    }
    if (this.scene.background instanceof THREE.Texture) {
      this.scene.background.dispose();
    }
    if (this.ownsRenderer) this.renderer.dispose();
  }
}
