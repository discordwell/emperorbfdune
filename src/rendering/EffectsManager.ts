import * as THREE from 'three';
import type { SceneManager } from './SceneManager';

interface ParticleEffect {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  gravity: number;
}

interface Explosion {
  particles: ParticleEffect[];
  flash: THREE.PointLight | null;
  flashLife: number;
}

type WeaponStyle = 'bullet' | 'rocket' | 'laser' | 'flame' | 'mortar';

interface Projectile {
  id: number; // Unique ID for trail tracking
  mesh: THREE.Mesh | THREE.Line;
  start: THREE.Vector3;
  end: THREE.Vector3;
  progress: number; // 0-1
  speed: number; // units per second
  onHit: (() => void) | null;
  style: WeaponStyle;
  trail?: THREE.Mesh; // Trail mesh for rockets
}

interface Beam {
  line: THREE.Line;
  life: number;
}

/** Configuration for trail appearance per weapon style */
interface TrailConfig {
  maxParticles: number;    // Max trail particles per projectile
  maxAge: number;          // Lifetime in seconds
  spawnRate: number;       // Seconds between particle spawns
  startSize: number;       // Initial particle size
  endSize: number;         // Final particle size (growth for smoke)
  startColor: THREE.Color; // Starting color
  endColor: THREE.Color;   // Fade-to color
  startOpacity: number;    // Initial opacity
  drift: number;           // Random lateral drift speed
  rise: number;            // Upward drift speed (smoke rises)
}

/** Per-particle data stored in flat arrays for GPU upload */
interface TrailParticle {
  x: number;
  y: number;
  z: number;
  age: number;
  maxAge: number;
  size: number;
  endSize: number;
  r: number; g: number; b: number;       // Start color
  endR: number; endG: number; endB: number; // End color
  startOpacity: number;
  driftX: number;
  driftZ: number;
  rise: number;
  alive: boolean;
}

interface WormVisual {
  group: THREE.Group;
  ringMesh: THREE.Mesh;
  dustParticles: THREE.Mesh[];
  trailMeshes: THREE.Mesh[];
  prevX: number;
  prevZ: number;
}

interface DamageSmoke {
  mesh: THREE.Mesh;
  baseY: number;
  phase: number; // Random offset for animation variety
}

export class EffectsManager {
  private sceneManager: SceneManager;
  private explosions: Explosion[] = [];
  private projectiles: Projectile[] = [];
  private beams: Beam[] = [];
  private wreckages: THREE.Mesh[] = [];
  private wormVisuals = new Map<number, WormVisual>();
  // Rally point markers per player
  private rallyMarkers = new Map<number, THREE.Group>();
  // Building damage smoke/fire effects: eid -> array of smoke meshes
  private buildingDamageEffects = new Map<number, DamageSmoke[]>();
  // Sandstorm overlay
  private sandstormParticles: THREE.Mesh[] = [];
  private sandstormActive = false;
  // Dust trails from moving units
  private dustPuffs: { mesh: THREE.Mesh; life: number; vy: number }[] = [];
  private dustGeo: THREE.SphereGeometry | null = null;

  // Projectile trail particle system (GPU-efficient single Points object)
  private static readonly MAX_TRAIL_PARTICLES = 500;
  private trailParticles: TrailParticle[] = [];
  private trailFreeList: number[] = []; // Stack of available particle indices
  private trailPoints: THREE.Points | null = null;
  private trailPositions!: Float32Array;
  private trailColors!: Float32Array;
  private trailSizes!: Float32Array;
  private trailGeometry!: THREE.BufferGeometry;
  private trailMaterial!: THREE.ShaderMaterial;
  private nextProjectileId = 0;
  private projectileTrailTimers = new Map<number, number>(); // projectile id -> time since last spawn
  private static readonly TRAIL_CONFIGS: Record<string, TrailConfig> = {
    rocket: {
      maxParticles: 18,
      maxAge: 0.8,
      spawnRate: 0.02,
      startSize: 3.0,
      endSize: 8.0,
      startColor: new THREE.Color(0.95, 0.85, 0.75),
      endColor: new THREE.Color(0.5, 0.5, 0.5),
      startOpacity: 0.7,
      drift: 0.3,
      rise: 0.8,
    },
    flame: {
      maxParticles: 10,
      maxAge: 0.5,
      spawnRate: 0.025,
      startSize: 4.0,
      endSize: 2.0,
      startColor: new THREE.Color(1.0, 0.5, 0.1),
      endColor: new THREE.Color(0.4, 0.05, 0.0),
      startOpacity: 0.8,
      drift: 0.5,
      rise: 0.3,
    },
    mortar: {
      maxParticles: 12,
      maxAge: 0.6,
      spawnRate: 0.03,
      startSize: 2.0,
      endSize: 5.0,
      startColor: new THREE.Color(0.7, 0.7, 0.7),
      endColor: new THREE.Color(0.35, 0.35, 0.35),
      startOpacity: 0.5,
      drift: 0.2,
      rise: 0.5,
    },
  };

  // Crate visuals: id -> mesh
  private crateVisuals = new Map<number, THREE.Mesh>();
  private crateGeo: THREE.BoxGeometry;

  // Shared geometry for particles
  private particleGeo: THREE.SphereGeometry;
  private projectileGeo: THREE.SphereGeometry;
  private rocketGeo: THREE.CylinderGeometry;
  private flameGeo: THREE.SphereGeometry;
  private trailGeo: THREE.SphereGeometry;
  private wormRingGeo: THREE.RingGeometry;
  private wormDustGeo: THREE.SphereGeometry;
  private wormTrailGeo: THREE.SphereGeometry;
  private smokeGeo: THREE.SphereGeometry;

  constructor(sceneManager: SceneManager) {
    this.sceneManager = sceneManager;
    this.crateGeo = new THREE.BoxGeometry(1.0, 1.0, 1.0);
    this.particleGeo = new THREE.SphereGeometry(0.15, 4, 4);
    this.projectileGeo = new THREE.SphereGeometry(0.1, 4, 4);
    this.rocketGeo = new THREE.CylinderGeometry(0.05, 0.12, 0.6, 4);
    this.rocketGeo.rotateX(Math.PI / 2);
    this.flameGeo = new THREE.SphereGeometry(0.25, 5, 5);
    this.trailGeo = new THREE.SphereGeometry(0.2, 4, 4);
    this.wormRingGeo = new THREE.RingGeometry(1.5, 3.0, 16);
    this.wormDustGeo = new THREE.SphereGeometry(0.3, 4, 4);
    this.wormTrailGeo = new THREE.SphereGeometry(0.2, 3, 3);
    this.smokeGeo = new THREE.SphereGeometry(0.4, 5, 5);

    // Initialize trail particle Points system
    this.initTrailSystem();
  }

  /** Initialize the GPU-efficient trail particle system using a single THREE.Points */
  private initTrailSystem(): void {
    const max = EffectsManager.MAX_TRAIL_PARTICLES;
    this.trailPositions = new Float32Array(max * 3);
    this.trailColors = new Float32Array(max * 3);
    this.trailSizes = new Float32Array(max);

    // Pre-fill pool with dead particles and free-list
    for (let i = 0; i < max; i++) {
      this.trailFreeList.push(i);
      this.trailParticles.push({
        x: 0, y: -100, z: 0, // Off-screen
        age: 0, maxAge: 1,
        size: 0, endSize: 0,
        r: 1, g: 1, b: 1,
        endR: 0.5, endG: 0.5, endB: 0.5,
        startOpacity: 0,
        driftX: 0, driftZ: 0, rise: 0,
        alive: false,
      });
      // Position off-screen
      this.trailPositions[i * 3] = 0;
      this.trailPositions[i * 3 + 1] = -100;
      this.trailPositions[i * 3 + 2] = 0;
      this.trailColors[i * 3] = 1;
      this.trailColors[i * 3 + 1] = 1;
      this.trailColors[i * 3 + 2] = 1;
      this.trailSizes[i] = 0;
    }

    this.trailGeometry = new THREE.BufferGeometry();
    this.trailGeometry.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
    this.trailGeometry.setAttribute('color', new THREE.BufferAttribute(this.trailColors, 3));
    this.trailGeometry.setAttribute('aSize', new THREE.BufferAttribute(this.trailSizes, 1));

    // Custom ShaderMaterial for per-particle sizes with additive blending
    this.trailMaterial = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float aSize;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (200.0 / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          // Soft circle falloff
          float dist = length(gl_PointCoord - vec2(0.5));
          if (dist > 0.5) discard;
          float alpha = 1.0 - smoothstep(0.2, 0.5, dist);
          gl_FragColor = vec4(vColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });

    this.trailPoints = new THREE.Points(this.trailGeometry, this.trailMaterial);
    this.trailPoints.frustumCulled = false; // Particles span the scene
    this.sceneManager.scene.add(this.trailPoints);
  }

  /** Get the trail configuration for a weapon style, or null if no trail */
  private getTrailConfig(style: WeaponStyle): TrailConfig | null {
    return EffectsManager.TRAIL_CONFIGS[style] ?? null;
  }

  /** Find a dead particle slot in the pool, or return -1 if full */
  private allocateTrailParticle(): number {
    return this.trailFreeList.length > 0 ? this.trailFreeList.pop()! : -1;
  }

  /** Spawn a single trail particle at the given position with the given config */
  private spawnTrailParticle(x: number, y: number, z: number, config: TrailConfig): void {
    const idx = this.allocateTrailParticle();
    if (idx < 0) return; // Pool full, skip

    const p = this.trailParticles[idx];
    p.x = x + (Math.random() - 0.5) * 0.1; // Slight positional jitter
    p.y = y + (Math.random() - 0.5) * 0.1;
    p.z = z + (Math.random() - 0.5) * 0.1;
    p.age = 0;
    p.maxAge = config.maxAge * (0.8 + Math.random() * 0.4); // Vary lifetime slightly
    p.size = config.startSize;
    p.endSize = config.endSize;
    p.r = config.startColor.r;
    p.g = config.startColor.g;
    p.b = config.startColor.b;
    p.endR = config.endColor.r;
    p.endG = config.endColor.g;
    p.endB = config.endColor.b;
    p.startOpacity = config.startOpacity;
    p.driftX = (Math.random() - 0.5) * config.drift;
    p.driftZ = (Math.random() - 0.5) * config.drift;
    p.rise = config.rise * (0.7 + Math.random() * 0.6);
    p.alive = true;
  }

  /** Update all trail particles: age, fade, drift, and upload to GPU buffers */
  private updateTrailParticles(dtSec: number): void {
    let needsUpdate = false;

    for (let i = 0; i < this.trailParticles.length; i++) {
      const p = this.trailParticles[i];
      if (!p.alive) continue;

      needsUpdate = true;
      p.age += dtSec;

      if (p.age >= p.maxAge) {
        // Kill particle — move off-screen and return to free-list
        p.alive = false;
        this.trailFreeList.push(i);
        this.trailPositions[i * 3 + 1] = -100;
        this.trailSizes[i] = 0;
        continue;
      }

      const t = p.age / p.maxAge; // 0..1 normalized age

      // Drift and rise
      p.x += p.driftX * dtSec;
      p.y += p.rise * dtSec;
      p.z += p.driftZ * dtSec;

      // Interpolate size
      const currentSize = p.size + (p.endSize - p.size) * t;

      // Interpolate color
      const cr = p.r + (p.endR - p.r) * t;
      const cg = p.g + (p.endG - p.g) * t;
      const cb = p.b + (p.endB - p.b) * t;

      // Fade opacity: multiply into color (since PointsMaterial uses vertexColors)
      // Use smooth fade-out curve
      const opacity = p.startOpacity * (1 - t) * (1 - t);

      // Write to GPU buffers
      this.trailPositions[i * 3] = p.x;
      this.trailPositions[i * 3 + 1] = p.y;
      this.trailPositions[i * 3 + 2] = p.z;
      this.trailColors[i * 3] = cr * opacity;
      this.trailColors[i * 3 + 1] = cg * opacity;
      this.trailColors[i * 3 + 2] = cb * opacity;
      this.trailSizes[i] = currentSize * (1 - t * 0.3); // Slight shrink at end
    }

    if (needsUpdate) {
      this.trailGeometry.attributes.position.needsUpdate = true;
      this.trailGeometry.attributes.color.needsUpdate = true;
      this.trailGeometry.attributes.aSize.needsUpdate = true;
    }
  }

  /** Spawn trail particles for all active projectiles that have trail configs */
  private updateProjectileTrails(dtSec: number): void {
    for (const proj of this.projectiles) {
      const config = this.getTrailConfig(proj.style);
      if (!config) continue;

      // Accumulate time since last spawn
      const timer = (this.projectileTrailTimers.get(proj.id) ?? 0) + dtSec;

      // Spawn particles at the configured rate
      if (timer >= config.spawnRate) {
        this.spawnTrailParticle(
          proj.mesh.position.x,
          proj.mesh.position.y,
          proj.mesh.position.z,
          config,
        );
        this.projectileTrailTimers.set(proj.id, 0);
      } else {
        this.projectileTrailTimers.set(proj.id, timer);
      }
    }
  }

  spawnExplosion(x: number, y: number, z: number, size: 'small' | 'medium' | 'large' = 'medium'): void {
    const particleCount = size === 'small' ? 6 : size === 'medium' ? 12 : 20;
    const speed = size === 'small' ? 4 : size === 'medium' ? 6 : 10;
    const life = size === 'small' ? 0.5 : size === 'medium' ? 0.8 : 1.2;

    const particles: ParticleEffect[] = [];

    for (let i = 0; i < particleCount; i++) {
      const color = Math.random() > 0.3
        ? new THREE.Color(1.0, 0.4 + Math.random() * 0.4, 0.0) // Orange/yellow
        : new THREE.Color(0.3, 0.3, 0.3); // Smoke/grey

      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1.0 });
      const mesh = new THREE.Mesh(this.particleGeo, mat);

      mesh.position.set(x, y + 0.5, z);
      const scale = 0.2 + Math.random() * 0.4;
      mesh.scale.setScalar(scale);

      this.sceneManager.scene.add(mesh);

      const angle = Math.random() * Math.PI * 2;
      const elevation = Math.random() * Math.PI * 0.5 + 0.2;
      const spd = speed * (0.5 + Math.random() * 0.5);

      particles.push({
        mesh,
        velocity: new THREE.Vector3(
          Math.cos(angle) * Math.cos(elevation) * spd,
          Math.sin(elevation) * spd,
          Math.sin(angle) * Math.cos(elevation) * spd
        ),
        life: life * (0.5 + Math.random() * 0.5),
        maxLife: life,
        gravity: 8 + Math.random() * 4,
      });
    }

    // Flash light
    const flashIntensity = size === 'small' ? 3 : size === 'medium' ? 6 : 12;
    const flash = new THREE.PointLight(0xff6600, flashIntensity, 15);
    flash.position.set(x, y + 1, z);
    this.sceneManager.scene.add(flash);

    this.explosions.push({ particles, flash, flashLife: 0.15 });
  }

  spawnWreckage(x: number, y: number, z: number, isBuilding: boolean): void {
    const size = isBuilding ? 2.5 : 1.0;
    const geo = new THREE.BoxGeometry(
      size * (0.5 + Math.random() * 0.5),
      size * 0.3,
      size * (0.5 + Math.random() * 0.5)
    );
    const mat = new THREE.MeshLambertMaterial({ color: 0x222222 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y + size * 0.15, z);
    mesh.rotation.y = Math.random() * Math.PI * 2;
    this.sceneManager.scene.add(mesh);
    this.wreckages.push(mesh);

    // Auto-remove wreckage after 30 seconds
    setTimeout(() => {
      this.sceneManager.scene.remove(mesh);
      geo.dispose();
      mat.dispose();
      const idx = this.wreckages.indexOf(mesh);
      if (idx >= 0) this.wreckages.splice(idx, 1);
    }, 30000);
  }

  spawnProjectile(
    fromX: number, fromY: number, fromZ: number,
    toX: number, toY: number, toZ: number,
    color: number = 0xffaa00,
    speed: number = 40,
    onHit?: () => void,
    style: WeaponStyle = 'bullet',
  ): void {
    const startPos = new THREE.Vector3(fromX, fromY + 1, fromZ);
    const endPos = new THREE.Vector3(toX, toY + 1, toZ);

    // Laser: instant beam, no traveling projectile
    if (style === 'laser') {
      this.spawnBeam(startPos, endPos, color);
      this.spawnExplosion(toX, toY, toZ, 'small');
      return;
    }

    // Create projectile mesh based on style
    let mesh: THREE.Mesh;
    let trail: THREE.Mesh | undefined;

    if (style === 'rocket') {
      const mat = new THREE.MeshBasicMaterial({ color });
      mesh = new THREE.Mesh(this.rocketGeo, mat);
      // Trail glow
      const trailMat = new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.5 });
      trail = new THREE.Mesh(this.trailGeo, trailMat);
      trail.position.copy(startPos);
      this.sceneManager.scene.add(trail);
    } else if (style === 'flame') {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 });
      mesh = new THREE.Mesh(this.flameGeo, mat);
    } else {
      // Default bullet: small fast sphere
      const mat = new THREE.MeshBasicMaterial({ color });
      mesh = new THREE.Mesh(this.projectileGeo, mat);
    }

    mesh.position.copy(startPos);
    // Orient rocket toward target
    if (style === 'rocket') {
      mesh.lookAt(endPos);
    }
    this.sceneManager.scene.add(mesh);

    // Muzzle flash for bullets/cannons
    if (style === 'bullet') {
      const flash = new THREE.PointLight(color, 2, 5);
      flash.position.copy(startPos);
      this.sceneManager.scene.add(flash);
      setTimeout(() => { this.sceneManager.scene.remove(flash); flash.dispose(); }, 50);
    }

    const id = this.nextProjectileId++;
    this.projectiles.push({
      id,
      mesh,
      start: startPos,
      end: endPos,
      progress: 0,
      speed,
      onHit: onHit ?? null,
      style,
      trail,
    });

    // Register trail timer for styles that have trails
    if (this.getTrailConfig(style)) {
      this.projectileTrailTimers.set(id, 0);
    }
  }

  private spawnBeam(start: THREE.Vector3, end: THREE.Vector3, color: number): void {
    const points = [start, end];
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({ color, linewidth: 2, transparent: true, opacity: 0.9 });
    const line = new THREE.Line(geo, mat);
    this.sceneManager.scene.add(line);
    this.beams.push({ line, life: 0.15 }); // Beam visible for 150ms
  }

  updateWormVisuals(worms: ReadonlyArray<{ x: number; z: number; state: string }>, dt: number): void {
    const activeIds = new Set<number>();

    for (let i = 0; i < worms.length; i++) {
      const worm = worms[i];
      activeIds.add(i);

      let vis = this.wormVisuals.get(i);
      if (!vis) {
        vis = this.createWormVisual();
        this.wormVisuals.set(i, vis);
        this.sceneManager.scene.add(vis.group);
      }

      // Update position
      vis.group.position.set(worm.x, 0.05, worm.z);

      // Animate ring based on state
      const isEmerging = worm.state === 'emerging';
      const isHunting = worm.state === 'hunting';
      const pulseSpeed = isHunting ? 8 : 3;
      const pulseScale = 1.0 + Math.sin(Date.now() * 0.001 * pulseSpeed) * 0.2;
      vis.ringMesh.scale.set(pulseScale, pulseScale, 1);

      // Ring color based on worm state
      const isMounted = worm.state === 'mounted';
      const ringMat = vis.ringMesh.material as THREE.MeshBasicMaterial;
      if (isMounted) {
        ringMat.color.setHex(0x00cc88);
        ringMat.opacity = 0.7;
      } else if (isHunting) {
        ringMat.color.setHex(0xff6600);
        ringMat.opacity = 0.6;
      } else if (isEmerging) {
        ringMat.color.setHex(0xffcc66);
        ringMat.opacity = 0.8;
      } else {
        ringMat.color.setHex(0xd4a460);
        ringMat.opacity = 0.4;
      }

      // Rotate ring slowly
      vis.ringMesh.rotation.z += dt * 0.001;

      // Animate dust particles (float up and down)
      for (let j = 0; j < vis.dustParticles.length; j++) {
        const dust = vis.dustParticles[j];
        const angle = (Date.now() * 0.002 + j * 1.2) % (Math.PI * 2);
        const radius = 1.5 + Math.sin(j * 2.1) * 0.5;
        dust.position.set(
          Math.cos(angle) * radius,
          0.3 + Math.sin(Date.now() * 0.003 + j) * 0.5,
          Math.sin(angle) * radius
        );
        const dustMat = dust.material as THREE.MeshBasicMaterial;
        dustMat.opacity = (isHunting ? 0.7 : 0.4) * (0.5 + Math.sin(Date.now() * 0.004 + j) * 0.5);
      }

      // Trail: leave sand puffs behind where worm was
      const dx = worm.x - vis.prevX;
      const dz = worm.z - vis.prevZ;
      const moved = Math.sqrt(dx * dx + dz * dz);
      if (moved > 2 && vis.trailMeshes.length < 12) {
        const trail = new THREE.Mesh(
          this.wormTrailGeo,
          new THREE.MeshBasicMaterial({ color: 0xd4a460, transparent: true, opacity: 0.5 })
        );
        trail.position.set(vis.prevX, 0.1, vis.prevZ);
        this.sceneManager.scene.add(trail);
        vis.trailMeshes.push(trail);
        vis.prevX = worm.x;
        vis.prevZ = worm.z;
      }

      // Fade and remove old trail puffs
      for (let j = vis.trailMeshes.length - 1; j >= 0; j--) {
        const trail = vis.trailMeshes[j];
        const mat = trail.material as THREE.MeshBasicMaterial;
        mat.opacity -= dt * 0.0003;
        if (mat.opacity <= 0) {
          this.sceneManager.scene.remove(trail);
          trail.geometry.dispose();
          mat.dispose();
          vis.trailMeshes.splice(j, 1);
        }
      }
    }

    // Remove visuals for worms that no longer exist
    for (const [id, vis] of this.wormVisuals) {
      if (!activeIds.has(id)) {
        this.removeWormVisual(vis);
        this.wormVisuals.delete(id);
      }
    }
  }

  private createWormVisual(): WormVisual {
    const group = new THREE.Group();

    // Sand disturbance ring (lies flat on ground)
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xd4a460,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
    });
    const ringMesh = new THREE.Mesh(this.wormRingGeo, ringMat);
    ringMesh.rotation.x = -Math.PI / 2; // Flat on ground
    ringMesh.position.y = 0.05;
    group.add(ringMesh);

    // Dust particles floating around worm
    const dustParticles: THREE.Mesh[] = [];
    for (let i = 0; i < 6; i++) {
      const dustMat = new THREE.MeshBasicMaterial({
        color: 0xd4a460,
        transparent: true,
        opacity: 0.4,
      });
      const dust = new THREE.Mesh(this.wormDustGeo, dustMat);
      group.add(dust);
      dustParticles.push(dust);
    }

    return { group, ringMesh, dustParticles, trailMeshes: [], prevX: 0, prevZ: 0 };
  }

  private removeWormVisual(vis: WormVisual): void {
    this.sceneManager.scene.remove(vis.group);
    (vis.ringMesh.material as THREE.Material).dispose();
    for (const dust of vis.dustParticles) {
      (dust.material as THREE.Material).dispose();
    }
    for (const trail of vis.trailMeshes) {
      this.sceneManager.scene.remove(trail);
      (trail.material as THREE.Material).dispose();
    }
  }

  update(dt: number): void {
    const dtSec = dt / 1000;

    // Update projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const proj = this.projectiles[i];
      const dist = proj.start.distanceTo(proj.end);
      const step = (proj.speed * dtSec) / Math.max(dist, 0.1);
      proj.progress += step;

      if (proj.progress >= 1) {
        // Hit
        this.sceneManager.scene.remove(proj.mesh);
        (proj.mesh.material as THREE.Material).dispose();
        if (proj.trail) {
          this.sceneManager.scene.remove(proj.trail);
          (proj.trail.material as THREE.Material).dispose();
        }
        // Clean up trail timer (existing trail particles fade out naturally)
        this.projectileTrailTimers.delete(proj.id);
        if (proj.onHit) proj.onHit();
        // Impact size based on weapon type
        const impactSize = proj.style === 'rocket' || proj.style === 'mortar' ? 'medium' : 'small';
        this.spawnExplosion(proj.end.x, proj.end.y - 1, proj.end.z, impactSize);
        this.projectiles.splice(i, 1);
      } else {
        // Interpolate position
        proj.mesh.position.lerpVectors(proj.start, proj.end, proj.progress);

        // Style-specific arc and effects
        const arcHeight = proj.style === 'mortar' ? 0.3 : proj.style === 'rocket' ? 0.15 : 0.1;
        const arc = Math.sin(proj.progress * Math.PI) * dist * arcHeight;
        proj.mesh.position.y += arc;

        // Rocket trail follows behind
        if (proj.trail) {
          proj.trail.position.lerpVectors(proj.start, proj.end, Math.max(0, proj.progress - 0.1));
          proj.trail.position.y += Math.sin(Math.max(0, proj.progress - 0.1) * Math.PI) * dist * 0.15;
          // Fade trail
          const trailMat = proj.trail.material as THREE.MeshBasicMaterial;
          trailMat.opacity = 0.5 * (1 - proj.progress);
        }

        // Flame grows then shrinks
        if (proj.style === 'flame') {
          const scale = 1 + Math.sin(proj.progress * Math.PI) * 1.5;
          proj.mesh.scale.setScalar(scale);
          const flameMat = proj.mesh.material as THREE.MeshBasicMaterial;
          flameMat.opacity = 0.8 * (1 - proj.progress * 0.5);
        }
      }
    }

    // Update beams
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const beam = this.beams[i];
      beam.life -= dtSec;
      if (beam.life <= 0) {
        this.sceneManager.scene.remove(beam.line);
        beam.line.geometry.dispose();
        (beam.line.material as THREE.Material).dispose();
        this.beams.splice(i, 1);
      } else {
        // Fade beam out
        const mat = beam.line.material as THREE.LineBasicMaterial;
        mat.opacity = beam.life / 0.15;
      }
    }

    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const explosion = this.explosions[i];
      let allDead = true;

      // Update particles
      for (let j = explosion.particles.length - 1; j >= 0; j--) {
        const p = explosion.particles[j];
        p.life -= dtSec;

        if (p.life <= 0) {
          this.sceneManager.scene.remove(p.mesh);
          (p.mesh.material as THREE.Material).dispose();
          explosion.particles.splice(j, 1);
          continue;
        }

        allDead = false;

        // Physics
        p.velocity.y -= p.gravity * dtSec;
        p.mesh.position.add(p.velocity.clone().multiplyScalar(dtSec));

        // Don't go below ground
        if (p.mesh.position.y < 0.1) {
          p.mesh.position.y = 0.1;
          p.velocity.y = 0;
          p.velocity.x *= 0.8;
          p.velocity.z *= 0.8;
        }

        // Fade out
        const ratio = p.life / p.maxLife;
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = ratio;
        p.mesh.scale.setScalar(0.2 + (1 - ratio) * 0.3);
      }

      // Update flash
      if (explosion.flash) {
        explosion.flashLife -= dtSec;
        if (explosion.flashLife <= 0) {
          this.sceneManager.scene.remove(explosion.flash);
          explosion.flash.dispose();
          explosion.flash = null;
        } else {
          explosion.flash.intensity *= 0.85;
        }
      }

      if (allDead && !explosion.flash) {
        this.explosions.splice(i, 1);
      }
    }

    // Animate rally flags (gentle bob)
    for (const [, marker] of this.rallyMarkers) {
      marker.children[0].position.y = 1.5 + Math.sin(Date.now() * 0.003) * 0.15;
    }

    // Crate animations
    this.updateCrates(dt);

    // Sandstorm particles
    this.updateSandstormParticles(dt);

    // Dust trail puffs
    for (let i = this.dustPuffs.length - 1; i >= 0; i--) {
      const puff = this.dustPuffs[i];
      puff.life -= dtSec;
      if (puff.life <= 0) {
        this.sceneManager.scene.remove(puff.mesh);
        (puff.mesh.material as THREE.Material).dispose();
        this.dustPuffs.splice(i, 1);
      } else {
        puff.mesh.position.y += puff.vy * dtSec;
        const scale = 0.3 + (1 - puff.life / 0.8) * 0.4;
        puff.mesh.scale.setScalar(scale);
        (puff.mesh.material as THREE.MeshBasicMaterial).opacity = puff.life / 0.8 * 0.4;
      }
    }

    // Projectile trail particles: spawn new + age/fade existing
    this.updateProjectileTrails(dtSec);
    this.updateTrailParticles(dtSec);
  }

  /** Spawn a small dust puff at the given position (for moving ground units) */
  spawnDustPuff(x: number, z: number): void {
    if (this.dustPuffs.length > 100) return; // Cap dust particles
    if (!this.dustGeo) this.dustGeo = new THREE.SphereGeometry(0.15, 3, 3);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xc8a060, transparent: true, opacity: 0.4, depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.dustGeo, mat);
    mesh.position.set(
      x + (Math.random() - 0.5) * 0.5,
      0.1,
      z + (Math.random() - 0.5) * 0.5,
    );
    this.sceneManager.scene.add(mesh);
    this.dustPuffs.push({ mesh, life: 0.8, vy: 0.3 + Math.random() * 0.3 });
  }

  setRallyPoint(playerId: number, x: number, z: number): void {
    // Remove and dispose old marker
    this.clearRallyPoint(playerId);

    const group = new THREE.Group();
    group.position.set(x, 0, z);

    // Flag pole
    const poleGeo = new THREE.CylinderGeometry(0.05, 0.05, 2, 4);
    const poleMat = new THREE.MeshBasicMaterial({ color: 0x888888 });
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.y = 1;
    group.add(pole);

    // Flag (small triangle)
    const flagShape = new THREE.Shape();
    flagShape.moveTo(0, 0);
    flagShape.lineTo(0.8, 0.25);
    flagShape.lineTo(0, 0.5);
    const flagGeo = new THREE.ShapeGeometry(flagShape);
    const flagMat = new THREE.MeshBasicMaterial({ color: 0x00ff44, side: THREE.DoubleSide });
    const flag = new THREE.Mesh(flagGeo, flagMat);
    flag.position.set(0.05, 1.5, 0);
    flag.rotation.y = Math.PI / 4;
    group.add(flag);

    this.sceneManager.scene.add(group);
    this.rallyMarkers.set(playerId, group);
  }

  clearRallyPoint(playerId: number): void {
    const existing = this.rallyMarkers.get(playerId);
    if (existing) {
      existing.traverse(child => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
      this.sceneManager.scene.remove(existing);
      this.rallyMarkers.delete(playerId);
    }
  }

  /** Update building damage smoke/fire based on health ratio */
  updateBuildingDamage(eid: number, x: number, y: number, z: number, healthRatio: number): void {
    const existing = this.buildingDamageEffects.get(eid);

    // Full health or dead: remove effects
    if (healthRatio >= 0.75 || healthRatio <= 0) {
      if (existing) {
        for (const smoke of existing) {
          this.sceneManager.scene.remove(smoke.mesh);
          (smoke.mesh.material as THREE.Material).dispose();
        }
        this.buildingDamageEffects.delete(eid);
      }
      return;
    }

    // Determine how many smoke columns based on damage
    let targetCount = 0;
    let isOnFire = false;
    if (healthRatio < 0.25) {
      targetCount = 3;
      isOnFire = true;
    } else if (healthRatio < 0.5) {
      targetCount = 2;
      isOnFire = true;
    } else {
      targetCount = 1;
    }

    // Create effects if needed
    if (!existing || existing.length !== targetCount) {
      // Remove old
      if (existing) {
        for (const smoke of existing) {
          this.sceneManager.scene.remove(smoke.mesh);
          (smoke.mesh.material as THREE.Material).dispose();
        }
      }

      const smokes: DamageSmoke[] = [];
      for (let i = 0; i < targetCount; i++) {
        const color = isOnFire ? 0xff4400 : 0x444444;
        const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6 });
        const mesh = new THREE.Mesh(this.smokeGeo, mat);
        const offsetX = (Math.random() - 0.5) * 2;
        const offsetZ = (Math.random() - 0.5) * 2;
        mesh.position.set(x + offsetX, y + 2, z + offsetZ);
        this.sceneManager.scene.add(mesh);
        smokes.push({ mesh, baseY: y + 2, phase: Math.random() * Math.PI * 2 });
      }
      this.buildingDamageEffects.set(eid, smokes);
    }

    // Animate existing smoke
    const effects = this.buildingDamageEffects.get(eid)!;
    const t = Date.now() * 0.001;
    for (const smoke of effects) {
      // Bob up and down, pulse scale
      smoke.mesh.position.y = smoke.baseY + Math.sin(t * 2 + smoke.phase) * 0.5 + 0.5;
      const scale = 0.5 + Math.sin(t * 3 + smoke.phase) * 0.2;
      smoke.mesh.scale.setScalar(scale);
      const mat = smoke.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.4 + Math.sin(t * 4 + smoke.phase) * 0.2;
      // Fire flickers between orange and red
      if (isOnFire) {
        const flicker = Math.sin(t * 8 + smoke.phase) * 0.5 + 0.5;
        mat.color.setRGB(1.0, 0.2 + flicker * 0.3, flicker * 0.1);
      }
    }
  }

  /** Remove all damage effects for an entity (on death/sell) */
  clearBuildingDamage(eid: number): void {
    const existing = this.buildingDamageEffects.get(eid);
    if (existing) {
      for (const smoke of existing) {
        this.sceneManager.scene.remove(smoke.mesh);
        (smoke.mesh.material as THREE.Material).dispose();
      }
      this.buildingDamageEffects.delete(eid);
    }
  }

  /** Start sandstorm visual effect */
  startSandstorm(): void {
    if (this.sandstormActive) return;
    this.sandstormActive = true;

    // Create swirling sand particles across the viewport
    for (let i = 0; i < 60; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xd4a460,
        transparent: true,
        opacity: 0.3 + Math.random() * 0.3,
      });
      const mesh = new THREE.Mesh(this.smokeGeo, mat);
      const scale = 0.5 + Math.random() * 1.5;
      mesh.scale.setScalar(scale);
      mesh.position.set(
        (Math.random() - 0.5) * 200,
        0.5 + Math.random() * 5,
        (Math.random() - 0.5) * 200
      );
      mesh.userData.stormVelX = 3 + Math.random() * 4;
      mesh.userData.stormVelZ = (Math.random() - 0.5) * 2;
      mesh.userData.stormPhase = Math.random() * Math.PI * 2;
      this.sceneManager.scene.add(mesh);
      this.sandstormParticles.push(mesh);
    }
  }

  /** Stop sandstorm visual effect */
  stopSandstorm(): void {
    if (!this.sandstormActive) return;
    this.sandstormActive = false;
    for (const mesh of this.sandstormParticles) {
      this.sceneManager.scene.remove(mesh);
      (mesh.material as THREE.Material).dispose();
    }
    this.sandstormParticles = [];
  }

  isSandstormActive(): boolean {
    return this.sandstormActive;
  }

  /** Add a crate visual at world position */
  spawnCrate(id: number, x: number, z: number, type: string): void {
    const colorMap: Record<string, number> = {
      credits: 0xffd700,    // Gold
      veterancy: 0x44ff44,  // Green
      heal: 0x4488ff,       // Blue
    };
    const color = colorMap[type] ?? 0xffd700;
    const mat = new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.3 });
    const mesh = new THREE.Mesh(this.crateGeo, mat);
    mesh.position.set(x, 0.7, z);
    this.sceneManager.scene.add(mesh);
    this.crateVisuals.set(id, mesh);
  }

  /** Remove a crate visual with a sparkle effect */
  removeCrate(id: number): void {
    const mesh = this.crateVisuals.get(id);
    if (mesh) {
      this.spawnExplosion(mesh.position.x, mesh.position.y, mesh.position.z, 'small');
      this.sceneManager.scene.remove(mesh);
      (mesh.material as THREE.Material).dispose();
      this.crateVisuals.delete(id);
    }
  }

  /** Animate spinning crates (call in update) */
  private updateCrates(dt: number): void {
    const dtSec = dt / 1000;
    for (const [, mesh] of this.crateVisuals) {
      mesh.rotation.y += dtSec * 2;
      mesh.position.y = 0.7 + Math.sin(Date.now() * 0.003) * 0.2;
    }
  }

  /** Animate sandstorm particles (call in update) */
  private updateSandstormParticles(dt: number): void {
    if (!this.sandstormActive) return;
    const dtSec = dt / 1000;
    const camX = this.sceneManager.camera.position.x;
    const camZ = this.sceneManager.camera.position.z;

    for (const mesh of this.sandstormParticles) {
      mesh.position.x += mesh.userData.stormVelX * dtSec * 8;
      mesh.position.z += mesh.userData.stormVelZ * dtSec * 8;
      mesh.position.y = 0.5 + Math.sin(Date.now() * 0.002 + mesh.userData.stormPhase) * 3;

      // Wrap particles around camera
      if (mesh.position.x > camX + 100) mesh.position.x = camX - 100;
      if (mesh.position.x < camX - 100) mesh.position.x = camX + 100;
      if (mesh.position.z > camZ + 100) mesh.position.z = camZ - 100;
      if (mesh.position.z < camZ - 100) mesh.position.z = camZ + 100;
    }
  }
}
