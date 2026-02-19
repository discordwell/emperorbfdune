/**
 * IconRenderer - Renders 3D models to small thumbnail images for sidebar icons.
 * Uses an offscreen Three.js renderer to create 48x48 previews of each unit/building.
 */

import * as THREE from 'three';
import type { ModelManager } from './ModelManager';

const ICON_SIZE = 48;

export class IconRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private icons = new Map<string, string>(); // model name -> data URL
  private rendering = false;

  constructor() {
    // Create a small offscreen renderer
    const canvas = document.createElement('canvas');
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setSize(ICON_SIZE, ICON_SIZE);
    this.renderer.setClearColor(0x000000, 0);

    // Simple scene with directional lighting
    this.scene = new THREE.Scene();
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffeedd, 1.0);
    dir.position.set(2, 3, 2);
    this.scene.add(dir);

    // Camera looking at model center
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    this.camera.position.set(0, 2, 4);
    this.camera.lookAt(0, 0.5, 0);
  }

  /**
   * Render icons for a list of model names. Call during loading.
   * Returns a map of model name -> data URL.
   */
  async renderIcons(modelNames: string[], modelManager: ModelManager): Promise<Map<string, string>> {
    if (this.rendering) return this.icons;
    this.rendering = true;

    for (const name of modelNames) {
      if (this.icons.has(name)) continue;

      const model = modelManager.getFromCache(name);
      if (!model) continue;

      try {
        const dataUrl = this.renderModelToIcon(model.scene);
        if (dataUrl) this.icons.set(name, dataUrl);
      } catch {
        // Skip failed renders
      }
    }

    this.rendering = false;
    return this.icons;
  }

  private renderModelToIcon(modelScene: THREE.Group): string | null {
    // Clone and add to scene
    const clone = modelScene.clone(true);

    // Auto-center and scale the model to fit the viewport
    const box = new THREE.Box3().setFromObject(clone);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    if (maxDim < 0.001) return null;

    const scale = 2.0 / maxDim;
    clone.scale.setScalar(scale);
    clone.position.sub(center.multiplyScalar(scale));
    clone.position.y += 0.2; // Slight offset up

    this.scene.add(clone);

    // Render
    this.renderer.render(this.scene, this.camera);
    const dataUrl = this.renderer.domElement.toDataURL('image/png');

    // Cleanup
    this.scene.remove(clone);

    return dataUrl;
  }

  getIcon(name: string): string | null {
    return this.icons.get(name) ?? null;
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
