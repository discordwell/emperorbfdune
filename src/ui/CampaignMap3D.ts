import * as THREE from 'three';
import { MenuSceneManager } from './MenuSceneManager';
import { MenuTextOverlay } from './MenuTextOverlay';
import type { Territory, CampaignState } from './CampaignMap';
import { JUMP_POINTS, type HousePrefix } from '../campaign/CampaignData';

/**
 * Map territory ID N to mesh name F{N.toString().padStart(2,'0')}.
 * All 33 Arrakis territories (1-33) are present in CAMPAIGN.gltf.
 * Homeworlds (34-36) may or may not have meshes.
 */
function territoryToMeshName(id: number): string {
  return `F${id.toString().padStart(2, '0')}`;
}

// Camera for viewing the campaign map — territory faces centered at (106.5, 48.7, 544.9)
const CAM_POS = new THREE.Vector3(106, 49, 100);
const CAM_TARGET = new THREE.Vector3(106, 49, 545);

// House colors for 3D rendering
const HOUSE_FACE_COLORS: Record<string, { color: number; emissive: number }> = {
  player:  { color: 0x2244aa, emissive: 0x0033aa },
  enemy:   { color: 0xaa2222, emissive: 0xaa1111 },
  enemy2:  { color: 0x22aa44, emissive: 0x11aa33 },
  neutral: { color: 0x666666, emissive: 0x222222 },
};

const HOUSE_EDGE_COLORS: Record<string, { color: number; emissive: number }> = {
  player:  { color: 0x3366cc, emissive: 0x0044cc },
  enemy:   { color: 0xcc3333, emissive: 0xcc1111 },
  enemy2:  { color: 0x33cc55, emissive: 0x11cc33 },
  neutral: { color: 0x888888, emissive: 0x333333 },
};

interface TerritoryEntry {
  id: number;
  face: THREE.Object3D;
  edge: THREE.Object3D | null;
  select: THREE.Object3D | null;
  proxy: THREE.Mesh; // invisible raycast proxy
}

export class CampaignMap3D {
  private menuScene: MenuSceneManager;
  private textOverlay: MenuTextOverlay;
  private root: THREE.Group | null = null;
  private resolveSelection: ((territoryId: number | null) => void) | null = null;
  private resolved = false;

  private territories: TerritoryEntry[] = [];

  private hoveredTerritoryId: number | null = null;
  private selectedTerritoryId: number | null = null;
  private planet: THREE.Object3D | null = null;
  private elapsed = 0;

  // DOM buttons
  private buttonOverlay: HTMLDivElement | null = null;

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
    this.setupPlanet();
    this.setupGlowMaterials();
    this.colorTerritories();

    // Initially hide select overlays
    for (const t of this.territories) {
      if (t.select) t.select.visible = false;
    }

    // Set up click/hover on attackable territories using proxy meshes
    this.updateInteractionTargets();

    // Show Exit button as DOM overlay
    this.showExitButton();

    // Info overlay with phase/act info
    this.showInfoOverlay();

    // Animation loop
    this.menuScene.addAnimation((dt) => this.animate(dt));
    this.menuScene.startRenderLoop();

    return new Promise((resolve) => {
      this.resolveSelection = resolve;
    });
  }

  private setupTerritories(): void {
    const root = this.root!;
    root.updateMatrixWorld(true);

    // Determine which territory IDs to show
    const phase = this.state.phaseState?.currentPhase ?? 1;
    const maxId = phase >= 3 ? 36 : 33; // Show homeworlds in Phase 3+

    // Build set of all mesh names we'll map
    const mappedFaces = new Set<string>();

    for (let id = 1; id <= maxId; id++) {
      const meshName = territoryToMeshName(id);
      const face = this.menuScene.findMesh(root, meshName);
      if (!face || !(face instanceof THREE.Mesh)) continue;

      mappedFaces.add(meshName);

      const edge = this.menuScene.findMesh(root, meshName.replace('F', 'E'));
      const select = this.menuScene.findMesh(root, `${meshName}select`);

      // Create invisible proxy plane from the face's bounding box
      const geo = face.geometry;
      geo.computeBoundingBox();
      const bb = geo.boundingBox!;
      const w = bb.max.x - bb.min.x;
      const h = bb.max.y - bb.min.y;
      const cx = (bb.min.x + bb.max.x) / 2;
      const cy = (bb.min.y + bb.max.y) / 2;
      const cz = (bb.min.z + bb.max.z) / 2;

      // Compute world position of geometry center
      const m = face.matrixWorld.elements;
      const wx = cx * m[0] + cy * m[4] + cz * m[8] + m[12];
      const wy = cx * m[1] + cy * m[5] + cz * m[9] + m[13];
      const wz = cx * m[2] + cy * m[6] + cz * m[10] + m[14];

      const proxyGeo = new THREE.PlaneGeometry(w, h);
      const proxyMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
      const proxy = new THREE.Mesh(proxyGeo, proxyMat);
      proxy.name = `proxy_${meshName}`;
      proxy.position.set(wx, wy, wz);
      this.menuScene.scene.add(proxy);

      this.territories.push({ id, face, edge, select, proxy });
    }

    // Make unmapped territory faces neutral gray
    root.traverse((child) => {
      if (child instanceof THREE.Mesh && child.name.match(/^F\d+$/) && !mappedFaces.has(child.name)) {
        const mat = child.material;
        if (mat instanceof THREE.MeshStandardMaterial) {
          mat.color.setHex(0x444444);
          mat.emissive.setHex(0x111111);
        }
      }
    });
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

        if (name.startsWith('~~')) {
          child.visible = false;
          return;
        }

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
      const entry = this.territories.find(t => t.id === territory.id);
      if (!entry) continue;

      const ownerKey = territory.owner; // 'player' | 'enemy' | 'enemy2' | 'neutral'
      const faceColors = HOUSE_FACE_COLORS[ownerKey] ?? HOUSE_FACE_COLORS.neutral;
      const edgeColors = HOUSE_EDGE_COLORS[ownerKey] ?? HOUSE_EDGE_COLORS.neutral;

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

      setColor(entry.face, faceColors.color, faceColors.emissive);
      if (entry.edge) setColor(entry.edge, edgeColors.color, edgeColors.emissive);

      // Jump point overlay: make it brighter in Phase 3+
      const phase = this.state.phaseState?.currentPhase ?? 1;
      if (phase >= 3) {
        const isJumpPoint = Object.values(JUMP_POINTS).includes(territory.id) &&
          territory.id !== JUMP_POINTS[this.state.housePrefix];
        if (isJumpPoint && territory.owner !== 'player') {
          // Highlight with gold tint
          setColor(entry.face, 0xaa8833, 0x886622);
          if (entry.edge) setColor(entry.edge, 0xccaa44, 0xaa8833);
        }
      }
    }
  }

  private getAttackableTerritoryIds(): number[] {
    return this.state.territories
      .filter(t => t.owner !== 'player' && !t.isHomeworld &&
        t.adjacent.some(adjId =>
          this.state.territories.find(a => a.id === adjId)?.owner === 'player'
        ))
      .map(t => t.id);
  }

  private updateInteractionTargets(): void {
    const attackableIds = this.getAttackableTerritoryIds();
    const clickableProxies: THREE.Object3D[] = [];

    for (const id of attackableIds) {
      const entry = this.territories.find(t => t.id === id);
      if (entry) clickableProxies.push(entry.proxy);
    }

    this.menuScene.setClickTargets(clickableProxies, (mesh) => this.onProxyClick(mesh));
    this.menuScene.setHoverTargets(clickableProxies, (mesh) => this.onProxyHover(mesh));
  }

  private findTerritoryByProxy(proxy: THREE.Object3D): TerritoryEntry | undefined {
    return this.territories.find(t => t.proxy === proxy);
  }

  private onProxyHover(mesh: THREE.Object3D | null): void {
    // Clear previous hover highlight
    if (this.hoveredTerritoryId !== null) {
      const prev = this.territories.find(t => t.id === this.hoveredTerritoryId);
      if (prev?.select) prev.select.visible = false;
    }

    if (!mesh) {
      this.hoveredTerritoryId = null;
      document.body.style.cursor = 'default';
      this.textOverlay.removeLabel('territory-hover');
      return;
    }

    const entry = this.findTerritoryByProxy(mesh);
    if (!entry) {
      document.body.style.cursor = 'default';
      return;
    }

    this.hoveredTerritoryId = entry.id;
    if (entry.select) entry.select.visible = true;
    document.body.style.cursor = 'pointer';

    const territory = this.state.territories.find(t => t.id === entry.id);
    if (territory) {
      this.textOverlay.removeLabel('territory-hover');
      const ownerLabel = territory.ownerHouse !== 'neutral' ? ` (${territory.ownerHouse})` : '';
      this.textOverlay.addLabel('territory-hover', `${territory.name}${ownerLabel} [${territory.difficulty.toUpperCase()}]`, entry.proxy.position, {
        fontSize: '16px',
        color: '#ffcc44',
        fontWeight: 'bold',
      });
    }
  }

  private onProxyClick(mesh: THREE.Object3D): void {
    if (this.resolved) return;

    const entry = this.findTerritoryByProxy(mesh);
    if (!entry) return;

    this.selectedTerritoryId = entry.id;
    const territory = this.state.territories.find(t => t.id === entry.id);

    this.showAttackButtons(territory?.name ?? 'Territory');
  }

  private showExitButton(): void {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed; top:20px; left:20px;
      z-index:2002; pointer-events:auto;
    `;
    const exitBtn = document.createElement('button');
    exitBtn.textContent = 'EXIT';
    exitBtn.style.cssText = `
      padding:10px 24px; font-size:14px; font-weight:bold;
      background:#1a1a2e; border:2px solid #555; color:#aaa;
      cursor:pointer; letter-spacing:2px;
    `;
    exitBtn.onmouseenter = () => { exitBtn.style.borderColor = '#888'; exitBtn.style.color = '#fff'; };
    exitBtn.onmouseleave = () => { exitBtn.style.borderColor = '#555'; exitBtn.style.color = '#aaa'; };
    exitBtn.addEventListener('click', () => {
      if (this.resolved) return;
      this.resolved = true;
      const resolve = this.resolveSelection;
      this.resolveSelection = null;
      this.dispose();
      resolve?.(null);
    });
    overlay.appendChild(exitBtn);
    document.body.appendChild(overlay);
    this.buttonOverlay = overlay;
  }

  private showInfoOverlay(): void {
    if (!this.buttonOverlay) return;
    const phase = this.state.phaseState?.currentPhase ?? 1;
    const act = phase <= 1 || phase === 10 ? 1 : phase === 2 || phase === 11 || phase === 14 || phase === 15 ? 2 : 3;
    const techLevel = this.state.phaseState?.techLevel ?? 1;
    const playerCount = this.state.territories.filter(t => t.owner === 'player').length;

    const info = document.createElement('div');
    info.style.cssText = `
      position:fixed; top:20px; right:20px;
      z-index:2002; pointer-events:none;
      text-align:right; font-family:'Segoe UI',Tahoma,sans-serif;
    `;
    info.innerHTML = `
      <div style="color:#d4a840;font-size:16px;font-weight:bold;">${this.state.house}</div>
      <div style="color:#888;font-size:12px;">Act ${act} | Phase ${phase} | Tech ${techLevel}</div>
      <div style="color:#888;font-size:12px;">Territories: ${playerCount}/33</div>
    `;
    this.buttonOverlay.appendChild(info);
  }

  private showAttackButtons(territoryName: string): void {
    this.removeAttackButtons();

    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed; bottom:60px; left:0; right:0;
      display:flex; flex-direction:column; align-items:center; gap:12px;
      z-index:2002; pointer-events:auto;
    `;

    const label = document.createElement('div');
    label.textContent = `Attack ${territoryName}?`;
    label.style.cssText = `color:#ffcc44; font-size:18px; font-weight:bold; font-family:'Segoe UI',Tahoma,sans-serif; text-shadow:0 0 10px #ffcc4440;`;
    overlay.appendChild(label);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex; gap:24px;';

    const attackBtn = document.createElement('button');
    attackBtn.textContent = 'ATTACK';
    attackBtn.style.cssText = `
      padding:12px 36px; font-size:16px; font-weight:bold;
      background:#aa222233; border:2px solid #cc4444; color:#ff6666;
      cursor:pointer; letter-spacing:2px;
    `;
    attackBtn.onmouseenter = () => { attackBtn.style.background = '#aa222266'; };
    attackBtn.onmouseleave = () => { attackBtn.style.background = '#aa222233'; };
    attackBtn.addEventListener('click', () => this.onAttackConfirm());
    btnRow.appendChild(attackBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'CANCEL';
    cancelBtn.style.cssText = `
      padding:12px 36px; font-size:16px; font-weight:bold;
      background:#33333333; border:2px solid #666; color:#aaa;
      cursor:pointer; letter-spacing:2px;
    `;
    cancelBtn.onmouseenter = () => { cancelBtn.style.background = '#33333366'; };
    cancelBtn.onmouseleave = () => { cancelBtn.style.background = '#33333333'; };
    cancelBtn.addEventListener('click', () => {
      this.selectedTerritoryId = null;
      this.removeAttackButtons();
    });
    btnRow.appendChild(cancelBtn);

    overlay.appendChild(btnRow);

    overlay.dataset.attackButtons = 'true';
    document.body.appendChild(overlay);
  }

  private removeAttackButtons(): void {
    document.querySelectorAll('[data-attack-buttons]').forEach(el => el.remove());
  }

  private onAttackConfirm(): void {
    if (this.resolved || this.selectedTerritoryId === null) return;
    this.resolved = true;
    const id = this.selectedTerritoryId;
    this.removeAttackButtons();
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
      const entry = this.territories.find(t => t.id === this.hoveredTerritoryId);
      if (entry?.select && entry.select instanceof THREE.Mesh) {
        const mat = entry.select.material as THREE.MeshStandardMaterial;
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
    this.removeAttackButtons();
    if (this.buttonOverlay) {
      this.buttonOverlay.remove();
      this.buttonOverlay = null;
    }
    document.body.style.cursor = 'default';
  }
}
