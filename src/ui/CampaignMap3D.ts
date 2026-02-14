import * as THREE from 'three';
import { MenuSceneManager } from './MenuSceneManager';
import { MenuTextOverlay } from './MenuTextOverlay';
import type { Territory, CampaignState } from './CampaignMap';

// Map game territory IDs (0-8) to glTF face mesh names
const TERRITORY_MESH_MAP: Record<number, string> = {
  0: 'F03',  // Carthag Basin
  1: 'F07',  // Habbanya Ridge
  2: 'F12',  // Wind Pass
  3: 'F15',  // Arrakeen Flats
  4: 'F17',  // Sietch Tabr
  5: 'F22',  // Shield Wall
  6: 'F25',  // Spice Fields
  7: 'F28',  // Old Gap
  8: 'F33',  // Enemy Capital
};

const MAPPED_FACE_NAMES = new Set(Object.values(TERRITORY_MESH_MAP));

// Camera for viewing the campaign map — territory faces centered at (106.5, 48.7, 544.9)
const CAM_POS = new THREE.Vector3(106, 49, 100);
const CAM_TARGET = new THREE.Vector3(106, 49, 545);

export class CampaignMap3D {
  private menuScene: MenuSceneManager;
  private textOverlay: MenuTextOverlay;
  private root: THREE.Group | null = null;
  private resolveSelection: ((territoryId: number | null) => void) | null = null;

  private territoryMeshes = new Map<number, {
    face: THREE.Object3D;
    edge: THREE.Object3D | null;
    select: THREE.Object3D | null;
  }>();

  private attackButton: THREE.Object3D | null = null;
  private exitButton: THREE.Object3D | null = null;
  private hoveredTerritoryId: number | null = null;
  private selectedTerritoryId: number | null = null;
  private planet: THREE.Object3D | null = null;
  private elapsed = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private renderer: THREE.WebGLRenderer,
    private state: CampaignState,
  ) {
    this.menuScene = new MenuSceneManager(canvas, renderer);
    this.textOverlay = new MenuTextOverlay();
  }

  async show(): Promise<number | null> {
    this.root = await this.menuScene.loadScene('/assets/models/ui/CAMPAIGN.gltf');

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    this.menuScene.scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.5);
    dirLight.position.set(0, 200, -100);
    this.menuScene.scene.add(dirLight);

    // Camera
    this.menuScene.camera.position.copy(CAM_POS);
    this.menuScene.camera.lookAt(CAM_TARGET);
    this.menuScene.camera.near = 1;
    this.menuScene.camera.far = 5000;
    this.menuScene.camera.updateProjectionMatrix();

    this.setupTerritories();
    this.setupButtons();
    this.setupPlanet();
    this.setupGlowMaterials();
    this.colorTerritories();

    // Initially hide select overlays and Attack button
    for (const tm of this.territoryMeshes.values()) {
      if (tm.select) tm.select.visible = false;
    }
    if (this.attackButton) {
      this.attackButton.visible = false;
      this.attackButton.scale.setScalar(1);
    }

    // Set up click/hover on attackable territories
    this.updateInteractionTargets();

    // Animation loop
    this.menuScene.addAnimation((dt) => this.animate(dt));
    this.menuScene.startRenderLoop();

    return new Promise((resolve) => {
      this.resolveSelection = resolve;
    });
  }

  private setupTerritories(): void {
    const root = this.root!;

    for (const [gameId, meshName] of Object.entries(TERRITORY_MESH_MAP)) {
      const id = parseInt(gameId);
      const face = this.menuScene.findMesh(root, meshName);
      const edge = this.menuScene.findMesh(root, meshName.replace('F', 'E'));
      const select = this.menuScene.findMesh(root, `${meshName}select`);

      if (face) {
        this.territoryMeshes.set(id, { face, edge, select });
      }
    }

    // Make unmapped territory faces neutral gray
    root.traverse((child) => {
      if (child instanceof THREE.Mesh && child.name.match(/^F\d+$/) && !MAPPED_FACE_NAMES.has(child.name)) {
        const mat = child.material;
        if (mat instanceof THREE.MeshStandardMaterial) {
          mat.color.setHex(0x444444);
          mat.emissive.setHex(0x111111);
        }
      }
    });
  }

  private setupButtons(): void {
    const root = this.root!;
    this.attackButton = this.menuScene.findMesh(root, 'Attack');
    this.exitButton = this.menuScene.findMesh(root, 'Exit');

    // Show exit button
    if (this.exitButton) {
      this.exitButton.visible = true;
      this.exitButton.scale.setScalar(1);
    }
  }

  private setupPlanet(): void {
    const root = this.root!;
    this.planet = this.menuScene.findMesh(root, '^planet');
  }

  private setupGlowMaterials(): void {
    if (!this.root) return;
    this.root.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const name = child.name.toLowerCase();

        // Hide container meshes
        if (name.startsWith('~~')) {
          child.visible = false;
          return;
        }

        // Glow/effect materials: additive blending
        if (name.includes('glow') || name.includes('nebula') || name.includes('flash') || name.includes('zipzap') || name.includes('jump') || name.includes('boom') || name.includes('bang')) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          for (const m of mats) {
            if (m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshBasicMaterial) {
              m.blending = THREE.AdditiveBlending;
              m.depthWrite = false;
              m.transparent = true;
            }
          }
        }

        // Double-sided rendering
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) {
          if (m && 'side' in m) {
            m.side = THREE.DoubleSide;
          }
        }
      }
    });
  }

  private colorTerritories(): void {
    for (const territory of this.state.territories) {
      const tm = this.territoryMeshes.get(territory.id);
      if (!tm) continue;

      const setColor = (obj: THREE.Object3D, color: number, emissive: number) => {
        obj.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            const mat = child.material;
            if (mat instanceof THREE.MeshStandardMaterial) {
              mat.color.setHex(color);
              mat.emissive.setHex(emissive);
              mat.emissiveIntensity = 0.5;
            }
          }
        });
      };

      if (territory.owner === 'player') {
        setColor(tm.face, 0x2244aa, 0x0033aa);
        if (tm.edge) setColor(tm.edge, 0x3366cc, 0x0044cc);
      } else if (territory.owner === 'enemy') {
        setColor(tm.face, 0xaa2222, 0xaa1111);
        if (tm.edge) setColor(tm.edge, 0xcc3333, 0xcc1111);
      } else {
        setColor(tm.face, 0x666666, 0x222222);
        if (tm.edge) setColor(tm.edge, 0x888888, 0x333333);
      }
    }
  }

  private getAttackableTerritoryIds(): number[] {
    return this.state.territories
      .filter(t => t.owner !== 'player' && t.adjacent.some(
        adjId => this.state.territories.find(a => a.id === adjId)?.owner === 'player'
      ))
      .map(t => t.id);
  }

  private updateInteractionTargets(): void {
    const attackableIds = this.getAttackableTerritoryIds();
    const clickableFaces: THREE.Object3D[] = [];

    for (const id of attackableIds) {
      const tm = this.territoryMeshes.get(id);
      if (tm) clickableFaces.push(tm.face);
    }

    // Add exit button as click target
    if (this.exitButton) clickableFaces.push(this.exitButton);

    this.menuScene.setClickTargets(clickableFaces, (mesh) => this.onMeshClick(mesh));
    this.menuScene.setHoverTargets(clickableFaces, (mesh) => this.onMeshHover(mesh));
  }

  private onMeshHover(mesh: THREE.Object3D | null): void {
    // Clear previous hover highlight
    if (this.hoveredTerritoryId !== null) {
      const prev = this.territoryMeshes.get(this.hoveredTerritoryId);
      if (prev?.select) prev.select.visible = false;
    }

    if (!mesh) {
      this.hoveredTerritoryId = null;
      document.body.style.cursor = 'default';
      // Remove territory label
      this.textOverlay.removeLabel('territory-hover');
      return;
    }

    // Check if it's exit or attack button
    if (mesh === this.exitButton || mesh === this.attackButton) {
      document.body.style.cursor = 'pointer';
      this.hoveredTerritoryId = null;
      return;
    }

    // Find which territory was hovered
    for (const [id, tm] of this.territoryMeshes.entries()) {
      if (tm.face === mesh) {
        this.hoveredTerritoryId = id;
        if (tm.select) tm.select.visible = true;
        document.body.style.cursor = 'pointer';

        // Show territory name label
        const territory = this.state.territories.find(t => t.id === id);
        if (territory) {
          const worldPos = new THREE.Vector3();
          tm.face.getWorldPosition(worldPos);
          this.textOverlay.removeLabel('territory-hover');
          this.textOverlay.addLabel('territory-hover', `${territory.name} [${territory.difficulty.toUpperCase()}]`, worldPos, {
            fontSize: '16px',
            color: '#ffcc44',
            fontWeight: 'bold',
          });
        }
        return;
      }
    }
  }

  private onMeshClick(mesh: THREE.Object3D): void {
    // Exit button - resolve before dispose to avoid use-after-dispose
    if (mesh === this.exitButton) {
      const resolve = this.resolveSelection;
      this.resolveSelection = null;
      this.dispose();
      resolve?.(null);
      return;
    }

    // Territory selection
    for (const [id, tm] of this.territoryMeshes.entries()) {
      if (tm.face === mesh) {
        this.selectedTerritoryId = id;

        // Show attack button
        if (this.attackButton) {
          this.attackButton.visible = true;
          this.attackButton.scale.setScalar(1);

          // Set attack button as additional click target
          const attackableIds = this.getAttackableTerritoryIds();
          const clickableFaces: THREE.Object3D[] = [];
          for (const aid of attackableIds) {
            const atm = this.territoryMeshes.get(aid);
            if (atm) clickableFaces.push(atm.face);
          }
          clickableFaces.push(this.attackButton);
          if (this.exitButton) clickableFaces.push(this.exitButton);

          this.menuScene.setClickTargets(clickableFaces, (m) => {
            if (m === this.attackButton) {
              this.onAttackConfirm();
            } else if (m === this.exitButton) {
              this.dispose();
              this.resolveSelection?.(null);
            } else {
              this.onMeshClick(m);
            }
          });
          this.menuScene.setHoverTargets(clickableFaces, (m) => this.onMeshHover(m));
        }
        return;
      }
    }
  }

  private onAttackConfirm(): void {
    if (this.selectedTerritoryId === null) return;
    const id = this.selectedTerritoryId;
    this.menuScene.fadeOut(500).then(() => {
      this.dispose();
      this.resolveSelection?.(id);
    });
  }

  private animate(dt: number): void {
    this.elapsed += dt;

    // Rotate planet
    if (this.planet) {
      this.planet.rotation.y += 0.1 * dt;
    }

    // Pulse hovered territory
    if (this.hoveredTerritoryId !== null) {
      const tm = this.territoryMeshes.get(this.hoveredTerritoryId);
      if (tm?.select && tm.select instanceof THREE.Mesh) {
        const mat = tm.select.material as THREE.MeshStandardMaterial;
        if (mat.emissive) {
          const pulse = 0.3 + 0.3 * Math.sin(this.elapsed * 4);
          mat.emissiveIntensity = pulse;
        }
      }
    }

    // Update text overlay
    this.textOverlay.updatePositions(this.menuScene.camera);
  }

  dispose(): void {
    this.menuScene.dispose();
    this.textOverlay.dispose();
    document.body.style.cursor = 'default';
  }
}
