import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';

export interface LoadedModel {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

export interface LoadResult {
  status: 'loaded' | 'failed';
  url?: string;
  error?: string;
}

export interface LoadReport {
  loaded: string[];
  failed: string[];
  total: number;
}

// Fallback aliases for buildings whose models were not converted.
// Maps missing xaf name (lowercase) to an available substitute.
const MODEL_ALIASES: Record<string, string> = {
  'at_silo': 'AT_Refinery',
  'hk_silo': 'HK_Refinery',
  'or_silo': 'OR_Refinery',
  'hk_repairpad': 'at_helipad',
  'or_helipad': 'at_helipad',
};

export class ModelManager {
  private loader = new GLTFLoader();
  private cache = new Map<string, LoadedModel>();
  private loading = new Map<string, Promise<LoadedModel | null>>();
  private notFound = new Set<string>();
  private loadResults = new Map<string, LoadResult>();

  // Manifest: lowercase filename (without path/extension) -> actual full path
  private manifest = new Map<string, string>();
  private manifestLoaded = false;

  // Unit models in assets/models/Units/, Building models in assets/models/Buildings/
  private basePaths = ['/assets/models/Units/', '/assets/models/Buildings/'];

  async loadManifest(): Promise<void> {
    if (this.manifestLoaded) return;
    try {
      const resp = await fetch('/assets/models/manifest.json');
      if (resp.ok) {
        const paths: string[] = await resp.json();
        for (const p of paths) {
          // Extract filename without extension as key: "Buildings/AT_ConYard_H0" -> "at_conyard_h0"
          const parts = p.replace(/\.gltf$/i, '').split('/');
          const filename = parts[parts.length - 1];
          this.manifest.set(filename.toLowerCase(), `/assets/models/${p}`);
        }
        this.manifestLoaded = true;
        console.log(`Model manifest loaded: ${this.manifest.size} entries`);
      }
    } catch {
      console.warn('Model manifest not found, falling back to URL guessing');
    }
  }

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

  // Fallback LOD suffixes when the requested one isn't found
  private static readonly LOD_FALLBACKS: Record<string, string[]> = {
    '_H0': ['_H0', '_h0', '_H1', '_h1', '_M0', '_m0', '_M1', '_L0', '_L1', '_H2', '_H3', '_M2'],
    '_M0': ['_M0', '_m0', '_M1', '_L0', '_L1'],
    '_L0': ['_L0', '_L1', '_L2'],
  };

  private async tryLoad(xafName: string, suffix: string, key: string, aliasAttempted = false): Promise<LoadedModel | null> {
    const fallbacks = ModelManager.LOD_FALLBACKS[suffix] || [suffix];

    // Try manifest lookup first (case-insensitive)
    if (this.manifestLoaded) {
      for (const trySuffix of fallbacks) {
        const lookupKey = `${xafName}${trySuffix}`.toLowerCase();
        const manifestUrl = this.manifest.get(lookupKey);
        if (manifestUrl) {
          try {
            const gltf = await this.loadGltf(manifestUrl);
            const model: LoadedModel = { scene: gltf.scene, animations: gltf.animations };
            this.cache.set(key, model);
            this.loadResults.set(xafName, { status: 'loaded', url: manifestUrl });
            return model;
          } catch {
            // Manifest entry exists but file failed to load, continue
          }
        }
      }
    }

    // Fallback: guess URLs directly
    for (const trySuffix of fallbacks) {
      for (const basePath of this.basePaths) {
        const url = `${basePath}${xafName}${trySuffix}.gltf`;
        try {
          const gltf = await this.loadGltf(url);
          const model: LoadedModel = { scene: gltf.scene, animations: gltf.animations };
          this.cache.set(key, model);
          this.loadResults.set(xafName, { status: 'loaded', url });
          return model;
        } catch {
          // Try next
        }
      }
    }

    // Try alias fallback for missing building models (single hop only)
    if (!aliasAttempted) {
      const alias = MODEL_ALIASES[xafName.toLowerCase()];
      if (alias) {
        const aliasResult = await this.tryLoad(alias, suffix, key, true);
        if (aliasResult) {
          this.loadResults.set(xafName, { status: 'loaded', url: `alias:${alias}` });
          return aliasResult;
        }
      }
    }

    this.notFound.add(key);
    this.loadResults.set(xafName, { status: 'failed', error: `No file found for ${xafName} (tried ${fallbacks.length} LOD variants)` });
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
        if (Array.isArray(child.material)) {
          child.material = child.material.map(m => m.clone());
        } else {
          child.material = (child.material as THREE.Material).clone();
        }
      }
    });
    return clone;
  }

  getFromCache(xafName: string, lod: string = 'H0'): LoadedModel | null {
    return this.cache.get(`${xafName}_${lod}`) ?? null;
  }

  getLoadResults(): Map<string, LoadResult> {
    return this.loadResults;
  }

  getLoadReport(): LoadReport {
    const loaded: string[] = [];
    const failed: string[] = [];
    for (const [name, result] of this.loadResults) {
      if (result.status === 'loaded') loaded.push(name);
      else failed.push(name);
    }
    return { loaded, failed, total: loaded.length + failed.length };
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
    this.loading.clear();
    this.notFound.clear();
    this.loadResults.clear();
  }
}
