import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';

export class MenuSceneManager {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private canvas: HTMLCanvasElement;

  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();

  private clickTargets: THREE.Object3D[] = [];
  private clickHandler: ((mesh: THREE.Object3D) => void) | null = null;
  private hoverTargets: THREE.Object3D[] = [];
  private hoverHandler: ((mesh: THREE.Object3D | null) => void) | null = null;
  private hoveredMesh: THREE.Object3D | null = null;

  private animations: ((dt: number) => void)[] = [];
  private running = false;
  private rafId = 0;
  private lastTime = 0;

  // Fade overlay
  private fadeOverlay: HTMLDivElement | null = null;

  // Loader with texture path remapping
  private loader: GLTFLoader;

  constructor(canvas: HTMLCanvasElement, renderer: THREE.WebGLRenderer) {
    this.canvas = canvas;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);

    this.camera = new THREE.PerspectiveCamera(
      45,
      window.innerWidth / window.innerHeight,
      0.1,
      10000
    );

    // Set up loader with texture URL remapping
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url: string) => {
      if (url.includes('textures/')) {
        return url.replace(/.*textures\//, '/assets/textures/');
      }
      return url;
    });
    this.loader = new GLTFLoader(manager);

    // Event listeners
    this.canvas.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('click', this.onClick);
    window.addEventListener('resize', this.onResize);
  }

  async loadScene(path: string): Promise<THREE.Group> {
    return new Promise((resolve, reject) => {
      this.loader.load(
        path,
        (gltf: GLTF) => {
          this.scene.add(gltf.scene);
          resolve(gltf.scene);
        },
        undefined,
        reject
      );
    });
  }

  findMesh(root: THREE.Object3D, name: string): THREE.Object3D | null {
    let result: THREE.Object3D | null = null;
    root.traverse((child) => {
      if (child.name === name && !result) result = child;
    });
    return result;
  }

  findMeshesByPattern(root: THREE.Object3D, pattern: RegExp): THREE.Object3D[] {
    const results: THREE.Object3D[] = [];
    root.traverse((child) => {
      if (pattern.test(child.name)) results.push(child);
    });
    return results;
  }

  setClickTargets(meshes: THREE.Object3D[], handler: (mesh: THREE.Object3D) => void): void {
    this.clickTargets = meshes;
    this.clickHandler = handler;
  }

  setHoverTargets(meshes: THREE.Object3D[], handler: (mesh: THREE.Object3D | null) => void): void {
    this.hoverTargets = meshes;
    this.hoverHandler = handler;
  }

  addAnimation(callback: (dt: number) => void): void {
    this.animations.push(callback);
  }

  clearAnimations(): void {
    this.animations = [];
  }

  startRenderLoop(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const loop = (time: number) => {
      if (!this.running) return;
      const dt = Math.min((time - this.lastTime) / 1000, 0.1);
      this.lastTime = time;

      for (const anim of this.animations) anim(dt);
      this.renderer.render(this.scene, this.camera);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stopRenderLoop(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  async fadeOut(ms: number): Promise<void> {
    const overlay = this.ensureFadeOverlay();
    overlay.style.opacity = '0';
    overlay.style.display = 'block';
    overlay.style.transition = `opacity ${ms}ms ease-in`;
    // Force reflow
    overlay.offsetHeight;
    overlay.style.opacity = '1';
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async fadeIn(ms: number): Promise<void> {
    const overlay = this.ensureFadeOverlay();
    overlay.style.opacity = '1';
    overlay.style.display = 'block';
    overlay.style.transition = `opacity ${ms}ms ease-out`;
    overlay.offsetHeight;
    overlay.style.opacity = '0';
    return new Promise((resolve) => {
      setTimeout(() => {
        overlay.style.display = 'none';
        resolve();
      }, ms);
    });
  }

  projectToScreen(worldPos: THREE.Vector3): { x: number; y: number; visible: boolean } {
    const v = worldPos.clone().project(this.camera);
    const x = (v.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-v.y * 0.5 + 0.5) * window.innerHeight;
    return { x, y, visible: v.z < 1 };
  }

  dispose(): void {
    this.stopRenderLoop();
    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('click', this.onClick);
    window.removeEventListener('resize', this.onResize);

    // Dispose all scene contents
    const texProps = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'bumpMap', 'envMap', 'lightMap', 'alphaMap', 'displacementMap'] as const;
    this.scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry?.dispose();
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const mat of mats) {
          if (!mat) continue;
          for (const prop of texProps) {
            const tex = (mat as any)[prop];
            if (tex instanceof THREE.Texture) tex.dispose();
          }
          mat.dispose();
        }
      }
    });
    this.scene.clear();

    if (this.fadeOverlay) {
      this.fadeOverlay.remove();
      this.fadeOverlay = null;
    }

    this.clickTargets = [];
    this.hoverTargets = [];
    this.animations = [];
  }

  // --- Private ---

  private ensureFadeOverlay(): HTMLDivElement {
    if (!this.fadeOverlay) {
      this.fadeOverlay = document.createElement('div');
      this.fadeOverlay.style.cssText = `
        position:fixed;top:0;left:0;right:0;bottom:0;
        background:#000;z-index:3000;pointer-events:none;
        display:none;opacity:0;
      `;
      document.body.appendChild(this.fadeOverlay);
    }
    return this.fadeOverlay;
  }

  private updateMouse(e: MouseEvent): void {
    this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  }

  private raycastTargets(targets: THREE.Object3D[]): THREE.Object3D | null {
    if (targets.length === 0) return null;
    this.raycaster.setFromCamera(this.mouse, this.camera);

    // Collect all mesh descendants of targets
    const meshes: THREE.Mesh[] = [];
    for (const target of targets) {
      target.traverse((child) => {
        if (child instanceof THREE.Mesh) meshes.push(child);
      });
    }

    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;

    // Find which target contains the hit mesh
    const hitObj = hits[0].object;
    for (const target of targets) {
      let found = false;
      target.traverse((child) => {
        if (child === hitObj) found = true;
      });
      if (found) return target;
    }
    return null;
  }

  private onMouseMove = (e: MouseEvent): void => {
    this.updateMouse(e);
    if (this.hoverTargets.length === 0 || !this.hoverHandler) return;

    const hit = this.raycastTargets(this.hoverTargets);
    if (hit !== this.hoveredMesh) {
      this.hoveredMesh = hit;
      this.hoverHandler(hit);
    }
  };

  private onClick = (e: MouseEvent): void => {
    this.updateMouse(e);
    if (this.clickTargets.length === 0 || !this.clickHandler) return;

    const hit = this.raycastTargets(this.clickTargets);
    if (hit) {
      this.clickHandler(hit);
    }
  };

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };
}
