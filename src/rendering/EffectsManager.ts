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

interface Projectile {
  mesh: THREE.Mesh;
  start: THREE.Vector3;
  end: THREE.Vector3;
  progress: number; // 0-1
  speed: number; // units per second
  onHit: (() => void) | null;
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
  private wreckages: THREE.Mesh[] = [];
  private wormVisuals = new Map<number, WormVisual>();
  // Rally point markers per player
  private rallyMarkers = new Map<number, THREE.Group>();
  // Building damage smoke/fire effects: eid -> array of smoke meshes
  private buildingDamageEffects = new Map<number, DamageSmoke[]>();
  // Sandstorm overlay
  private sandstormParticles: THREE.Mesh[] = [];
  private sandstormActive = false;

  // Shared geometry for particles
  private particleGeo: THREE.SphereGeometry;
  private projectileGeo: THREE.SphereGeometry;
  private wormRingGeo: THREE.RingGeometry;
  private wormDustGeo: THREE.SphereGeometry;
  private wormTrailGeo: THREE.SphereGeometry;
  private smokeGeo: THREE.SphereGeometry;

  constructor(sceneManager: SceneManager) {
    this.sceneManager = sceneManager;
    this.particleGeo = new THREE.SphereGeometry(0.15, 4, 4);
    this.projectileGeo = new THREE.SphereGeometry(0.1, 4, 4);
    this.wormRingGeo = new THREE.RingGeometry(1.5, 3.0, 16);
    this.wormDustGeo = new THREE.SphereGeometry(0.3, 4, 4);
    this.wormTrailGeo = new THREE.SphereGeometry(0.2, 3, 3);
    this.smokeGeo = new THREE.SphereGeometry(0.4, 5, 5);
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
  ): void {
    const mat = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(this.projectileGeo, mat);
    mesh.position.set(fromX, fromY + 1, fromZ);
    this.sceneManager.scene.add(mesh);

    this.projectiles.push({
      mesh,
      start: new THREE.Vector3(fromX, fromY + 1, fromZ),
      end: new THREE.Vector3(toX, toY + 1, toZ),
      progress: 0,
      speed,
      onHit: onHit ?? null,
    });
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

      // Ring color: orange when hunting, sandy when roaming
      const ringMat = vis.ringMesh.material as THREE.MeshBasicMaterial;
      if (isHunting) {
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
        if (proj.onHit) proj.onHit();
        // Small impact flash
        this.spawnExplosion(proj.end.x, proj.end.y - 1, proj.end.z, 'small');
        this.projectiles.splice(i, 1);
      } else {
        // Interpolate position with arc
        proj.mesh.position.lerpVectors(proj.start, proj.end, proj.progress);
        // Add parabolic arc
        const arc = Math.sin(proj.progress * Math.PI) * dist * 0.1;
        proj.mesh.position.y += arc;
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

    // Sandstorm particles
    this.updateSandstormParticles(dt);
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
