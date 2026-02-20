import type { GameContext } from '../core/GameContext';

export function setupGameUI(ctx: GameContext): void {
  const {
    gameRules, artMap, typeRegistry, productionSystem, harvestSystem,
    audioManager, selectionPanel, sidebar, buildingPlacement, terrain,
    iconRenderer, modelManager,
  } = ctx;
  const { unitTypeNames, buildingTypeNames } = typeRegistry;

  // Sidebar production icons from 3D models
  const factionPrefixes = ['AT', 'HK', 'OR', 'FR', 'IM', 'IX', 'TL', 'GU', 'IN'];
  const allUnitNames = [...gameRules.units.keys()];
  const allBuildingNames = [...gameRules.buildings.keys()].filter(name => {
    const def = gameRules.buildings.get(name)!;
    const art = artMap.get(name);
    return art?.xaf && def.cost > 0 && factionPrefixes.some(p => name.startsWith(p));
  });

  // Pass rendered 3D model icons to sidebar
  const iconMap = new Map<string, string>();
  for (const name of [...allUnitNames, ...allBuildingNames]) {
    const art = artMap.get(name);
    const iconKey = art?.xaf ?? name;
    const url = iconRenderer.getIcon(iconKey);
    if (url) iconMap.set(iconKey, url);
  }
  if (iconMap.size > 0) sidebar.setIcons(iconMap);
  iconRenderer.dispose();

  // Concrete slab placement
  const CONCRETE_COST = 20;
  sidebar.setConcreteCallback(() => {
    buildingPlacement.startConcretePlacement((tx, tz) => {
      if (harvestSystem.getSolaris(0) < CONCRETE_COST) {
        selectionPanel.addMessage('Insufficient funds', '#ff4444');
        audioManager.getDialogManager()?.trigger('insufficientFunds');
        return false;
      }
      harvestSystem.spendSolaris(0, CONCRETE_COST);
      terrain.setTerrainType(tx, tz, 6); // TerrainType.ConcreteSlab
      terrain.updateSpiceVisuals();
      return true;
    });
  });

  setInterval(() => {
    sidebar.updateProgress();
    sidebar.refresh();
  }, 2000);
  setInterval(() => sidebar.updateProgress(), 200);
}
