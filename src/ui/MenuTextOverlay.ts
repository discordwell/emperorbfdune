import * as THREE from 'three';

interface Label {
  element: HTMLDivElement;
  worldPos: THREE.Vector3;
}

export class MenuTextOverlay {
  private container: HTMLDivElement;
  private labels = new Map<string, Label>();

  constructor() {
    this.container = document.createElement('div');
    this.container.style.cssText = `
      position:fixed;top:0;left:0;right:0;bottom:0;
      pointer-events:none;z-index:2001;overflow:hidden;
    `;
    document.body.appendChild(this.container);
  }

  addLabel(id: string, text: string, worldPos: THREE.Vector3, style?: Partial<CSSStyleDeclaration>): void {
    const el = document.createElement('div');
    el.style.cssText = `
      position:absolute;
      color:#d4a840;font-family:'Segoe UI',Tahoma,sans-serif;
      font-size:14px;text-align:center;
      transform:translate(-50%,-50%);
      text-shadow:0 0 8px rgba(0,0,0,0.8);
      white-space:nowrap;
    `;
    if (style) {
      for (const [key, value] of Object.entries(style)) {
        (el.style as any)[key] = value;
      }
    }
    el.textContent = text;
    this.container.appendChild(el);
    this.labels.set(id, { element: el, worldPos: worldPos.clone() });
  }

  removeLabel(id: string): void {
    const label = this.labels.get(id);
    if (label) {
      label.element.remove();
      this.labels.delete(id);
    }
  }

  updatePositions(camera: THREE.PerspectiveCamera): void {
    for (const label of this.labels.values()) {
      const v = label.worldPos.clone().project(camera);
      if (v.z > 1) {
        // Behind camera
        label.element.style.display = 'none';
        continue;
      }
      label.element.style.display = '';
      const x = (v.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-v.y * 0.5 + 0.5) * window.innerHeight;
      label.element.style.left = `${x}px`;
      label.element.style.top = `${y}px`;
    }
  }

  dispose(): void {
    this.container.remove();
    this.labels.clear();
  }
}
