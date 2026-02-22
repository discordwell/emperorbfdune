/**
 * SFX Manifest - Maps SfxType categories to arrays of sampled audio files.
 * Each category can have multiple variants for randomisation.
 */

const S = '/assets/audio/sfx/';

export interface SfxEntry {
  /** Array of OGG file paths (relative to web root). A random one is chosen each play. */
  paths: string[];
  /** Base volume 0-1 for this category. */
  volume: number;
  /** Whether to apply random pitch variation (+/- 5%). */
  pitchVariation: boolean;
  /** Minimum milliseconds between plays of this category (prevents spam). */
  cooldown?: number;
}

/**
 * Keys match the SfxType union in AudioManager.ts:
 *   'select' | 'move' | 'attack' | 'explosion' | 'build' | 'sell' | 'error' |
 *   'victory' | 'defeat' | 'harvest' | 'shot' | 'powerlow' | 'place' | 'worm' |
 *   'underattack' | 'deathInfantry' | 'deathVehicle' | 'deathBuilding' |
 *   'superweaponReady' | 'superweaponLaunch'
 */
export const SFX_MANIFEST: Record<string, SfxEntry> = {
  // --- UI / Selection ---
  select: {
    paths: [
      `${S}button1.ogg`,
      `${S}sn_sci_fi_click_3.ogg`,
      `${S}nav_button_press_1.ogg`,
    ],
    volume: 0.3,
    pitchVariation: true,
    cooldown: 50,
  },

  move: {
    paths: [
      `${S}nav_button_press_1.ogg`,
      `${S}nav_button_roll_over_1.ogg`,
    ],
    volume: 0.25,
    pitchVariation: true,
    cooldown: 50,
  },

  attack: {
    paths: [
      `${S}adp_gun_1.ogg`,
      `${S}adp_gun_2.ogg`,
      `${S}at_light_infantry_1.ogg`,
    ],
    volume: 0.35,
    pitchVariation: true,
    cooldown: 80,
  },

  // --- Explosions ---
  explosion: {
    paths: [
      `${S}explosion_medium_1.ogg`,
      `${S}explosion_medium_2.ogg`,
      `${S}explosion_medium_3.ogg`,
      `${S}explosion_medium_4.ogg`,
      `${S}explosion_medium_5.ogg`,
      `${S}explosion_small_1.ogg`,
      `${S}explosion_small_2.ogg`,
      `${S}explosion_small_3.ogg`,
      `${S}explosion_small_4.ogg`,
      `${S}explosion_small_5.ogg`,
    ],
    volume: 0.45,
    pitchVariation: true,
    cooldown: 60,
  },

  // --- Building / Construction ---
  build: {
    paths: [
      `${S}constructionelement1.ogg`,
      `${S}constructionelement2.ogg`,
      `${S}constructionsparks.ogg`,
    ],
    volume: 0.35,
    pitchVariation: false,
    cooldown: 200,
  },

  sell: {
    paths: [
      `${S}credit_down_5.ogg`,
    ],
    volume: 0.4,
    pitchVariation: false,
    cooldown: 200,
  },

  error: {
    // No sampled audio for error -- will fall through to synth.
    paths: [],
    volume: 0.3,
    pitchVariation: false,
    cooldown: 200,
  },

  victory: {
    // No sampled audio -- will fall through to synth.
    paths: [],
    volume: 0.4,
    pitchVariation: false,
  },

  defeat: {
    // No sampled audio -- will fall through to synth.
    paths: [],
    volume: 0.4,
    pitchVariation: false,
  },

  // --- Harvest ---
  harvest: {
    paths: [
      `${S}harvester_deposit_spice_1.ogg`,
      `${S}credit_up_5.ogg`,
    ],
    volume: 0.35,
    pitchVariation: false,
    cooldown: 300,
  },

  // --- Weapon fire ---
  shot: {
    paths: [
      `${S}at_light_infantry_1.ogg`,
      `${S}at_light_infantry_2.ogg`,
      `${S}at_light_infantry_3.ogg`,
      `${S}at_light_infantry_4.ogg`,
      `${S}adp_gun_1.ogg`,
      `${S}adp_gun_2.ogg`,
      `${S}hk_light_infantry_1.ogg`,
      `${S}sand_trike_gun_1.ogg`,
      `${S}sniper_3.ogg`,
      `${S}at_mgun_tower_1.ogg`,
      `${S}sardukar_mgun_1.ogg`,
      `${S}sardukar_mgun_2.ogg`,
    ],
    volume: 0.3,
    pitchVariation: true,
    cooldown: 80,
  },

  // --- Power ---
  powerlow: {
    paths: [
      `${S}powrdn1.ogg`,
    ],
    volume: 0.45,
    pitchVariation: false,
    cooldown: 5000,
  },

  // --- Placement ---
  place: {
    paths: [
      `${S}building_thud_1.ogg`,
      `${S}wall_thud_1.ogg`,
      `${S}mcvdeploy.ogg`,
    ],
    volume: 0.4,
    pitchVariation: false,
    cooldown: 200,
  },

  // --- Sandworm ---
  worm: {
    paths: [
      `${S}worm_roar_1_tc.ogg`,
      `${S}worm_roar_2_tc.ogg`,
      `${S}worm_roar_3_tc.ogg`,
      `${S}worm_roar_4_tc.ogg`,
      `${S}worm_roar_5_tc.ogg`,
      `${S}worm_roar_6_tc.ogg`,
      `${S}worm_rumble_1.ogg`,
      `${S}worm_rumble_2.ogg`,
      `${S}worm_rumble_3.ogg`,
      `${S}worm_rumble_4.ogg`,
      `${S}worm_rumble_5.ogg`,
    ],
    volume: 0.5,
    pitchVariation: true,
    cooldown: 500,
  },

  // --- Alerts ---
  underattack: {
    paths: [
      `${S}radaronline.ogg`,
      `${S}static01i_vol1.ogg`,
      `${S}static02i_vol1.ogg`,
    ],
    volume: 0.5,
    pitchVariation: false,
    cooldown: 5000,
  },

  // --- Death sounds ---
  deathInfantry: {
    paths: [
      `${S}normal_dying_1.ogg`,
      `${S}normal_dying_2.ogg`,
      `${S}normal_dying_3.ogg`,
      `${S}normal_dying_4.ogg`,
      `${S}normal_dying_5.ogg`,
      `${S}normal_dying_6.ogg`,
      `${S}normal_dying_7.ogg`,
      `${S}normal_dying_8.ogg`,
      `${S}normal_dying_9.ogg`,
      `${S}normal_dying_10.ogg`,
      `${S}normal_dying_11.ogg`,
      `${S}normal_dying_12.ogg`,
      `${S}burn_dying_1.ogg`,
      `${S}burn_dying_2.ogg`,
      `${S}burn_dying_3.ogg`,
      `${S}burn_dying_4.ogg`,
      `${S}choke_dying_1.ogg`,
      `${S}choke_dying_2.ogg`,
      `${S}choke_dying_3.ogg`,
      `${S}female_death_1.ogg`,
      `${S}female_death_2.ogg`,
      `${S}female_death_3.ogg`,
      `${S}female_death_4.ogg`,
    ],
    volume: 0.4,
    pitchVariation: true,
    cooldown: 80,
  },

  deathVehicle: {
    paths: [
      `${S}explosion_vehicle_1.ogg`,
      `${S}explosion_vehicle_2.ogg`,
      `${S}explosion_large_1.ogg`,
      `${S}explosion_large_2.ogg`,
      `${S}explosion_large_3.ogg`,
      `${S}explosion_large_4.ogg`,
      `${S}explosion_large_5.ogg`,
    ],
    volume: 0.5,
    pitchVariation: true,
    cooldown: 100,
  },

  deathBuilding: {
    paths: [
      `${S}bigxplosion01.ogg`,
      `${S}bigxplosion02.ogg`,
      `${S}bigxplosion04.ogg`,
      `${S}bigxplosion09.ogg`,
      `${S}bigxplosion17.ogg`,
      `${S}explosion_large_1.ogg`,
      `${S}explosion_large_2.ogg`,
      `${S}explosion_large_3.ogg`,
    ],
    volume: 0.55,
    pitchVariation: true,
    cooldown: 200,
  },

  // --- Superweapons ---
  superweaponReady: {
    paths: [
      `${S}radaronline.ogg`,
    ],
    volume: 0.5,
    pitchVariation: false,
    cooldown: 1000,
  },

  superweaponLaunch: {
    paths: [
      `${S}death_hand_launch_3.ogg`,
      `${S}bigxplosion01.ogg`,
      `${S}bigxplosion17.ogg`,
    ],
    volume: 0.6,
    pitchVariation: false,
    cooldown: 500,
  },

  // --- Weapon-specific fire sounds ---
  shotRocket: {
    paths: [
      `${S}at_rocket_turret_1.ogg`,
      `${S}ornithopter_rocket_1.ogg`,
      `${S}ornithopter_rocket_2.ogg`,
      `${S}hk_missile_tank_1.ogg`,
    ],
    volume: 0.35,
    pitchVariation: true,
    cooldown: 80,
  },

  shotLaser: {
    paths: [
      `${S}lasertankattack.ogg`,
    ],
    volume: 0.35,
    pitchVariation: true,
    cooldown: 80,
  },

  shotFlame: {
    paths: [
      `${S}chemflamerattack.ogg`,
      `${S}hk_flame_infantry_1.ogg`,
      `${S}hk_flame_turret_1.ogg`,
    ],
    volume: 0.35,
    pitchVariation: true,
    cooldown: 80,
  },

  shotSonic: {
    paths: [
      `${S}sonic_tank_boom_large_1.ogg`,
    ],
    volume: 0.4,
    pitchVariation: false,
    cooldown: 150,
  },

  shotMortar: {
    paths: [
      `${S}mortarattack.ogg`,
      `${S}mortarattackpistol.ogg`,
    ],
    volume: 0.35,
    pitchVariation: true,
    cooldown: 100,
  },

  shotSniper: {
    paths: [
      `${S}sniper_3.ogg`,
    ],
    volume: 0.3,
    pitchVariation: true,
    cooldown: 100,
  },

  shotCannon: {
    paths: [
      `${S}hk_assault_tank_1a.ogg`,
      `${S}kindjal_infantry_cannon_2.ogg`,
    ],
    volume: 0.4,
    pitchVariation: true,
    cooldown: 80,
  },

  shotBuzzsaw: {
    paths: [
      `${S}hk_buzzsaw_gun_1.ogg`,
    ],
    volume: 0.35,
    pitchVariation: true,
    cooldown: 80,
  },

  shotInkvine: {
    paths: [
      `${S}hk_inkvine_shot_1b.ogg`,
    ],
    volume: 0.35,
    pitchVariation: true,
    cooldown: 100,
  },

  shotChemTurret: {
    paths: [
      `${S}chemturretattack.ogg`,
    ],
    volume: 0.35,
    pitchVariation: true,
    cooldown: 100,
  },

  shotPopupTurret: {
    paths: [
      `${S}popupturretattack.ogg`,
    ],
    volume: 0.35,
    pitchVariation: true,
    cooldown: 100,
  },

  shotPalace: {
    paths: [
      `${S}palace_arc_1.ogg`,
    ],
    volume: 0.45,
    pitchVariation: false,
    cooldown: 200,
  },

  // --- Ability SFX ---
  stealth: {
    paths: [
      `${S}stealth1.ogg`,
      `${S}stealth2.ogg`,
    ],
    volume: 0.3,
    pitchVariation: false,
    cooldown: 500,
  },

  thumperDeploy: {
    paths: [
      `${S}thumper_deploy_1.ogg`,
    ],
    volume: 0.4,
    pitchVariation: false,
    cooldown: 300,
  },

  thumperRhythm: {
    paths: [
      `${S}thumper_single_1.ogg`,
      `${S}thumper_single_2.ogg`,
    ],
    volume: 0.35,
    pitchVariation: false,
    cooldown: 200,
  },

  repairSparks: {
    paths: [
      `${S}repair_vehicle_sparks_1.ogg`,
      `${S}repair_vehicle_sparks_1b.ogg`,
      `${S}repair_vehicle_sparks_1c.ogg`,
      `${S}repair_vehicle_sparks_1d.ogg`,
    ],
    volume: 0.25,
    pitchVariation: true,
    cooldown: 300,
  },

  veterancyUp: {
    paths: [
      `${S}veteran_upgrade_1.ogg`,
    ],
    volume: 0.45,
    pitchVariation: false,
    cooldown: 200,
  },

  popupTurretRise: {
    paths: [
      `${S}popupturretrise.ogg`,
    ],
    volume: 0.35,
    pitchVariation: false,
    cooldown: 200,
  },

  popupTurretDrop: {
    paths: [
      `${S}popupturretdrop.ogg`,
    ],
    volume: 0.35,
    pitchVariation: false,
    cooldown: 200,
  },

  leechAttack: {
    paths: [
      `${S}tx_leech_attack_6.ogg`,
      `${S}tx_leech_attack_7.ogg`,
    ],
    volume: 0.35,
    pitchVariation: true,
    cooldown: 200,
  },

  fleshBorn: {
    paths: [
      `${S}tx_flesh_born_2.ogg`,
      `${S}tx_flesh_born_3.ogg`,
    ],
    volume: 0.35,
    pitchVariation: false,
    cooldown: 200,
  },

  sonicDeploy: {
    paths: [
      `${S}sonic_tank_deploy_1.ogg`,
    ],
    volume: 0.4,
    pitchVariation: false,
    cooldown: 300,
  },

  weirdingWeapon: {
    paths: [
      `${S}weirding_weapon_3.ogg`,
    ],
    volume: 0.35,
    pitchVariation: false,
    cooldown: 200,
  },

  // --- Wind loops ---
  windLoop: {
    paths: [
      `${S}wind_loop_medium_1.ogg`,
      `${S}wind_loop_medium_2.ogg`,
    ],
    volume: 0.15,
    pitchVariation: false,
  },
};

/**
 * Returns a flat array of ALL sample paths from the manifest,
 * suitable for passing to SampleBank.preload().
 */
export function getAllSamplePaths(): string[] {
  const set = new Set<string>();
  for (const entry of Object.values(SFX_MANIFEST)) {
    for (const p of entry.paths) {
      set.add(p);
    }
  }
  return [...set];
}

/**
 * Returns only the highest-priority sample paths (explosions, shots, deaths, building)
 * for initial preloading. Other sounds can be loaded lazily.
 */
export function getPrioritySamplePaths(): string[] {
  const priority: string[] = [
    'explosion', 'shot', 'deathInfantry', 'deathVehicle', 'deathBuilding',
    'build', 'place', 'worm', 'harvest', 'powerlow', 'select',
    'shotRocket', 'shotLaser', 'shotFlame', 'shotSonic', 'shotCannon',
    'shotMortar', 'shotSniper', 'veterancyUp',
  ];
  const set = new Set<string>();
  for (const key of priority) {
    const entry = SFX_MANIFEST[key];
    if (entry) {
      for (const p of entry.paths) {
        set.add(p);
      }
    }
  }
  return [...set];
}
