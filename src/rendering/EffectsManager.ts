import * as THREE from 'three';
import type { SceneManager } from './SceneManager';
import { ImpactType } from '../config/WeaponDefs';

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
  private _tmpVec = new THREE.Vector3();
  private explosions: Explosion[] = [];
  private projectiles: Projectile[] = [];
  private beams: Beam[] = [];
  private wreckages: { mesh: THREE.Mesh; age: number; maxAge: number }[] = [];
  private moveMarkers: { mesh: THREE.Mesh; age: number }[] = [];
  private wormVisuals = new Map<number, WormVisual>();
  // Rally point markers per player
  private rallyMarkers = new Map<number, THREE.Group>();
  // Building damage smoke/fire effects: eid -> array of smoke meshes
  private buildingDamageEffects = new Map<number, DamageSmoke[]>();
  // Sandstorm overlay
  private sandstormParticles: THREE.Mesh[] = [];
  private sandstormActive = false;
  private preSandstormFog = { density: 0.003, color: 0xc09050 };
  // Weapon-specific impact lingering effects (gas clouds, ground fire)
  private lingeringImpacts: { meshes: THREE.Mesh[]; life: number; maxLife: number; type: ImpactType }[] = [];
  // Sonic ripple rings
  private sonicRipples: { mesh: THREE.Mesh; life: number; maxLife: number; maxScale: number }[] = [];
  // Electric arc lines
  private electricArcs: { line: THREE.Line; life: number }[] = [];
  // Shared geometry for impact ring effects
  private impactRingGeo: THREE.RingGeometry | null = null;
  // Dust trails from moving units
  private dustPuffs: { mesh: THREE.Mesh; life: number; vy: number }[] = [];
  private dustGeo: THREE.SphereGeometry | null = null;
  // Rally line from building to rally point
  private rallyLine: THREE.Line | null = null;
  // Spice shimmer particles
  private spiceShimmerParticles: { mesh: THREE.Mesh; life: number; baseY: number }[] = [];
  private shimmerGeo: THREE.PlaneGeometry | null = null;
  private shimmerTickCounter = 0;

  // Impact decals: scorch marks on the ground from explosions/deaths
  private static readonly MAX_DECALS = 40;
  private decals: { mesh: THREE.Mesh; age: number; maxAge: number }[] = [];
  private decalGeo: THREE.PlaneGeometry | null = null;
  private decalTexture: THREE.Texture | null = null;

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
  private promotionGeo: THREE.PlaneGeometry;

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
    this.promotionGeo = new THREE.PlaneGeometry(0.2, 0.2);

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

  /** Spawn a brief move order marker on the ground */
  spawnMoveMarker(x: number, z: number): void {
    const geo = new THREE.RingGeometry(0.3, 0.6, 16);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x44ff44, transparent: true, opacity: 0.7, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 0.15, z);
    this.sceneManager.scene.add(mesh);
    this.moveMarkers.push({ mesh, age: 0 });
  }

  spawnWreckage(x: number, y: number, z: number, isBuilding: boolean): void {
    const size = isBuilding ? 2.5 : 1.0;
    const geo = new THREE.BoxGeometry(
      size * (0.5 + Math.random() * 0.5),
      size * 0.3,
      size * (0.5 + Math.random() * 0.5)
    );
    const mat = new THREE.MeshLambertMaterial({ color: 0x222222, transparent: true, opacity: 1.0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y + size * 0.15, z);
    mesh.rotation.y = Math.random() * Math.PI * 2;
    this.sceneManager.scene.add(mesh);
    this.wreckages.push({ mesh, age: 0, maxAge: 750 }); // 750 ticks = 30 seconds at 25 TPS
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
      if (onHit) {
        onHit();
      } else {
        this.spawnExplosion(toX, toY, toZ, 'small');
      }
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
        vis.prevX = worm.x; // Initialize to worm position to prevent trail at origin
        vis.prevZ = worm.z;
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
          // Don't dispose shared wormTrailGeo — only dispose per-trail material
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
        if (proj.onHit) {
          // Weapon-specific impact handled by callback (from combat:fire event)
          proj.onHit();
        } else {
          // Fallback: generic explosion for projectiles without weapon-specific impact
          const impactSize = proj.style === 'rocket' || proj.style === 'mortar' ? 'medium' : 'small';
          this.spawnExplosion(proj.end.x, proj.end.y - 1, proj.end.z, impactSize);
        }
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
        p.mesh.position.add(this._tmpVec.copy(p.velocity).multiplyScalar(dtSec));

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

    // Animate move markers (expand + fade out over ~0.5s = 12 ticks)
    for (let i = this.moveMarkers.length - 1; i >= 0; i--) {
      const m = this.moveMarkers[i];
      m.age++;
      const t = m.age / 12;
      if (t >= 1) {
        this.sceneManager.scene.remove(m.mesh);
        m.mesh.geometry.dispose();
        (m.mesh.material as THREE.Material).dispose();
        this.moveMarkers.splice(i, 1);
      } else {
        const scale = 1 + t * 2.5;
        m.mesh.scale.set(scale, 1, scale);
        (m.mesh.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - t);
      }
    }

    // Animate wreckages (fade out during last 20% of life, sink into ground)
    for (let i = this.wreckages.length - 1; i >= 0; i--) {
      const w = this.wreckages[i];
      w.age++;
      if (w.age >= w.maxAge) {
        this.sceneManager.scene.remove(w.mesh);
        w.mesh.geometry.dispose();
        (w.mesh.material as THREE.Material).dispose();
        this.wreckages.splice(i, 1);
      } else {
        const fadeStart = w.maxAge * 0.8;
        if (w.age > fadeStart) {
          const fadeT = (w.age - fadeStart) / (w.maxAge - fadeStart);
          (w.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - fadeT;
          w.mesh.position.y -= 0.003; // Slowly sink into sand
        }
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

    // Age and fade impact decals
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      d.age++;
      if (d.age >= d.maxAge) {
        this.sceneManager.scene.remove(d.mesh);
        (d.mesh.material as THREE.Material).dispose();
        this.decals.splice(i, 1);
      } else {
        // Fade out during last 30% of life
        const fadeStart = d.maxAge * 0.7;
        if (d.age > fadeStart) {
          const fadeT = (d.age - fadeStart) / (d.maxAge - fadeStart);
          (d.mesh.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - fadeT);
        }
      }
    }

    // Update lingering impact effects (gas clouds, ground fire)
    for (let i = this.lingeringImpacts.length - 1; i >= 0; i--) {
      const linger = this.lingeringImpacts[i];
      linger.life -= dtSec;
      const t = Math.max(0, linger.life / linger.maxLife); // 1..0
      if (linger.life <= 0) {
        for (const m of linger.meshes) {
          this.sceneManager.scene.remove(m);
          (m.material as THREE.Material).dispose();
        }
        this.lingeringImpacts.splice(i, 1);
        continue;
      }
      for (const m of linger.meshes) {
        const mat = m.material as THREE.MeshBasicMaterial;
        mat.opacity = t * 0.6;
        if (linger.type === ImpactType.Flame) {
          // Flickering fire effect
          const flicker = 0.8 + Math.sin(Date.now() * 0.01 + m.position.x * 3) * 0.2;
          mat.color.setRGB(1.0 * flicker, 0.3 * flicker, 0.05);
          m.position.y = 0.2 + Math.sin(Date.now() * 0.008 + m.position.z * 2) * 0.15;
        } else {
          // Gas: slowly rise and expand
          m.position.y += dtSec * 0.3;
          const scale = 1.0 + (1 - t) * 0.8;
          m.scale.setScalar(scale);
        }
      }
    }

    // Update sonic ripple rings
    for (let i = this.sonicRipples.length - 1; i >= 0; i--) {
      const ripple = this.sonicRipples[i];
      ripple.life -= dtSec;
      if (ripple.life <= 0) {
        this.sceneManager.scene.remove(ripple.mesh);
        (ripple.mesh.material as THREE.Material).dispose();
        ripple.mesh.geometry.dispose();
        this.sonicRipples.splice(i, 1);
        continue;
      }
      const t = 1 - ripple.life / ripple.maxLife; // 0..1
      const scale = 0.2 + t * ripple.maxScale;
      ripple.mesh.scale.set(scale, scale, 1);
      (ripple.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.7;
    }

    // Update electric arc lines
    for (let i = this.electricArcs.length - 1; i >= 0; i--) {
      const arc = this.electricArcs[i];
      arc.life -= dtSec;
      if (arc.life <= 0) {
        this.sceneManager.scene.remove(arc.line);
        arc.line.geometry.dispose();
        (arc.line.material as THREE.Material).dispose();
        this.electricArcs.splice(i, 1);
      } else {
        (arc.line.material as THREE.LineBasicMaterial).opacity = arc.life / 0.3;
      }
    }
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

  /** Spawn a green repair sparkle above a building */
  spawnRepairSparkle(x: number, y: number, z: number): void {
    if (this.dustPuffs.length > 100) return;
    if (!this.dustGeo) this.dustGeo = new THREE.SphereGeometry(0.15, 3, 3);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x44ff44, transparent: true, opacity: 0.7, depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.dustGeo, mat);
    mesh.position.set(x, y, z);
    this.sceneManager.scene.add(mesh);
    this.dustPuffs.push({ mesh, life: 0.6, vy: 0.5 + Math.random() * 0.3 });
  }

  /** Update spice shimmer: periodically spawn sparkle particles over spice fields */
  updateSpiceShimmer(terrain: import('../rendering/TerrainRenderer').TerrainRenderer): void {
    this.shimmerTickCounter++;
    if (this.shimmerTickCounter % 3 !== 0) return; // Every 3 ticks

    // Cap total shimmer particles
    if (this.spiceShimmerParticles.length > 30) return;

    // Randomly sample a few tiles to see if they have spice
    const mw = terrain.getMapWidth(), mh = terrain.getMapHeight();
    for (let attempt = 0; attempt < 2; attempt++) {
      const tx = Math.floor(Math.random() * mw);
      const tz = Math.floor(Math.random() * mh);
      const spice = terrain.getSpice(tx, tz);
      if (spice <= 0) continue;

      // Only spawn if near camera (within ~40 world units)
      const cam = this.sceneManager.cameraTarget;
      const wx = tx * 2 + 1; // TILE_SIZE=2
      const wz = tz * 2 + 1;
      const dx = wx - cam.x, dz = wz - cam.z;
      if (dx * dx + dz * dz > 1600) continue; // 40^2

      if (!this.shimmerGeo) this.shimmerGeo = new THREE.PlaneGeometry(0.15, 0.15);
      const brightness = 0.6 + spice * 0.4;
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(1.0 * brightness, 0.7 * brightness, 0.2 * brightness),
        transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this.shimmerGeo, mat);
      mesh.position.set(
        wx + (Math.random() - 0.5) * 1.8,
        0.3 + Math.random() * 0.5,
        wz + (Math.random() - 0.5) * 1.8,
      );
      mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
      this.sceneManager.scene.add(mesh);
      this.spiceShimmerParticles.push({ mesh, life: 0.8 + Math.random() * 0.6, baseY: mesh.position.y });
    }

    // Update existing shimmer particles
    for (let i = this.spiceShimmerParticles.length - 1; i >= 0; i--) {
      const p = this.spiceShimmerParticles[i];
      p.life -= 0.04; // ~1 second at 25 TPS
      if (p.life <= 0) {
        this.sceneManager.scene.remove(p.mesh);
        (p.mesh.material as THREE.Material).dispose();
        this.spiceShimmerParticles.splice(i, 1);
      } else {
        p.mesh.position.y = p.baseY + Math.sin(p.life * 8) * 0.1;
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(0.8, p.life * 2);
        p.mesh.rotation.y += 0.05;
      }
    }
  }

  /** Spawn a ground scorch mark decal at the given position */
  spawnDecal(x: number, z: number, size: 'small' | 'medium' | 'large' = 'medium'): void {
    // Evict oldest decal if at cap
    if (this.decals.length >= EffectsManager.MAX_DECALS) {
      const oldest = this.decals.shift()!;
      this.sceneManager.scene.remove(oldest.mesh);
      (oldest.mesh.material as THREE.Material).dispose();
    }

    // Create decal texture on first use (radial gradient scorch)
    if (!this.decalTexture) {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      gradient.addColorStop(0, 'rgba(20, 15, 10, 0.8)');
      gradient.addColorStop(0.4, 'rgba(30, 20, 10, 0.5)');
      gradient.addColorStop(0.7, 'rgba(40, 30, 15, 0.2)');
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 64, 64);
      this.decalTexture = new THREE.CanvasTexture(canvas);
    }

    const scale = size === 'small' ? 1.5 : size === 'medium' ? 3.0 : 5.0;
    if (!this.decalGeo) this.decalGeo = new THREE.PlaneGeometry(1, 1);

    const mat = new THREE.MeshBasicMaterial({
      map: this.decalTexture,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this.decalGeo, mat);
    mesh.rotation.set(-Math.PI / 2, Math.random() * Math.PI * 2, 0); // Flat on ground with random spin
    mesh.position.set(x, 0.02, z);
    mesh.scale.set(scale, scale, 1);

    this.sceneManager.scene.add(mesh);
    // Decals last 60 seconds (1500 ticks at 25 TPS)
    this.decals.push({ mesh, age: 0, maxAge: 1500 });
  }

  /** Gold star burst for unit promotion */
  spawnPromotionBurst(x: number, y: number, z: number): void {
    const count = 8;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const speed = 2 + Math.random() * 2;
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffd700, transparent: true, opacity: 1.0, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this.promotionGeo, mat);
      mesh.position.set(x, y + 1.5, z);
      this.sceneManager.scene.add(mesh);
      const vx = Math.cos(angle) * speed;
      const vz = Math.sin(angle) * speed;
      this.explosions.push({
        particles: [{
          mesh, velocity: new THREE.Vector3(vx, 3 + Math.random() * 2, vz),
          life: 0.8, maxLife: 0.8, gravity: 6,
        }],
        flash: null, flashLife: 0,
      });
    }
    // Central flash
    const flash = new THREE.PointLight(0xffd700, 8, 10);
    flash.position.set(x, y + 2, z);
    this.sceneManager.scene.add(flash);
    this.explosions.push({ particles: [], flash, flashLife: 0.3 });
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

  /** Show a dashed line from a building to its rally point */
  showRallyLine(buildingX: number, buildingZ: number, rallyX: number, rallyZ: number): void {
    this.hideRallyLine();
    const points = [
      new THREE.Vector3(buildingX, 0.3, buildingZ),
      new THREE.Vector3(rallyX, 0.3, rallyZ),
    ];
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineDashedMaterial({
      color: 0x00ff44,
      dashSize: 1.5,
      gapSize: 0.8,
      linewidth: 1,
      transparent: true,
      opacity: 0.7,
    });
    this.rallyLine = new THREE.Line(geo, mat);
    this.rallyLine.computeLineDistances();
    this.sceneManager.scene.add(this.rallyLine);
  }

  hideRallyLine(): void {
    if (this.rallyLine) {
      this.sceneManager.scene.remove(this.rallyLine);
      this.rallyLine.geometry.dispose();
      (this.rallyLine.material as THREE.Material).dispose();
      this.rallyLine = null;
    }
  }

  // Waypoint path lines per entity
  private waypointLines = new Map<number, THREE.Line>();
  private waypointLineMat = new THREE.LineDashedMaterial({
    color: 0x44ff44,
    dashSize: 1.0,
    gapSize: 0.6,
    transparent: true,
    opacity: 0.6,
  });
  private patrolLineMat = new THREE.LineDashedMaterial({
    color: 0x44aaff,
    dashSize: 1.0,
    gapSize: 0.6,
    transparent: true,
    opacity: 0.6,
  });

  /** Show waypoint path lines for selected units */
  updateWaypointLines(
    selectedEids: number[],
    positions: Map<number, { x: number; z: number }>,
    waypointQueues: Map<number, Array<{ x: number; z: number }>>,
    patrolEntities: Map<number, { startX: number; startZ: number; endX: number; endZ: number }>,
    moveTargets: Map<number, { x: number; z: number; active: boolean }>
  ): void {
    const selectedSet = new Set(selectedEids);

    // Remove lines for entities no longer selected
    for (const [eid, line] of this.waypointLines) {
      if (!selectedSet.has(eid)) {
        this.sceneManager.scene.remove(line);
        line.geometry.dispose();
        this.waypointLines.delete(eid);
      }
    }

    for (const eid of selectedEids) {
      const pos = positions.get(eid);
      if (!pos) continue;

      const queue = waypointQueues.get(eid);
      const patrol = patrolEntities.get(eid);
      const mt = moveTargets.get(eid);

      // Build path: current position -> current move target -> waypoints
      const points: THREE.Vector3[] = [];
      points.push(new THREE.Vector3(pos.x, 0.4, pos.z));

      if (patrol) {
        // Patrol: show patrol path (current pos -> end -> start -> end)
        points.push(new THREE.Vector3(patrol.endX, 0.4, patrol.endZ));
        points.push(new THREE.Vector3(patrol.startX, 0.4, patrol.startZ));
      } else {
        // Regular waypoints
        if (mt && mt.active) {
          points.push(new THREE.Vector3(mt.x, 0.4, mt.z));
        }
        if (queue) {
          for (const wp of queue) {
            points.push(new THREE.Vector3(wp.x, 0.4, wp.z));
          }
        }
      }

      // Need at least 2 points for a line
      if (points.length < 2) {
        const existing = this.waypointLines.get(eid);
        if (existing) {
          this.sceneManager.scene.remove(existing);
          existing.geometry.dispose();
          this.waypointLines.delete(eid);
        }
        continue;
      }

      const isPatrol = !!patrol;
      const existingLine = this.waypointLines.get(eid);

      if (existingLine) {
        // Update existing line geometry
        const newGeo = new THREE.BufferGeometry().setFromPoints(points);
        existingLine.geometry.dispose();
        existingLine.geometry = newGeo;
        existingLine.material = isPatrol ? this.patrolLineMat : this.waypointLineMat;
        existingLine.computeLineDistances();
      } else {
        // Create new line
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const line = new THREE.Line(geo, isPatrol ? this.patrolLineMat : this.waypointLineMat);
        line.computeLineDistances();
        this.sceneManager.scene.add(line);
        this.waypointLines.set(eid, line);
      }
    }
  }

  clearWaypointLines(): void {
    for (const [, line] of this.waypointLines) {
      this.sceneManager.scene.remove(line);
      line.geometry.dispose();
    }
    this.waypointLines.clear();
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
      // Fire flickers between orange and red; reset to grey smoke when healed
      if (isOnFire) {
        const flicker = Math.sin(t * 8 + smoke.phase) * 0.5 + 0.5;
        mat.color.setRGB(1.0, 0.2 + flicker * 0.3, flicker * 0.1);
      } else {
        mat.color.setRGB(0.27, 0.27, 0.27); // 0x444444
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

    // Save and increase fog density for sandstorm atmosphere
    const fog = this.sceneManager.scene.fog as THREE.FogExp2 | null;
    if (fog) {
      this.preSandstormFog = { density: fog.density, color: fog.color.getHex() };
      fog.density = 0.012;
      fog.color.setHex(0xa08040);
    }

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

    // Restore pre-sandstorm fog
    const fog = this.sceneManager.scene.fog as THREE.FogExp2 | null;
    if (fog) {
      fog.density = this.preSandstormFog.density;
      fog.color.setHex(this.preSandstormFog.color);
    }
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

  // --- Ground Splat System (InkVine toxic residue, Death Hand fallout) ---
  private groundSplatVisuals = new Map<string, THREE.Mesh>();
  private groundSplatGeo: THREE.CircleGeometry | null = null;

  private getSplatKey(x: number, z: number): string {
    return `${x.toFixed(1)}_${z.toFixed(1)}`;
  }

  spawnGroundSplat(x: number, z: number, type: string): void {
    if (!this.groundSplatGeo) {
      this.groundSplatGeo = new THREE.CircleGeometry(6, 16); // 6 unit radius = ~3 tiles
    }
    const color = type === 'inkvine' ? 0x44aa22 : 0xaa4400; // Green for inkvine, brown for fallout
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.35,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.groundSplatGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.05, z); // Just above ground
    this.sceneManager.scene.add(mesh);
    this.groundSplatVisuals.set(this.getSplatKey(x, z), mesh);
  }

  fadeGroundSplat(x: number, z: number, alpha: number): void {
    const mesh = this.groundSplatVisuals.get(this.getSplatKey(x, z));
    if (mesh) {
      (mesh.material as THREE.MeshBasicMaterial).opacity = 0.35 * alpha;
    }
  }

  removeGroundSplat(x: number, z: number): void {
    const key = this.getSplatKey(x, z);
    const mesh = this.groundSplatVisuals.get(key);
    if (mesh) {
      this.sceneManager.scene.remove(mesh);
      (mesh.material as THREE.Material).dispose();
      this.groundSplatVisuals.delete(key);
    }
  }

  clearAllGroundSplats(): void {
    for (const mesh of this.groundSplatVisuals.values()) {
      this.sceneManager.scene.remove(mesh);
      (mesh.material as THREE.Material).dispose();
    }
    this.groundSplatVisuals.clear();
  }

  // --- Weapon-Specific Impact Effects ---

  /**
   * Spawn a weapon-specific impact effect at the given position.
   * @param x World X coordinate of impact
   * @param z World Z coordinate of impact
   * @param impactType The classified ImpactType from WeaponDefs
   * @param damage Raw damage value — used to scale the visual size
   */
  spawnWeaponImpact(x: number, z: number, impactType: ImpactType, damage: number): void {
    // Scale factor: small arms ~100-300 dmg = 0.5-0.8, tank shells ~500-1000 = 1.0-1.5
    const scale = Math.min(2.0, Math.max(0.4, damage / 600));

    switch (impactType) {
      case ImpactType.Bullet:
        this.spawnBulletImpact(x, z, scale);
        break;
      case ImpactType.Explosive:
        this.spawnExplosiveImpact(x, z, scale);
        break;
      case ImpactType.Missile:
        this.spawnMissileImpact(x, z, scale);
        break;
      case ImpactType.Sonic:
        this.spawnSonicImpact(x, z, scale);
        break;
      case ImpactType.Laser:
        this.spawnLaserImpact(x, z, scale);
        break;
      case ImpactType.Gas:
        this.spawnGasImpact(x, z, scale);
        break;
      case ImpactType.Electric:
        this.spawnElectricImpact(x, z, scale);
        break;
      case ImpactType.Flame:
        this.spawnFlameImpact(x, z, scale);
        break;
    }
  }

  /** Bullet/kinetic: Small yellow spark, brief flash, tiny dust puff */
  private spawnBulletImpact(x: number, z: number, scale: number): void {
    const particleCount = Math.round(3 * scale);
    const y = 0.3;

    for (let i = 0; i < particleCount; i++) {
      const color = Math.random() > 0.5
        ? new THREE.Color(1.0, 0.9, 0.3) // Yellow spark
        : new THREE.Color(0.8, 0.7, 0.4); // Dust
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
      const mesh = new THREE.Mesh(this.particleGeo, mat);
      mesh.position.set(x, y, z);
      mesh.scale.setScalar(0.1 * scale);
      this.sceneManager.scene.add(mesh);

      const angle = Math.random() * Math.PI * 2;
      const spd = (2 + Math.random() * 3) * scale;
      this.explosions.push({
        particles: [{
          mesh,
          velocity: new THREE.Vector3(
            Math.cos(angle) * spd,
            1.5 + Math.random() * 2,
            Math.sin(angle) * spd
          ),
          life: 0.15 + Math.random() * 0.1,
          maxLife: 0.25,
          gravity: 12,
        }],
        flash: null, flashLife: 0,
      });
    }

    // Quick yellow flash
    const flash = new THREE.PointLight(0xffee44, 2 * scale, 3 * scale);
    flash.position.set(x, y + 0.3, z);
    this.sceneManager.scene.add(flash);
    this.explosions.push({ particles: [], flash, flashLife: 0.06 });
  }

  /** Explosive/HE: Orange fireball with expanding smoke ring, debris particles */
  private spawnExplosiveImpact(x: number, z: number, scale: number): void {
    const particleCount = Math.round(10 * scale);
    const y = 0.2;

    for (let i = 0; i < particleCount; i++) {
      const isFire = Math.random() > 0.35;
      const color = isFire
        ? new THREE.Color(1.0, 0.35 + Math.random() * 0.35, 0.0)
        : new THREE.Color(0.25 + Math.random() * 0.15, 0.2, 0.15); // Dark smoke
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1.0 });
      const mesh = new THREE.Mesh(this.particleGeo, mat);
      mesh.position.set(x, y + 0.5, z);
      const meshScale = (0.15 + Math.random() * 0.25) * scale;
      mesh.scale.setScalar(meshScale);
      this.sceneManager.scene.add(mesh);

      const angle = Math.random() * Math.PI * 2;
      const elevation = Math.random() * Math.PI * 0.4 + 0.3;
      const spd = (4 + Math.random() * 5) * scale;
      this.explosions.push({
        particles: [{
          mesh,
          velocity: new THREE.Vector3(
            Math.cos(angle) * Math.cos(elevation) * spd,
            Math.sin(elevation) * spd * 1.2,
            Math.sin(angle) * Math.cos(elevation) * spd
          ),
          life: (0.4 + Math.random() * 0.4) * scale,
          maxLife: 0.8 * scale,
          gravity: isFire ? 6 : 3,
        }],
        flash: null, flashLife: 0,
      });
    }

    // Bright orange flash
    const flashIntensity = 8 * scale;
    const flash = new THREE.PointLight(0xff6600, flashIntensity, 10 * scale);
    flash.position.set(x, y + 1, z);
    this.sceneManager.scene.add(flash);
    this.explosions.push({ particles: [], flash, flashLife: 0.12 });

    // Ground scorch mark for larger explosions
    if (scale >= 0.7) {
      this.spawnDecal(x, z, scale >= 1.2 ? 'large' : 'medium');
    }
  }

  /** Missile/rocket: Medium explosion with smoke trail lingering at impact point */
  private spawnMissileImpact(x: number, z: number, scale: number): void {
    // Core explosion (smaller than HE but sharper)
    const particleCount = Math.round(7 * scale);
    const y = 0.2;

    for (let i = 0; i < particleCount; i++) {
      const isFire = i < particleCount * 0.6;
      const color = isFire
        ? new THREE.Color(1.0, 0.3 + Math.random() * 0.3, 0.0)
        : new THREE.Color(0.5, 0.45, 0.4); // Lighter grey smoke
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
      const mesh = new THREE.Mesh(this.particleGeo, mat);
      mesh.position.set(x, y + 0.5, z);
      mesh.scale.setScalar((0.12 + Math.random() * 0.2) * scale);
      this.sceneManager.scene.add(mesh);

      const angle = Math.random() * Math.PI * 2;
      const spd = (3 + Math.random() * 4) * scale;
      this.explosions.push({
        particles: [{
          mesh,
          velocity: new THREE.Vector3(
            Math.cos(angle) * spd,
            (2 + Math.random() * 3) * scale,
            Math.sin(angle) * spd
          ),
          life: 0.3 + Math.random() * 0.3,
          maxLife: 0.6,
          gravity: 5,
        }],
        flash: null, flashLife: 0,
      });
    }

    // Lingering smoke column at impact point (3-4 smoke puffs rising)
    for (let i = 0; i < 3; i++) {
      const smokeMat = new THREE.MeshBasicMaterial({
        color: 0x555555, transparent: true, opacity: 0.5, depthWrite: false,
      });
      const smokeMesh = new THREE.Mesh(this.smokeGeo, smokeMat);
      smokeMesh.position.set(
        x + (Math.random() - 0.5) * 0.5 * scale,
        0.3 + i * 0.3,
        z + (Math.random() - 0.5) * 0.5 * scale,
      );
      smokeMesh.scale.setScalar(0.3 * scale);
      this.sceneManager.scene.add(smokeMesh);
      this.dustPuffs.push({ mesh: smokeMesh, life: 1.2 + Math.random() * 0.4, vy: 0.6 + Math.random() * 0.3 });
    }

    // Flash
    const flash = new THREE.PointLight(0xff4400, 6 * scale, 8 * scale);
    flash.position.set(x, y + 0.8, z);
    this.sceneManager.scene.add(flash);
    this.explosions.push({ particles: [], flash, flashLife: 0.1 });

    // Scorch mark
    if (scale >= 0.6) {
      this.spawnDecal(x, z, 'small');
    }
  }

  /** Sonic: Blue/purple ripple wave expanding outward (Atreides sonic tank) */
  private spawnSonicImpact(x: number, z: number, scale: number): void {
    // Expanding ring on the ground
    if (!this.impactRingGeo) {
      this.impactRingGeo = new THREE.RingGeometry(0.3, 0.6, 24);
    }

    // Spawn 2-3 concentric ripples with staggered timing
    const rippleCount = Math.round(2 + scale);
    for (let i = 0; i < rippleCount; i++) {
      const ringGeo = new THREE.RingGeometry(0.2 + i * 0.15, 0.5 + i * 0.15, 24);
      ringGeo.rotateX(-Math.PI / 2);
      const color = i % 2 === 0 ? 0x6644ff : 0x4488ff; // Alternate blue/purple
      const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false,
      });
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.position.set(x, 0.15, z);
      mesh.scale.set(0.2, 0.2, 1);
      this.sceneManager.scene.add(mesh);

      const maxScale = (3 + scale * 2) * (1 + i * 0.3);
      const life = 0.4 + i * 0.1;
      this.sonicRipples.push({ mesh, life, maxLife: life, maxScale });
    }

    // Brief blue-purple flash
    const flash = new THREE.PointLight(0x6644ff, 4 * scale, 6 * scale);
    flash.position.set(x, 0.8, z);
    this.sceneManager.scene.add(flash);
    this.explosions.push({ particles: [], flash, flashLife: 0.1 });

    // A few shimmering particles
    for (let i = 0; i < Math.round(4 * scale); i++) {
      const color = new THREE.Color(0.4 + Math.random() * 0.3, 0.3, 0.8 + Math.random() * 0.2);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 });
      const mesh = new THREE.Mesh(this.particleGeo, mat);
      mesh.position.set(x, 0.5, z);
      mesh.scale.setScalar(0.08 * scale);
      this.sceneManager.scene.add(mesh);

      const angle = Math.random() * Math.PI * 2;
      const spd = (3 + Math.random() * 2) * scale;
      this.explosions.push({
        particles: [{
          mesh,
          velocity: new THREE.Vector3(Math.cos(angle) * spd, 0.5 + Math.random(), Math.sin(angle) * spd),
          life: 0.3 + Math.random() * 0.2,
          maxLife: 0.5,
          gravity: 2,
        }],
        flash: null, flashLife: 0,
      });
    }
  }

  /** Laser: Red/green flash with brief beam glow at impact */
  private spawnLaserImpact(x: number, z: number, scale: number): void {
    const y = 0.5;
    const particleCount = Math.round(4 * scale);

    // Bright red/green spark particles that scatter quickly
    for (let i = 0; i < particleCount; i++) {
      const isRed = Math.random() > 0.3;
      const color = isRed
        ? new THREE.Color(1.0, 0.1 + Math.random() * 0.2, 0.0)
        : new THREE.Color(0.0, 0.8 + Math.random() * 0.2, 0.1);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1.0 });
      const mesh = new THREE.Mesh(this.particleGeo, mat);
      mesh.position.set(x, y, z);
      mesh.scale.setScalar(0.06 * scale);
      this.sceneManager.scene.add(mesh);

      const angle = Math.random() * Math.PI * 2;
      const spd = (5 + Math.random() * 4) * scale;
      this.explosions.push({
        particles: [{
          mesh,
          velocity: new THREE.Vector3(Math.cos(angle) * spd, 2 + Math.random() * 3, Math.sin(angle) * spd),
          life: 0.1 + Math.random() * 0.1,
          maxLife: 0.2,
          gravity: 15,
        }],
        flash: null, flashLife: 0,
      });
    }

    // Bright flash — red tinted
    const flash = new THREE.PointLight(0xff2200, 5 * scale, 5 * scale);
    flash.position.set(x, y, z);
    this.sceneManager.scene.add(flash);
    this.explosions.push({ particles: [], flash, flashLife: 0.08 });

    // Brief impact glow (emissive sphere that fades fast)
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xff4422, transparent: true, opacity: 0.8, depthWrite: false,
    });
    const glowMesh = new THREE.Mesh(this.particleGeo, glowMat);
    glowMesh.position.set(x, y, z);
    glowMesh.scale.setScalar(0.5 * scale);
    this.sceneManager.scene.add(glowMesh);
    this.explosions.push({
      particles: [{
        mesh: glowMesh,
        velocity: new THREE.Vector3(0, 0.2, 0),
        life: 0.12,
        maxLife: 0.12,
        gravity: 0,
      }],
      flash: null, flashLife: 0,
    });
  }

  /** Gas/chemical: Green cloud that lingers 1-2 seconds (Tleilaxu) */
  private spawnGasImpact(x: number, z: number, scale: number): void {
    // Cap lingering effects to prevent performance issues
    if (this.lingeringImpacts.length > 20) return;

    const meshes: THREE.Mesh[] = [];
    const cloudCount = Math.round(4 * scale);
    const life = 1.5 + scale * 0.5;

    for (let i = 0; i < cloudCount; i++) {
      const green = 0.5 + Math.random() * 0.3;
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(0.15, green, 0.1),
        transparent: true, opacity: 0.5, depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.smokeGeo, mat);
      mesh.position.set(
        x + (Math.random() - 0.5) * 1.5 * scale,
        0.3 + Math.random() * 0.5,
        z + (Math.random() - 0.5) * 1.5 * scale,
      );
      mesh.scale.setScalar((0.4 + Math.random() * 0.3) * scale);
      this.sceneManager.scene.add(mesh);
      meshes.push(mesh);
    }

    this.lingeringImpacts.push({ meshes, life, maxLife: life, type: ImpactType.Gas });

    // Initial puff burst
    const flash = new THREE.PointLight(0x22aa22, 3 * scale, 5 * scale);
    flash.position.set(x, 0.8, z);
    this.sceneManager.scene.add(flash);
    this.explosions.push({ particles: [], flash, flashLife: 0.15 });
  }

  /** Electric: Blue-white sparks arcing outward (Ix weapons, Ordos Berserk) */
  private spawnElectricImpact(x: number, z: number, scale: number): void {
    const y = 0.5;
    const arcCount = Math.round(4 * scale);

    // Spawn jagged arc lines radiating outward
    for (let i = 0; i < arcCount; i++) {
      const angle = (i / arcCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
      const length = (1.5 + Math.random() * 2.0) * scale;
      const segments = 4 + Math.floor(Math.random() * 3);
      const points: THREE.Vector3[] = [];

      for (let s = 0; s <= segments; s++) {
        const t = s / segments;
        const px = x + Math.cos(angle) * length * t + (s > 0 && s < segments ? (Math.random() - 0.5) * 0.4 * scale : 0);
        const py = y + Math.sin(t * Math.PI) * 0.6 * scale + (Math.random() - 0.5) * 0.2;
        const pz = z + Math.sin(angle) * length * t + (s > 0 && s < segments ? (Math.random() - 0.5) * 0.4 * scale : 0);
        points.push(new THREE.Vector3(px, py, pz));
      }

      const geo = new THREE.BufferGeometry().setFromPoints(points);
      const isWhite = Math.random() > 0.4;
      const color = isWhite ? 0xddddff : 0x4488ff;
      const mat = new THREE.LineBasicMaterial({
        color, transparent: true, opacity: 0.9, linewidth: 2,
      });
      const line = new THREE.Line(geo, mat);
      this.sceneManager.scene.add(line);
      this.electricArcs.push({ line, life: 0.15 + Math.random() * 0.15 });
    }

    // Spark particles
    for (let i = 0; i < Math.round(5 * scale); i++) {
      const color = new THREE.Color(0.6 + Math.random() * 0.4, 0.7 + Math.random() * 0.3, 1.0);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1.0 });
      const mesh = new THREE.Mesh(this.particleGeo, mat);
      mesh.position.set(x, y, z);
      mesh.scale.setScalar(0.06 * scale);
      this.sceneManager.scene.add(mesh);

      const ang = Math.random() * Math.PI * 2;
      const spd = (4 + Math.random() * 5) * scale;
      this.explosions.push({
        particles: [{
          mesh,
          velocity: new THREE.Vector3(Math.cos(ang) * spd, 2 + Math.random() * 3, Math.sin(ang) * spd),
          life: 0.15 + Math.random() * 0.15,
          maxLife: 0.3,
          gravity: 10,
        }],
        flash: null, flashLife: 0,
      });
    }

    // Bright blue-white flash
    const flash = new THREE.PointLight(0x88aaff, 6 * scale, 7 * scale);
    flash.position.set(x, y, z);
    this.sceneManager.scene.add(flash);
    this.explosions.push({ particles: [], flash, flashLife: 0.1 });
  }

  /** Flame: Persistent ground fire effect for 1-2 seconds */
  private spawnFlameImpact(x: number, z: number, scale: number): void {
    // Cap lingering effects
    if (this.lingeringImpacts.length > 20) return;

    const meshes: THREE.Mesh[] = [];
    const flameCount = Math.round(3 * scale);
    const life = 1.2 + scale * 0.5;

    for (let i = 0; i < flameCount; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(1.0, 0.4 + Math.random() * 0.2, 0.05),
        transparent: true, opacity: 0.6, depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.smokeGeo, mat);
      mesh.position.set(
        x + (Math.random() - 0.5) * 1.0 * scale,
        0.2,
        z + (Math.random() - 0.5) * 1.0 * scale,
      );
      mesh.scale.setScalar((0.25 + Math.random() * 0.2) * scale);
      this.sceneManager.scene.add(mesh);
      meshes.push(mesh);
    }

    this.lingeringImpacts.push({ meshes, life, maxLife: life, type: ImpactType.Flame });

    // Initial burst of fire particles shooting upward
    for (let i = 0; i < Math.round(5 * scale); i++) {
      const color = new THREE.Color(1.0, 0.2 + Math.random() * 0.4, 0.0);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
      const mesh = new THREE.Mesh(this.particleGeo, mat);
      mesh.position.set(x, 0.3, z);
      mesh.scale.setScalar(0.1 * scale);
      this.sceneManager.scene.add(mesh);

      const angle = Math.random() * Math.PI * 2;
      const spd = (1.5 + Math.random() * 2) * scale;
      this.explosions.push({
        particles: [{
          mesh,
          velocity: new THREE.Vector3(Math.cos(angle) * spd, 3 + Math.random() * 3, Math.sin(angle) * spd),
          life: 0.3 + Math.random() * 0.2,
          maxLife: 0.5,
          gravity: 4,
        }],
        flash: null, flashLife: 0,
      });
    }

    // Orange flash
    const flash = new THREE.PointLight(0xff6600, 5 * scale, 6 * scale);
    flash.position.set(x, 0.5, z);
    this.sceneManager.scene.add(flash);
    this.explosions.push({ particles: [], flash, flashLife: 0.12 });

    // Scorch decal
    this.spawnDecal(x, z, 'small');
  }

  // --- Death Animation Variant Effects ---

  /** Dissolve/melt death: green particles rising and dissolving (Tleilaxu gas/contaminator) */
  spawnDissolveEffect(x: number, y: number, z: number): void {
    const particleCount = 15;
    const particles: ParticleEffect[] = [];

    for (let i = 0; i < particleCount; i++) {
      const green = 0.3 + Math.random() * 0.7;
      const color = new THREE.Color(0.1, green, 0.05);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
      const mesh = new THREE.Mesh(this.particleGeo, mat);
      mesh.position.set(
        x + (Math.random() - 0.5) * 1.5,
        y + Math.random() * 0.5,
        z + (Math.random() - 0.5) * 1.5,
      );
      const scale = 0.15 + Math.random() * 0.25;
      mesh.scale.setScalar(scale);
      this.sceneManager.scene.add(mesh);

      // Dissolve particles rise slowly and drift outward
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.5 + Math.random() * 1.5;
      particles.push({
        mesh,
        velocity: new THREE.Vector3(
          Math.cos(angle) * speed * 0.3,
          1.5 + Math.random() * 2.0,
          Math.sin(angle) * speed * 0.3,
        ),
        life: 1.0 + Math.random() * 0.8,
        maxLife: 1.5,
        gravity: -0.5, // Negative gravity = float upward
      });
    }

    // Sickly green flash
    const flash = new THREE.PointLight(0x44ff22, 4, 8);
    flash.position.set(x, y + 1, z);
    this.sceneManager.scene.add(flash);

    this.explosions.push({ particles, flash, flashLife: 0.3 });
  }

  /** Burn death: fire particles, charred remains (flame weapons) */
  spawnBurnEffect(x: number, y: number, z: number): void {
    const particleCount = 12;
    const particles: ParticleEffect[] = [];

    for (let i = 0; i < particleCount; i++) {
      const isFire = Math.random() > 0.3;
      const color = isFire
        ? new THREE.Color(1.0, 0.2 + Math.random() * 0.5, 0.0)
        : new THREE.Color(0.15, 0.15, 0.15);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1.0 });
      const mesh = new THREE.Mesh(this.particleGeo, mat);
      mesh.position.set(
        x + (Math.random() - 0.5) * 1.0,
        y + 0.3,
        z + (Math.random() - 0.5) * 1.0,
      );
      const scale = 0.15 + Math.random() * 0.3;
      mesh.scale.setScalar(scale);
      this.sceneManager.scene.add(mesh);

      const angle = Math.random() * Math.PI * 2;
      const speed = isFire ? 1.0 + Math.random() * 2.0 : 0.3 + Math.random() * 0.8;
      particles.push({
        mesh,
        velocity: new THREE.Vector3(
          Math.cos(angle) * speed * 0.4,
          (isFire ? 3.0 : 1.5) + Math.random() * 2.0,
          Math.sin(angle) * speed * 0.4,
        ),
        life: isFire ? 0.6 + Math.random() * 0.4 : 1.0 + Math.random() * 0.6,
        maxLife: isFire ? 0.8 : 1.2,
        gravity: isFire ? 1.0 : 0.5,
      });
    }

    // Warm orange flash
    const flash = new THREE.PointLight(0xff4400, 5, 10);
    flash.position.set(x, y + 1, z);
    this.sceneManager.scene.add(flash);

    this.explosions.push({ particles, flash, flashLife: 0.25 });
  }

  /** Electrify death: blue-white electric sparks arcing outward (Ix/electric weapons) */
  spawnElectrifyEffect(x: number, y: number, z: number): void {
    const particleCount = 10;
    const particles: ParticleEffect[] = [];

    for (let i = 0; i < particleCount; i++) {
      const isArc = Math.random() > 0.4;
      const color = isArc
        ? new THREE.Color(0.5 + Math.random() * 0.5, 0.7 + Math.random() * 0.3, 1.0)
        : new THREE.Color(0.2, 0.4, 1.0);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1.0 });
      const mesh = new THREE.Mesh(this.particleGeo, mat);
      mesh.position.set(
        x + (Math.random() - 0.5) * 0.8,
        y + 0.5 + Math.random() * 1.0,
        z + (Math.random() - 0.5) * 0.8,
      );
      const scale = 0.1 + Math.random() * 0.15;
      mesh.scale.setScalar(scale);
      this.sceneManager.scene.add(mesh);

      // Electric sparks: fast, erratic movement
      const angle = Math.random() * Math.PI * 2;
      const speed = 4 + Math.random() * 6;
      particles.push({
        mesh,
        velocity: new THREE.Vector3(
          Math.cos(angle) * speed,
          2 + Math.random() * 4,
          Math.sin(angle) * speed,
        ),
        life: 0.2 + Math.random() * 0.3,
        maxLife: 0.4,
        gravity: 12 + Math.random() * 6,
      });
    }

    // Bright blue-white flash
    const flash = new THREE.PointLight(0x88aaff, 8, 12);
    flash.position.set(x, y + 1.5, z);
    this.sceneManager.scene.add(flash);

    this.explosions.push({ particles, flash, flashLife: 0.12 });
  }

  /** Crush death: quick flat splat with minimal particles (vehicle runs over infantry) */
  spawnCrushEffect(x: number, y: number, z: number): void {
    const particles: ParticleEffect[] = [];

    for (let i = 0; i < 5; i++) {
      const color = Math.random() > 0.5
        ? new THREE.Color(0.6, 0.1, 0.05)
        : new THREE.Color(0.5, 0.4, 0.2);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
      const mesh = new THREE.Mesh(this.particleGeo, mat);
      mesh.position.set(x, y + 0.1, z);
      const scale = 0.1 + Math.random() * 0.15;
      mesh.scale.setScalar(scale);
      this.sceneManager.scene.add(mesh);

      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 3;
      particles.push({
        mesh,
        velocity: new THREE.Vector3(
          Math.cos(angle) * speed,
          0.5 + Math.random() * 1.0,
          Math.sin(angle) * speed,
        ),
        life: 0.3 + Math.random() * 0.2,
        maxLife: 0.4,
        gravity: 15,
      });
    }

    this.explosions.push({ particles, flash: null, flashLife: 0 });
  }

  /** Big explosion death: multi-stage explosion for heavy vehicles/buildings */
  spawnBigExplosionEffect(x: number, y: number, z: number): void {
    // Primary large explosion
    this.spawnExplosion(x, y, z, 'large');

    // Secondary explosions at offset positions
    const offsets = [
      { dx: 1.5, dz: 0.8 },
      { dx: -1.0, dz: 1.2 },
      { dx: 0.5, dz: -1.5 },
    ];
    for (const off of offsets) {
      this.spawnExplosion(x + off.dx, y + Math.random() * 0.5, z + off.dz, 'medium');
    }
  }

  /** Spawn a burning wreck that lingers and fades (medium vehicles) */
  spawnBurningWreck(x: number, y: number, z: number): void {
    const hullGeo = new THREE.BoxGeometry(
      1.2 + Math.random() * 0.5,
      0.4,
      0.8 + Math.random() * 0.4,
    );
    const hullMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a, transparent: true, opacity: 1.0 });
    const hullMesh = new THREE.Mesh(hullGeo, hullMat);
    hullMesh.position.set(x, y + 0.2, z);
    hullMesh.rotation.y = Math.random() * Math.PI * 2;
    this.sceneManager.scene.add(hullMesh);
    // Wreck lasts 100 ticks = 4 seconds, then fades for 25 more ticks
    this.wreckages.push({ mesh: hullMesh, age: 0, maxAge: 125 });

    // Spawn initial explosion
    this.spawnExplosion(x, y + 0.5, z, 'medium');
  }
}
