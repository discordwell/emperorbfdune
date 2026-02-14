import * as THREE from 'three';
import { MenuSceneManager } from './MenuSceneManager';
import { MenuTextOverlay } from './MenuTextOverlay';

interface HouseEntry {
  id: string;
  planetBox: THREE.Object3D;  // #atbox, #orbox, #hkbox
  planet: THREE.Object3D;     // HKplanet^, ORplanet^, ATplanet^
  logo: THREE.Object3D;       // ATlogo, HKlogo, ORlogo
  accept: THREE.Object3D;     // ATAccept, HKAccept, ORAccept
  cancel: THREE.Object3D;     // ATCancel, HKCancel, ORCancel
  glow: THREE.Object3D | null;
  color: THREE.Color;
}

// Camera settings
const INITIAL_CAM_POS = new THREE.Vector3(0, 50, 200);
const INITIAL_CAM_TARGET = new THREE.Vector3(0, 50, 650);

export class HouseSelect3D {
  private menuScene: MenuSceneManager;
  private textOverlay: MenuTextOverlay;
  private root: THREE.Group | null = null;

  private houses: HouseEntry[] = [];
  private selectedHouse: HouseEntry | null = null;
  private resolved = false;

  // Camera animation
  private camPosTarget = INITIAL_CAM_POS.clone();
  private camLookTarget = INITIAL_CAM_TARGET.clone();
  private camPosSmooth = INITIAL_CAM_POS.clone();
  private camLookSmooth = INITIAL_CAM_TARGET.clone();

  // Animation state
  private elapsed = 0;
  private stars: THREE.Object3D[] = [];
  private heighliners: THREE.Object3D[] = [];
  private rings: THREE.Object3D[] = [];

  constructor(canvas: HTMLCanvasElement, renderer: THREE.WebGLRenderer) {
    this.menuScene = new MenuSceneManager(canvas, renderer);
    this.textOverlay = new MenuTextOverlay();
  }

  async show(): Promise<string> {
    // Load the glTF scene
    this.root = await this.menuScene.loadScene('/assets/models/ui/HouseSelect.gltf');

    // Set up lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.menuScene.scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.4);
    dirLight.position.set(0, 100, -200);
    this.menuScene.scene.add(dirLight);

    // Position camera
    this.menuScene.camera.position.copy(INITIAL_CAM_POS);
    this.menuScene.camera.lookAt(INITIAL_CAM_TARGET);
    this.menuScene.camera.near = 1;
    this.menuScene.camera.far = 5000;
    this.menuScene.camera.updateProjectionMatrix();

    // Find and set up meshes
    this.setupHouses();
    this.setupGlowMaterials();
    this.setupStarsAndRings();
    this.setupHeighliners();

    // Hide logos initially (they start at scale 0 in the model, but ensure visibility)
    for (const h of this.houses) {
      h.logo.visible = false;
      h.accept.visible = false;
      h.cancel.visible = false;
    }

    // Set planets as click targets
    const planetBoxes = this.houses.map(h => h.planetBox);
    this.menuScene.setClickTargets(planetBoxes, (mesh) => this.onPlanetClick(mesh));
    this.menuScene.setHoverTargets(planetBoxes, (mesh) => this.onPlanetHover(mesh));

    // Set up animations
    this.menuScene.addAnimation((dt) => this.animate(dt));

    // Start rendering
    this.menuScene.startRenderLoop();

    // Wait for selection
    return new Promise<string>((resolve) => {
      this.resolveSelection = resolve;
    });
  }

  private resolveSelection: ((houseId: string) => void) | null = null;

  private setupHouses(): void {
    const root = this.root!;
    const find = (name: string) => this.menuScene.findMesh(root, name);

    // Cross-labeled mesh mapping from the original model:
    // #atbox contains HKplanet^ (but represents Atreides)
    // #hkbox contains ATplanet^ (but represents Harkonnen)
    // #orbox contains ORplanet^ (represents Ordos)
    const entries: { id: string; boxName: string; planetName: string; logoName: string; acceptName: string; cancelName: string; glowName: string; color: number }[] = [
      { id: 'atreides', boxName: '#atbox', planetName: 'HKplanet^', logoName: 'ATlogo', acceptName: 'ATAccept', cancelName: 'ATCancel', glowName: 'BlueGlow', color: 0x0085E2 },
      { id: 'harkonnen', boxName: '#hkbox', planetName: 'ATplanet^', logoName: 'HKlogo', acceptName: 'HKAccept', cancelName: 'HKCancel', glowName: 'RedGlow', color: 0xAF2416 },
      { id: 'ordos', boxName: '#orbox', planetName: 'ORplanet^', logoName: 'ORlogo', acceptName: 'ORAccept', cancelName: 'ORCancel', glowName: 'GreenGlow', color: 0x92FDCA },
    ];

    for (const e of entries) {
      const planetBox = find(e.boxName);
      const planet = find(e.planetName);
      const logo = find(e.logoName);
      const accept = find(e.acceptName);
      const cancel = find(e.cancelName);
      const glow = find(e.glowName);

      if (!planetBox || !planet || !logo || !accept || !cancel) {
        console.warn(`HouseSelect3D: Missing meshes for ${e.id}`);
        continue;
      }

      this.houses.push({
        id: e.id,
        planetBox,
        planet,
        logo,
        accept,
        cancel,
        glow,
        color: new THREE.Color(e.color),
      });
    }
  }

  private setupGlowMaterials(): void {
    if (!this.root) return;
    this.root.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const name = child.name.toLowerCase();
        if (name.includes('glow') || name.includes('nebula') || name.includes('flash') || name.includes('zipzap')) {
          const mat = child.material;
          if (mat instanceof THREE.MeshStandardMaterial || mat instanceof THREE.MeshBasicMaterial) {
            mat.blending = THREE.AdditiveBlending;
            mat.depthWrite = false;
            mat.transparent = true;
          } else if (Array.isArray(mat)) {
            for (const m of mat) {
              m.blending = THREE.AdditiveBlending;
              m.depthWrite = false;
              m.transparent = true;
            }
          }
        }
      }
    });
  }

  private setupStarsAndRings(): void {
    if (!this.root) return;
    this.stars = this.menuScene.findMeshesByPattern(this.root, /^#star\d+$/);
    // Clone materials so each star can have independent opacity for twinkle
    for (const star of this.stars) {
      if (star instanceof THREE.Mesh && star.material && !Array.isArray(star.material)) {
        star.material = star.material.clone();
      }
    }
    this.rings = this.menuScene.findMeshesByPattern(this.root, /ring/i);
  }

  private setupHeighliners(): void {
    if (!this.root) return;
    this.heighliners = this.menuScene.findMeshesByPattern(this.root, /^hliner\d+\^$/);
  }

  private animate(dt: number): void {
    this.elapsed += dt;

    // Smooth camera interpolation
    this.camPosSmooth.lerp(this.camPosTarget, 3 * dt);
    this.camLookSmooth.lerp(this.camLookTarget, 3 * dt);
    this.menuScene.camera.position.copy(this.camPosSmooth);
    this.menuScene.camera.lookAt(this.camLookSmooth);

    // Rotate planets
    for (const h of this.houses) {
      h.planet.rotation.y += 0.15 * dt;
    }

    // Star twinkle
    for (let i = 0; i < this.stars.length; i++) {
      const star = this.stars[i];
      if (star instanceof THREE.Mesh) {
        const mat = star.material as THREE.MeshStandardMaterial;
        if (mat.opacity !== undefined) {
          mat.transparent = true;
          mat.opacity = 0.5 + 0.5 * Math.sin(this.elapsed * 2 + i * 1.7);
        }
      }
    }

    // Ring rotation
    for (let i = 0; i < this.rings.length; i++) {
      const ring = this.rings[i];
      ring.rotation.y += (0.05 + i * 0.02) * dt;
    }

    // Heighliner drift
    for (const hliner of this.heighliners) {
      hliner.rotation.y += 0.02 * dt;
    }

    // Glow pulse
    for (const h of this.houses) {
      if (h.glow && h.glow instanceof THREE.Mesh) {
        const scale = 1.0 + 0.05 * Math.sin(this.elapsed * 1.5);
        h.glow.scale.setScalar(scale);
      }
    }

    // Update text overlay positions
    this.textOverlay.updatePositions(this.menuScene.camera);
  }

  private onPlanetHover(mesh: THREE.Object3D | null): void {
    if (this.selectedHouse) return; // Already zoomed in
    document.body.style.cursor = mesh ? 'pointer' : 'default';
  }

  private onPlanetClick(mesh: THREE.Object3D): void {
    if (this.selectedHouse) return;

    const house = this.houses.find(h => h.planetBox === mesh);
    if (!house) return;

    this.selectedHouse = house;
    document.body.style.cursor = 'default';

    // Compute planet world position for camera zoom target
    const planetWorldPos = new THREE.Vector3();
    house.planetBox.getWorldPosition(planetWorldPos);

    // Camera zoom toward planet
    const dir = planetWorldPos.clone().sub(this.camPosSmooth).normalize();
    this.camPosTarget.copy(planetWorldPos).sub(dir.multiplyScalar(120));
    this.camLookTarget.copy(planetWorldPos);

    // Show logo and accept/cancel after a short delay
    setTimeout(() => {
      house.logo.visible = true;
      house.logo.scale.setScalar(1);
      house.accept.visible = true;
      house.cancel.visible = true;

      // Clear planet click targets and set accept/cancel as new targets
      this.menuScene.setClickTargets([house.accept, house.cancel], (btn) => {
        this.onButtonClick(btn, house);
      });
      this.menuScene.setHoverTargets([house.accept, house.cancel], (btn) => {
        document.body.style.cursor = btn ? 'pointer' : 'default';
      });
    }, 800);
  }

  private onButtonClick(mesh: THREE.Object3D, house: HouseEntry): void {
    if (this.resolved) return;

    if (mesh === house.accept) {
      this.resolved = true;
      document.body.style.cursor = 'default';
      this.menuScene.setClickTargets([], () => {});
      this.menuScene.setHoverTargets([], () => {});

      // Fade out then resolve
      this.menuScene.fadeOut(500).then(() => {
        this.dispose();
        if (this.resolveSelection) {
          this.resolveSelection(house.id);
        }
      });
    } else if (mesh === house.cancel) {
      // Return to overview
      this.selectedHouse = null;
      house.logo.visible = false;
      house.accept.visible = false;
      house.cancel.visible = false;

      // Reset camera
      this.camPosTarget.copy(INITIAL_CAM_POS);
      this.camLookTarget.copy(INITIAL_CAM_TARGET);

      // Restore planet click targets
      const planetBoxes = this.houses.map(h => h.planetBox);
      this.menuScene.setClickTargets(planetBoxes, (m) => this.onPlanetClick(m));
      this.menuScene.setHoverTargets(planetBoxes, (m) => this.onPlanetHover(m));
    }
  }

  dispose(): void {
    this.menuScene.dispose();
    this.textOverlay.dispose();
    document.body.style.cursor = 'default';
  }
}
