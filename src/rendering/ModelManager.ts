import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';

export interface LoadedModel {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

const LOD_SUFFIXES = ['_H0', '_M0', '_L0'];

export class ModelManager {
  private loader = new GLTFLoader();
  private cache = new Map<string, LoadedModel>();
  private loading = new Map<string, Promise<LoadedModel | null>>();
  private notFound = new Set<string>();

  // Unit models in assets/models/Units/, Building models in assets/models/Buildings/
  private basePaths = ['/assets/models/Units/', '/assets/models/Buildings/'];

  async loadModel(xafName: string, lod: 'H0' | 'M0' | 'L0' = 'H0'): Promise<LoadedModel | null> {
    const suffix = `_${lod}`;
    const key = `${xafName}${suffix}`;

    if (this.cache.has(key)) return this.cache.get(key)!;
    if (this.notFound.has(key)) return null;
    if (this.loading.has(key)) return this.loading.get(key)!;

    const promise = this.tryLoad(xafName, suffix, key);
    this.loading.set(key, promise);

    try {
      const result = await promise;
      return result;
    } finally {
      this.loading.delete(key);
    }
  }

  private async tryLoad(xafName: string, suffix: string, key: string): Promise<LoadedModel | null> {
    // Try each base path
    for (const basePath of this.basePaths) {
      const url = `${basePath}${xafName}${suffix}.gltf`;
      try {
        const gltf = await this.loadGltf(url);
        const model: LoadedModel = {
          scene: gltf.scene,
          animations: gltf.animations,
        };
        this.cache.set(key, model);
        return model;
      } catch {
        // Try next path
      }
    }

    this.notFound.add(key);
    console.warn(`Model not found: ${xafName}${suffix} (tried ${this.basePaths.length} paths)`);
    return null;
  }

  private loadGltf(url: string): Promise<GLTF> {
    return new Promise((resolve, reject) => {
      this.loader.load(url, resolve, undefined, reject);
    });
  }

  cloneModel(model: LoadedModel): THREE.Group {
    const clone = model.scene.clone(true);
    // Deep clone materials to allow per-instance coloring
    clone.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.material = (child.material as THREE.Material).clone();
      }
    });
    return clone;
  }

  getFromCache(xafName: string, lod: string = 'H0'): LoadedModel | null {
    return this.cache.get(`${xafName}_${lod}`) ?? null;
  }

  dispose(): void {
    this.cache.forEach(model => {
      model.scene.traverse(child => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (Array.isArray(child.material)) {
            child.material.forEach(m => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
    });
    this.cache.clear();
  }
}
