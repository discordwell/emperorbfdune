import * as THREE from 'three';
import { MenuSceneManager } from './MenuSceneManager';
import { MenuTextOverlay } from './MenuTextOverlay';

interface HouseEntry {
  id: string;
  name: string;
  planetBox: THREE.Object3D;  // #atbox, #orbox, #hkbox
  planet: THREE.Object3D;     // HKplanet^, ORplanet^, ATplanet^
  sphere: THREE.Mesh;         // Replacement sphere (child of planetBox)
  logo: THREE.Object3D;       // ATlogo, HKlogo, ORlogo
  accept: THREE.Object3D;     // ATAccept, HKAccept, ORAccept
  cancel: THREE.Object3D;     // ATCancel, HKCancel, ORCancel
  glow: THREE.Object3D | null;
  color: THREE.Color;
}

// Camera settings — planet boxes are at z≈630, spread x=-210..212, y=-125..174
// Camera needs to be far enough back to frame all three in the FOV
const INITIAL_CAM_POS = new THREE.Vector3(0, 15, 100);
const INITIAL_CAM_TARGET = new THREE.Vector3(0, 15, 632);

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
  private static _tempScale = new THREE.Vector3();

  // DOM buttons for accept/cancel (replaces broken glTF mesh buttons)
  private buttonOverlay: HTMLDivElement | null = null;
  private buttonTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(canvas: HTMLCanvasElement, renderer: THREE.WebGLRenderer) {
    this.menuScene = new MenuSceneManager(canvas, renderer);
    this.textOverlay = new MenuTextOverlay();
  }

  async show(): Promise<string> {
    // Load the glTF scene
    this.root = await this.menuScene.loadScene('/assets/models/ui/HouseSelect.gltf');

    // Set up lighting
    const ambient = new THREE.AmbientLight(0xffffff, 1.5);
    this.menuScene.scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(0, 100, -200);
    this.menuScene.scene.add(dirLight);

    // Position camera
    this.menuScene.camera.position.copy(INITIAL_CAM_POS);
    this.menuScene.camera.lookAt(INITIAL_CAM_TARGET);
    this.menuScene.camera.near = 1;
    this.menuScene.camera.far = 5000;
    this.menuScene.camera.updateProjectionMatrix();

    // Find and set up meshes (must happen before sphere creation)
    this.setupHouses();
    this.setupMaterials();
    this.setupReplacementSpheres();
    this.setupStarsAndRings();
    this.setupHeighliners();

    // Hide glTF logos/buttons (we use DOM overlays instead)
    for (const h of this.houses) {
      h.logo.visible = false;
      h.accept.visible = false;
      h.cancel.visible = false;
    }

    // Set replacement spheres as click targets (spheres are in scene root, not planetBox children)
    const spheres = this.houses.map(h => h.sphere);
    this.menuScene.setClickTargets(spheres, (mesh) => this.onPlanetClick(mesh));
    this.menuScene.setHoverTargets(spheres, (mesh) => this.onPlanetHover(mesh));

    // Add house name labels under planets
    for (const h of this.houses) {
      const wp = h.sphere.position.clone();
      // Offset label below the planet
      const radius = h.id === 'atreides' ? 43 : h.id === 'ordos' ? 36 : 34;
      wp.y -= radius + 15;
      this.textOverlay.addLabel(`house-${h.id}`, h.name, wp, {
        fontSize: '18px',
        color: '#' + h.color.getHexString(),
        fontWeight: 'bold',
        textShadow: '0 0 8px #000, 0 0 16px #000',
      });
    }

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
    const entries: { id: string; name: string; boxName: string; planetName: string; logoName: string; acceptName: string; cancelName: string; glowName: string; color: number }[] = [
      { id: 'atreides', name: 'House Atreides', boxName: '#atbox', planetName: 'HKplanet^', logoName: 'ATlogo', acceptName: 'ATAccept', cancelName: 'ATCancel', glowName: 'BlueGlow', color: 0x0085E2 },
      { id: 'harkonnen', name: 'House Harkonnen', boxName: '#hkbox', planetName: 'ATplanet^', logoName: 'HKlogo', acceptName: 'HKAccept', cancelName: 'HKCancel', glowName: 'RedGlow', color: 0xAF2416 },
      { id: 'ordos', name: 'House Ordos', boxName: '#orbox', planetName: 'ORplanet^', logoName: 'ORlogo', acceptName: 'ORAccept', cancelName: 'ORCancel', glowName: 'GreenGlow', color: 0x92FDCA },
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
        name: e.name,
        planetBox,
        planet,
        sphere: null as unknown as THREE.Mesh, // Set in setupReplacementSpheres
        logo,
        accept,
        cancel,
        glow,
        color: new THREE.Color(e.color),
      });
    }
  }

  private setupReplacementSpheres(): void {
    // Replace glTF planet meshes with proper Three.js spheres using the original textures
    // (The XBF-converted geometry has issues with normals/winding)
    // Add to scene root at world position (adding to planetBox hierarchy causes rendering issues)
    this.menuScene.scene.updateMatrixWorld(true);

    // The planet meshes are cross-labeled in the original XBF:
    //   #atbox contains HKplanet^ (Geidi Prime texture), but represents Atreides (Caladan)
    //   #hkbox contains ATplanet^ (Caladan texture), but represents Harkonnen (Geidi Prime)
    // Build a texture lookup from all planet meshes so we can assign the correct texture
    const textureByPrefix = new Map<string, THREE.Texture | null>();
    for (const h of this.houses) {
      if (h.planet instanceof THREE.Mesh) {
        const mat = h.planet.material as THREE.MeshStandardMaterial;
        // Extract prefix from planet name: ATplanet^ → AT, HKplanet^ → HK, ORplanet^ → OR
        const prefix = h.planet.name.replace(/planet.*/, '');
        textureByPrefix.set(prefix, mat.map);
      }
    }

    // Map house IDs to the correct texture prefix
    const houseTexturePrefix: Record<string, string> = {
      atreides: 'AT',   // Caladan texture
      harkonnen: 'HK',  // Geidi Prime texture
      ordos: 'OR',       // Ordos texture
    };

    for (const h of this.houses) {
      const planet = h.planet;
      if (!(planet instanceof THREE.Mesh)) continue;

      const wp = new THREE.Vector3();
      planet.getWorldPosition(wp);

      // Use the correct texture for this house (not the cross-labeled one in the box)
      const correctPrefix = houseTexturePrefix[h.id] ?? 'OR';
      const correctTexture = textureByPrefix.get(correctPrefix) ?? null;

      const radius = h.id === 'atreides' ? 43 : h.id === 'ordos' ? 36 : 34;
      const sphereGeo = new THREE.SphereGeometry(radius, 32, 32);
      const sphereMat = new THREE.MeshStandardMaterial({
        map: correctTexture,
        roughness: 0.8,
        metalness: 0.0,
        side: THREE.FrontSide,
      });
      const sphere = new THREE.Mesh(sphereGeo, sphereMat);
      sphere.name = h.id + '_sphere';
      sphere.position.copy(wp);
      this.menuScene.scene.add(sphere);

      // Hide the original broken mesh
      planet.visible = false;

      h.sphere = sphere;
    }
  }

  private setupMaterials(): void {
    if (!this.root) return;
    this.root.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const name = child.name.toLowerCase();

        // Hide decorative boxes and screen-space frame elements
        if (name.startsWith('~~') || name.startsWith('box') ||
            name.startsWith('back') || name.startsWith('logoline') || name === '#title') {
          child.visible = false;
          return;
        }

        // Objects# is parent of planet boxes — hide only its own mesh, not children
        if (name === 'objects#') {
          child.material = new THREE.MeshBasicMaterial({ visible: false });
          return;
        }

        // Glow/nebula/flash/ring/zip/star effects: additive blending
        if (name.includes('glow') || name.includes('nebula') || name.includes('flash') ||
            name.includes('zipzap') || name.includes('engine') || name.includes('light') ||
            name.includes('ring') || name.includes('zip') || name.includes('galaxy')) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          for (const m of mats) {
            if (m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshBasicMaterial) {
              m.blending = THREE.AdditiveBlending;
              m.depthWrite = false;
              m.transparent = true;
            }
          }
        }

        // Make all materials double-sided (original game didn't cull backfaces)
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) {
          if (m && 'side' in m) {
            m.side = THREE.DoubleSide;
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

    // Rotate replacement spheres
    for (const h of this.houses) {
      if (h.sphere) h.sphere.rotation.y += 0.15 * dt;
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

    // Scale up hovered planet, reset others
    for (const h of this.houses) {
      const isHovered = h.sphere === mesh;
      const targetScale = isHovered ? 1.08 : 1.0;
      HouseSelect3D._tempScale.set(targetScale, targetScale, targetScale);
      h.sphere.scale.lerp(HouseSelect3D._tempScale, 0.2);
    }

    document.body.style.cursor = mesh ? 'pointer' : 'default';
  }

  private onPlanetClick(mesh: THREE.Object3D): void {
    if (this.selectedHouse) return;

    const house = this.houses.find(h => h.sphere === mesh);
    if (!house) return;

    this.selectedHouse = house;
    document.body.style.cursor = 'default';

    // Clear planet click/hover targets during zoom
    this.menuScene.setClickTargets([], () => {});
    this.menuScene.setHoverTargets([], () => {});

    // Camera zoom toward planet sphere
    const spherePos = house.sphere.position.clone();
    const dir = spherePos.clone().sub(this.camPosSmooth).normalize();
    this.camPosTarget.copy(spherePos).sub(dir.multiplyScalar(120));
    this.camLookTarget.copy(spherePos);

    // Show DOM accept/cancel buttons after camera zooms in
    this.buttonTimeout = setTimeout(() => {
      this.buttonTimeout = null;
      this.showDOMButtons(house);
    }, 1000);
  }

  private showDOMButtons(house: HouseEntry): void {
    this.removeDOMButtons();

    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed; bottom:80px; left:0; right:0;
      display:flex; justify-content:center; gap:40px;
      z-index:2002; pointer-events:auto;
    `;

    const makeBtn = (text: string, color: string, hoverColor: string) => {
      const btn = document.createElement('button');
      btn.textContent = text;
      btn.style.cssText = `
        padding:12px 40px; font-size:20px; font-weight:bold;
        font-family:'Segoe UI',Tahoma,sans-serif; letter-spacing:2px;
        border:2px solid ${color}; color:${color}; background:rgba(0,0,0,0.7);
        cursor:pointer; text-transform:uppercase;
        transition:all 0.2s ease;
      `;
      btn.addEventListener('mouseenter', () => {
        btn.style.background = hoverColor;
        btn.style.color = '#fff';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = 'rgba(0,0,0,0.7)';
        btn.style.color = color;
      });
      return btn;
    };

    const acceptBtn = makeBtn('Accept', '#' + house.color.getHexString(), 'rgba(' +
      Math.round(house.color.r * 255) + ',' +
      Math.round(house.color.g * 255) + ',' +
      Math.round(house.color.b * 255) + ',0.5)');
    const cancelBtn = makeBtn('Cancel', '#888888', 'rgba(80,80,80,0.5)');

    acceptBtn.addEventListener('click', () => this.onAccept(house));
    cancelBtn.addEventListener('click', () => this.onCancel(house));

    overlay.appendChild(acceptBtn);
    overlay.appendChild(cancelBtn);
    document.body.appendChild(overlay);
    this.buttonOverlay = overlay;
  }

  private removeDOMButtons(): void {
    if (this.buttonOverlay) {
      this.buttonOverlay.remove();
      this.buttonOverlay = null;
    }
  }

  private onAccept(house: HouseEntry): void {
    if (this.resolved) return;
    this.resolved = true;
    this.removeDOMButtons();
    document.body.style.cursor = 'default';

    this.menuScene.fadeOut(500).then(() => {
      this.dispose();
      if (this.resolveSelection) {
        this.resolveSelection(house.id);
      }
    });
  }

  private onCancel(_house: HouseEntry): void {
    if (this.resolved) return;
    this.removeDOMButtons();
    this.selectedHouse = null;

    // Reset camera
    this.camPosTarget.copy(INITIAL_CAM_POS);
    this.camLookTarget.copy(INITIAL_CAM_TARGET);

    // Restore planet click targets
    const spheres = this.houses.map(h => h.sphere);
    this.menuScene.setClickTargets(spheres, (m) => this.onPlanetClick(m));
    this.menuScene.setHoverTargets(spheres, (m) => this.onPlanetHover(m));
  }

  dispose(): void {
    if (this.buttonTimeout) {
      clearTimeout(this.buttonTimeout);
      this.buttonTimeout = null;
    }
    this.removeDOMButtons();
    this.menuScene.dispose();
    this.textOverlay.dispose();
    document.body.style.cursor = 'default';
  }
}
