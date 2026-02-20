/**
 * PauseMenu - Handles the in-game pause menu, settings, save/load, and mentat panels.
 * Extracted from index.ts to reduce main file complexity.
 */

import type { GameRules } from '../config/RulesParser';
import type { AudioManager } from '../audio/AudioManager';
import type { SelectionPanel } from './SelectionPanel';
import { MentatScreen } from './MentatScreen';

export interface PauseMenuDeps {
  audioManager: AudioManager;
  selectionPanel: SelectionPanel;
  gameRules: GameRules;
  getTickCount: () => number;
  setSpeed: (speed: number) => void;
  pause: () => void;
  buildSaveData: () => unknown;
  setScrollSpeed?: (multiplier: number) => void;
  setFogEnabled?: (enabled: boolean) => void;
  isFogEnabled?: () => boolean;
  setDamageNumbers?: (enabled: boolean) => void;
  isDamageNumbers?: () => boolean;
  setRangeCircles?: (enabled: boolean) => void;
  isRangeCircles?: () => boolean;
}

export class PauseMenu {
  private deps: PauseMenuDeps;
  private overlay: HTMLDivElement | null = null;
  /** Tracks whether the pause menu itself triggered the pause (vs F9 manual pause) */
  pausedByMenu = false;

  constructor(deps: PauseMenuDeps) {
    this.deps = deps;
    // Restore persisted settings
    let saved: any = {};
    try { saved = JSON.parse(localStorage.getItem('ebfd_settings') ?? '{}'); } catch { /* corrupted settings */ }
    if (saved.musicVol !== undefined) deps.audioManager.setMusicVolume(saved.musicVol);
    if (saved.sfxVol !== undefined) deps.audioManager.setSfxVolume(saved.sfxVol);
    if (saved.scrollSpeed !== undefined) deps.setScrollSpeed?.(saved.scrollSpeed);
    if (saved.fogEnabled !== undefined) deps.setFogEnabled?.(saved.fogEnabled);
    if (saved.damageNumbers !== undefined) deps.setDamageNumbers?.(saved.damageNumbers);
    if (saved.rangeCircles !== undefined) deps.setRangeCircles?.(saved.rangeCircles);
  }

  get isOpen(): boolean {
    return this.overlay !== null;
  }

  show(): void {
    if (this.overlay) return;
    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position:fixed;top:0;left:0;right:0;bottom:0;
      background:rgba(0,0,0,0.8);display:flex;flex-direction:column;
      align-items:center;justify-content:center;z-index:900;
      font-family:'Segoe UI',Tahoma,sans-serif;
    `;

    const elapsed = Math.floor(this.deps.getTickCount() / 25);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;

    this.overlay.innerHTML = `
      <div style="color:#d4a840;font-size:36px;font-weight:bold;margin-bottom:8px;">PAUSED</div>
      <div style="color:#888;font-size:14px;margin-bottom:32px;">Game Time: ${mins}:${secs.toString().padStart(2, '0')}</div>
    `;

    const buttons = [
      { label: 'Resume', action: () => { this.close(); this.deps.pause(); } },
      { label: 'Mentat', action: () => this.showMentat() },
      { label: 'Settings', action: () => this.showSettings() },
      { label: 'Save / Load', action: () => this.showSaveLoad() },
      { label: 'Restart Mission', action: () => { window.location.reload(); } },
      { label: 'Quit to Menu', action: () => {
        localStorage.removeItem('ebfd_campaign_next');
        localStorage.removeItem('ebfd_load');
        localStorage.removeItem('ebfd_load_data');
        window.location.reload();
      }},
    ];

    for (const { label, action } of buttons) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = 'display:block;width:200px;padding:10px;margin:4px;background:#1a1a3e;border:1px solid #444;color:#ccc;cursor:pointer;font-size:14px;';
      btn.onmouseenter = () => { btn.style.borderColor = '#88f'; btn.style.color = '#fff'; };
      btn.onmouseleave = () => { btn.style.borderColor = '#444'; btn.style.color = '#ccc'; };
      btn.onclick = action;
      this.overlay.appendChild(btn);
    }

    document.body.appendChild(this.overlay);
  }

  close(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  private showSaveLoad(): void {
    if (!this.overlay) return;
    this.overlay.innerHTML = '';

    const panel = document.createElement('div');
    panel.style.cssText = 'background:#1a1a3e;border:1px solid #555;padding:24px 32px;border-radius:4px;min-width:360px;';

    const title = document.createElement('div');
    title.textContent = 'SAVE / LOAD';
    title.style.cssText = 'color:#d4a840;font-size:24px;font-weight:bold;text-align:center;margin-bottom:20px;';
    panel.appendChild(title);

    const slotKeys = ['ebfd_save', 'ebfd_save_2', 'ebfd_save_3'];
    const slotLabels = ['Slot 1 (F5)', 'Slot 2', 'Slot 3'];

    for (let i = 0; i < slotKeys.length; i++) {
      const key = slotKeys[i];
      const raw = localStorage.getItem(key);
      const timeKey = key + '_time';
      const timeStr = localStorage.getItem(timeKey) ?? '';
      const hasSave = !!raw;

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';

      const label = document.createElement('div');
      label.style.cssText = 'color:#ccc;font-size:13px;flex:1;';
      label.textContent = hasSave ? `${slotLabels[i]} — ${timeStr}` : `${slotLabels[i]} — Empty`;
      row.appendChild(label);

      const saveBtn = document.createElement('button');
      saveBtn.textContent = 'Save';
      saveBtn.style.cssText = 'padding:4px 12px;background:#1a3e1a;border:1px solid #4a4;color:#ccc;cursor:pointer;font-size:12px;';
      saveBtn.onmouseenter = () => { saveBtn.style.borderColor = '#8f8'; };
      saveBtn.onmouseleave = () => { saveBtn.style.borderColor = '#4a4'; };
      saveBtn.onclick = () => {
        const data = this.deps.buildSaveData();
        localStorage.setItem(key, JSON.stringify(data));
        localStorage.setItem(timeKey, new Date().toLocaleString());
        this.deps.selectionPanel.addMessage(`Saved to ${slotLabels[i]}`, '#44ff44');
        this.showSaveLoad(); // Refresh
      };
      row.appendChild(saveBtn);

      const loadBtn = document.createElement('button');
      loadBtn.textContent = 'Load';
      loadBtn.style.cssText = `padding:4px 12px;background:#1a1a3e;border:1px solid ${hasSave ? '#44f' : '#333'};color:${hasSave ? '#ccc' : '#555'};cursor:${hasSave ? 'pointer' : 'default'};font-size:12px;`;
      if (hasSave) {
        loadBtn.onmouseenter = () => { loadBtn.style.borderColor = '#88f'; };
        loadBtn.onmouseleave = () => { loadBtn.style.borderColor = '#44f'; };
        loadBtn.onclick = () => {
          localStorage.setItem('ebfd_load_data', raw!);
          localStorage.setItem('ebfd_load', '1');
          window.location.reload();
        };
      }
      row.appendChild(loadBtn);

      panel.appendChild(row);
    }

    // Autosave slot
    const autoRaw = localStorage.getItem('ebfd_autosave');
    const autoTime = localStorage.getItem('ebfd_autosave_time') ?? '';
    const hasAuto = !!autoRaw;

    const autoRow = document.createElement('div');
    autoRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid #333;';

    const autoLabel = document.createElement('div');
    autoLabel.style.cssText = 'color:#888;font-size:13px;flex:1;';
    autoLabel.textContent = hasAuto ? `Autosave — ${autoTime}` : 'Autosave — None';
    autoRow.appendChild(autoLabel);

    const autoLoadBtn = document.createElement('button');
    autoLoadBtn.textContent = 'Load';
    autoLoadBtn.style.cssText = `padding:4px 12px;background:#1a1a3e;border:1px solid ${hasAuto ? '#44f' : '#333'};color:${hasAuto ? '#ccc' : '#555'};cursor:${hasAuto ? 'pointer' : 'default'};font-size:12px;`;
    if (hasAuto) {
      autoLoadBtn.onmouseenter = () => { autoLoadBtn.style.borderColor = '#88f'; };
      autoLoadBtn.onmouseleave = () => { autoLoadBtn.style.borderColor = '#44f'; };
      autoLoadBtn.onclick = () => {
        localStorage.setItem('ebfd_load_data', autoRaw!);
        localStorage.setItem('ebfd_load', '1');
        window.location.reload();
      };
    }
    autoRow.appendChild(autoLoadBtn);
    panel.appendChild(autoRow);

    // Export/Import section
    const ioRow = document.createElement('div');
    ioRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid #333;';

    const ioLabel = document.createElement('div');
    ioLabel.style.cssText = 'color:#888;font-size:13px;flex:1;';
    ioLabel.textContent = 'File Transfer';
    ioRow.appendChild(ioLabel);

    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Export';
    exportBtn.style.cssText = 'padding:4px 12px;background:#2a2a1a;border:1px solid #aa8;color:#ccc;cursor:pointer;font-size:12px;';
    exportBtn.onmouseenter = () => { exportBtn.style.borderColor = '#dd8'; };
    exportBtn.onmouseleave = () => { exportBtn.style.borderColor = '#aa8'; };
    exportBtn.onclick = () => {
      const data = this.deps.buildSaveData();
      const json = JSON.stringify(data);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ebfd-save-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.deps.selectionPanel.addMessage('Save exported', '#dd8');
    };
    ioRow.appendChild(exportBtn);

    const importBtn = document.createElement('button');
    importBtn.textContent = 'Import';
    importBtn.style.cssText = 'padding:4px 12px;background:#1a1a2a;border:1px solid #88a;color:#ccc;cursor:pointer;font-size:12px;';
    importBtn.onmouseenter = () => { importBtn.style.borderColor = '#aaf'; };
    importBtn.onmouseleave = () => { importBtn.style.borderColor = '#88a'; };
    importBtn.onclick = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const text = reader.result as string;
            JSON.parse(text); // Validate JSON
            localStorage.setItem('ebfd_load_data', text);
            localStorage.setItem('ebfd_load', '1');
            window.location.reload();
          } catch {
            this.deps.selectionPanel.addMessage('Invalid save file', '#ff4444');
          }
        };
        reader.readAsText(file);
      };
      input.click();
    };
    ioRow.appendChild(importBtn);

    panel.appendChild(ioRow);

    // Back button
    this.addBackButton(panel);
    this.overlay.appendChild(panel);
  }

  private showMentat(): void {
    if (!this.overlay) return;
    this.overlay.innerHTML = '';

    const panel = document.createElement('div');
    panel.style.cssText = 'background:#1a1a2e;border:1px solid #555;border-radius:4px;width:640px;height:480px;display:flex;flex-direction:column;';

    const backRow = document.createElement('div');
    backRow.style.cssText = 'display:flex;justify-content:flex-end;padding:4px 8px;';
    const backBtn = document.createElement('button');
    backBtn.textContent = 'Back';
    backBtn.style.cssText = 'padding:4px 12px;background:#1a1a3e;border:1px solid #444;color:#ccc;cursor:pointer;font-size:11px;';
    backBtn.onmouseenter = () => { backBtn.style.borderColor = '#88f'; };
    backBtn.onmouseleave = () => { backBtn.style.borderColor = '#444'; };
    backBtn.onclick = () => { this.close(); this.show(); };
    backRow.appendChild(backBtn);
    panel.appendChild(backRow);

    const contentDiv = document.createElement('div');
    contentDiv.style.cssText = 'flex:1;overflow:hidden;';
    panel.appendChild(contentDiv);

    const mentat = new MentatScreen(this.deps.gameRules);
    mentat.show(contentDiv);

    this.overlay.appendChild(panel);
  }

  private showSettings(): void {
    if (!this.overlay) return;
    this.overlay.innerHTML = '';

    const panel = document.createElement('div');
    panel.style.cssText = 'background:#1a1a3e;border:1px solid #555;padding:24px 32px;border-radius:4px;min-width:300px;';

    const title = document.createElement('div');
    title.textContent = 'SETTINGS';
    title.style.cssText = 'color:#d4a840;font-size:24px;font-weight:bold;text-align:center;margin-bottom:20px;';
    panel.appendChild(title);

    let currentSettings: any = {};
    try { currentSettings = JSON.parse(localStorage.getItem('ebfd_settings') ?? '{}'); } catch { /* corrupted settings */ }
    let musicVol = currentSettings.musicVol ?? 0.3;
    let sfxVol = currentSettings.sfxVol ?? 0.5;
    let scrollSpd = currentSettings.scrollSpeed ?? 1;
    let fogEnabled = currentSettings.fogEnabled ?? (this.deps.isFogEnabled?.() ?? true);
    let dmgNumbers = currentSettings.damageNumbers ?? (this.deps.isDamageNumbers?.() ?? true);
    let rangeCircles = currentSettings.rangeCircles ?? (this.deps.isRangeCircles?.() ?? true);

    const createSlider = (label: string, value: number, onChange: (v: number) => void): HTMLElement => {
      const row = document.createElement('div');
      row.style.cssText = 'margin-bottom:16px;';
      const lbl = document.createElement('div');
      lbl.style.cssText = 'color:#ccc;font-size:13px;margin-bottom:4px;display:flex;justify-content:space-between;';
      const valLabel = document.createElement('span');
      valLabel.textContent = `${Math.round(value * 100)}%`;
      valLabel.style.color = '#8cf';
      lbl.innerHTML = `<span>${label}</span>`;
      lbl.appendChild(valLabel);
      row.appendChild(lbl);
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.value = String(Math.round(value * 100));
      slider.style.cssText = 'width:100%;accent-color:#d4a840;';
      slider.oninput = () => {
        const v = parseInt(slider.value) / 100;
        valLabel.textContent = `${slider.value}%`;
        onChange(v);
      };
      row.appendChild(slider);
      return row;
    };

    panel.appendChild(createSlider('Music Volume', musicVol, (v) => {
      musicVol = v;
      this.deps.audioManager.setMusicVolume(v);
    }));

    panel.appendChild(createSlider('SFX Volume', sfxVol, (v) => {
      sfxVol = v;
      this.deps.audioManager.setSfxVolume(v);
    }));

    panel.appendChild(createSlider('Scroll Speed', scrollSpd, (v) => {
      scrollSpd = v;
      this.deps.setScrollSpeed?.(v);
    }));

    // Game speed selector
    const speedRow = document.createElement('div');
    speedRow.style.cssText = 'margin-bottom:20px;';
    const speedLabel = document.createElement('div');
    speedLabel.textContent = 'Game Speed';
    speedLabel.style.cssText = 'color:#ccc;font-size:13px;margin-bottom:4px;';
    speedRow.appendChild(speedLabel);
    const speedBtns = document.createElement('div');
    speedBtns.style.cssText = 'display:flex;gap:4px;';
    for (const { label, speed } of [{ label: 'Slow', speed: 0.5 }, { label: 'Normal', speed: 1.0 }, { label: 'Fast', speed: 2.0 }]) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = 'flex:1;padding:6px;background:#111;border:1px solid #444;color:#ccc;cursor:pointer;font-size:12px;';
      btn.onclick = () => {
        this.deps.setSpeed(speed);
        speedBtns.querySelectorAll('button').forEach(b => (b as HTMLElement).style.borderColor = '#444');
        btn.style.borderColor = '#d4a840';
      };
      speedBtns.appendChild(btn);
    }
    speedRow.appendChild(speedBtns);
    panel.appendChild(speedRow);

    // Toggle options
    const createToggle = (label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer;';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = checked;
      checkbox.style.cssText = 'accent-color:#d4a840;width:16px;height:16px;cursor:pointer;';
      checkbox.onchange = () => onChange(checkbox.checked);
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = 'color:#ccc;font-size:13px;';
      row.appendChild(checkbox);
      row.appendChild(lbl);
      row.onclick = (e) => { if (e.target !== checkbox) { checkbox.checked = !checkbox.checked; onChange(checkbox.checked); } };
      return row;
    };

    panel.appendChild(createToggle('Fog of War', fogEnabled, (v) => {
      fogEnabled = v;
      this.deps.setFogEnabled?.(v);
    }));

    panel.appendChild(createToggle('Damage Numbers', dmgNumbers, (v) => {
      dmgNumbers = v;
      this.deps.setDamageNumbers?.(v);
    }));

    panel.appendChild(createToggle('Attack Range Circles', rangeCircles, (v) => {
      rangeCircles = v;
      this.deps.setRangeCircles?.(v);
    }));

    // Back button with save
    const backBtn = document.createElement('button');
    backBtn.textContent = 'Back';
    backBtn.style.cssText = 'display:block;width:100%;padding:10px;background:#2a2a4e;border:1px solid #555;color:#ccc;cursor:pointer;font-size:14px;margin-top:8px;';
    backBtn.onmouseenter = () => { backBtn.style.borderColor = '#88f'; };
    backBtn.onmouseleave = () => { backBtn.style.borderColor = '#555'; };
    backBtn.onclick = () => {
      localStorage.setItem('ebfd_settings', JSON.stringify({ musicVol, sfxVol, scrollSpeed: scrollSpd, fogEnabled, damageNumbers: dmgNumbers, rangeCircles }));
      this.close();
      this.show();
    };
    panel.appendChild(backBtn);

    this.overlay.appendChild(panel);
  }

  private addBackButton(panel: HTMLElement): void {
    const backBtn = document.createElement('button');
    backBtn.textContent = 'Back';
    backBtn.style.cssText = 'display:block;width:100%;padding:10px;background:#2a2a4e;border:1px solid #555;color:#ccc;cursor:pointer;font-size:14px;margin-top:16px;';
    backBtn.onmouseenter = () => { backBtn.style.borderColor = '#88f'; };
    backBtn.onmouseleave = () => { backBtn.style.borderColor = '#555'; };
    backBtn.onclick = () => {
      this.close();
      this.show();
    };
    panel.appendChild(backBtn);
  }
}
