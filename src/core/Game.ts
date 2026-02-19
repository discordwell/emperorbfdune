import { createGameWorld, getWorld, type World } from './ECS';
import { EventBus } from './EventBus';

const TICK_RATE = 25; // 25 simulation ticks per second (matches original game)
const TICK_INTERVAL = 1000 / TICK_RATE; // 40ms per tick

export interface GameSystem {
  init?(world: World): void;
  update(world: World, dt: number): void;
}

export interface RenderSystem {
  init?(): void;
  render(alpha: number): void;
  dispose?(): void;
}

export class Game {
  private world!: World;
  private systems: GameSystem[] = [];
  private renderSystems: RenderSystem[] = [];

  private running = false;
  private paused = false;
  private tickCount = 0;
  private accumulator = 0;
  private lastTime = 0;
  private speedMultiplier = 1.0;

  // FPS tracking
  private frameCount = 0;
  private fpsTime = 0;
  private currentFps = 0;
  private currentTps = 0;
  private ticksThisSecond = 0;

  private fpsElement: HTMLElement | null = null;
  private timerElement: HTMLElement | null = null;

  init(): void {
    this.world = createGameWorld();
    this.fpsElement = document.getElementById('fps-counter');
    this.timerElement = document.getElementById('game-timer');

    // Initialize all systems
    for (const sys of this.systems) {
      sys.init?.(this.world);
    }
    for (const rs of this.renderSystems) {
      rs.init?.();
    }
  }

  addSystem(system: GameSystem): void {
    this.systems.push(system);
  }

  addRenderSystem(system: RenderSystem): void {
    this.renderSystems.push(system);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.fpsTime = this.lastTime;
    EventBus.emit('game:started', {});
    this.loop(this.lastTime);
  }

  pause(): void {
    this.paused = !this.paused;
    if (this.paused) {
      EventBus.emit('game:paused', {});
    }
  }

  setSpeed(multiplier: number): void {
    this.speedMultiplier = Math.max(0.5, Math.min(3.0, multiplier));
  }

  getSpeed(): number {
    return this.speedMultiplier;
  }

  isPaused(): boolean {
    return this.paused;
  }

  getWorld(): World {
    return this.world;
  }

  getTickCount(): number {
    return this.tickCount;
  }

  setTickCount(count: number): void {
    this.tickCount = count;
  }

  private loop = (now: number): void => {
    if (!this.running) return;
    requestAnimationFrame(this.loop);

    const elapsed = now - this.lastTime;
    this.lastTime = now;

    // Cap elapsed to prevent spiral of death after tab switch
    const capped = Math.min(elapsed, 200);

    if (!this.paused) {
      this.accumulator += capped * this.speedMultiplier;

      // Fixed timestep simulation
      while (this.accumulator >= TICK_INTERVAL && !this.paused) {
        this.tick();
        this.accumulator -= TICK_INTERVAL;
      }
    }

    // Render with interpolation alpha
    const alpha = this.accumulator / TICK_INTERVAL;
    for (const rs of this.renderSystems) {
      rs.render(alpha);
    }

    // FPS counter
    this.frameCount++;
    if (now - this.fpsTime >= 1000) {
      this.currentFps = this.frameCount;
      this.currentTps = this.ticksThisSecond;
      this.frameCount = 0;
      this.ticksThisSecond = 0;
      this.fpsTime = now;
      if (this.fpsElement) {
        const speedStr = this.speedMultiplier !== 1.0 ? ` | ${this.speedMultiplier}x` : '';
        this.fpsElement.textContent = `${this.currentFps} FPS | ${this.currentTps} TPS${speedStr}`;
      }
      if (this.timerElement) {
        const totalSeconds = Math.floor(this.tickCount / 25);
        const m = Math.floor(totalSeconds / 60);
        const s = totalSeconds % 60;
        this.timerElement.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      }
    }
  };

  private tick(): void {
    this.tickCount++;
    this.ticksThisSecond++;

    for (const sys of this.systems) {
      sys.update(this.world, TICK_INTERVAL);
    }

    EventBus.emit('game:tick', { tick: this.tickCount });
  }
}

export const TICK_MS = TICK_INTERVAL;
export { TICK_RATE };
