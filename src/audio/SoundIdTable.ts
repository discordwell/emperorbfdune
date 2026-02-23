/**
 * Sound ID lookup table mapping AUDIO.BAG indices to SfxManifest categories.
 *
 * Generated from gamedata/data/Sfx/AUDIO.BAG by tools/extract_sound_table.py.
 * The PlaySound(N) scripting function uses N as an index into the AUDIO.BAG.
 * The BAG contains 945 total entries; this table maps the 293 non-voice
 * SFX entries to their corresponding SfxManifest categories for playback.
 *
 * Voice lines (NN-U{A,M,S,X}NN format) are handled separately by VoiceManager.
 */

const S = '/assets/audio/sfx/';

export interface SoundIdEntry {
  /** Original filename in AUDIO.BAG (no extension). */
  name: string;
  /** SfxManifest category for playback routing, or null if uncategorized. */
  category: string | null;
  /** Direct OGG file path for SampleBank playback, or null if unavailable. */
  ogg: string | null;
}

/**
 * Maps AUDIO.BAG index (PlaySound argument) to SoundIdEntry.
 */
export const SOUND_ID_TABLE: Record<number, SoundIdEntry> = {
  // --- select ---
  0: { name: 'Button1', category: 'select', ogg: `${S}button1.ogg` },
  788: { name: 'sn_monitor_on_1', category: 'select', ogg: `${S}sn_monitor_on_1.ogg` },
  789: { name: 'sn_monitor_off_1', category: 'select', ogg: `${S}sn_monitor_off_1.ogg` },
  810: { name: 'open_crate_2', category: 'select', ogg: null },
  937: { name: 'nav_button_press_1', category: 'select', ogg: `${S}nav_button_press_1.ogg` },
  938: { name: 'nav_button_roll_over_1', category: 'select', ogg: `${S}nav_button_roll_over_1.ogg` },
  939: { name: 'house_logo_sweep_1', category: 'select', ogg: null },
  940: { name: 'new_unit_draw_1', category: 'select', ogg: null },
  941: { name: 'sn_sci_fi_click_3', category: 'select', ogg: `${S}sn_sci_fi_click_3.ogg` },
  942: { name: 'house_affirmation_window_up_1', category: 'select', ogg: null },
  943: { name: 'house_affirmation_window_down_1', category: 'select', ogg: null },

  // --- harvest ---
  793: { name: 'credit_up_5', category: 'harvest', ogg: `${S}credit_up_5.ogg` },
  798: { name: 'harvester_deposit_spice_1', category: 'harvest', ogg: `${S}harvester_deposit_spice_1.ogg` },
  800: { name: 'harvester_harvest_spice_1', category: 'harvest', ogg: `${S}harvester_harvest_spice_1.ogg` },

  // --- sell ---
  944: { name: 'credit_down_5', category: 'sell', ogg: `${S}credit_down_5.ogg` },

  // --- build ---
  83: { name: 'constructionsparks', category: 'build', ogg: `${S}constructionsparks.ogg` },
  327: { name: 'constructionelement1', category: 'build', ogg: `${S}constructionelement1.ogg` },
  328: { name: 'constructionelement2', category: 'build', ogg: `${S}constructionelement2.ogg` },
  770: { name: 'build_spark_1', category: 'build', ogg: null },
  771: { name: 'ConstructSpark', category: 'build', ogg: null },

  // --- place ---
  42: { name: 'kindjal_infantry_reload_1', category: 'place', ogg: null },
  48: { name: 'kindjal_infantry_deploy_2', category: 'place', ogg: `${S}kindjal_infantry_deploy_2.ogg` },
  278: { name: 'APCDoorOpen', category: 'place', ogg: null },
  325: { name: 'EyeSkyDeploy', category: 'place', ogg: null },
  767: { name: 'building_thud_1', category: 'place', ogg: `${S}building_thud_1.ogg` },
  768: { name: 'wall_thud_1', category: 'place', ogg: `${S}wall_thud_1.ogg` },
  769: { name: 'fremen_tent_build_1', category: 'place', ogg: `${S}fremen_tent_build_1.ogg` },
  779: { name: 'MCVDeploy', category: 'place', ogg: `${S}mcvdeploy.ogg` },
  780: { name: 'mcv_e_flatten_1', category: 'place', ogg: `${S}mcv_e_flatten_1.ogg` },
  781: { name: 'MCVUnDeploy', category: 'place', ogg: `${S}mcvundeploy.ogg` },
  805: { name: 'ix_deploy_3', category: 'place', ogg: `${S}ix_deploy_3.ogg` },

  // --- powerlow ---
  794: { name: 'Powrdn1', category: 'powerlow', ogg: `${S}powrdn1.ogg` },
  795: { name: 'Powrup1', category: 'powerlow', ogg: `${S}powrup1.ogg` },

  // --- underattack ---
  126: { name: 'Static02i_vol1', category: 'underattack', ogg: `${S}static02i_vol1.ogg` },
  127: { name: 'Static01i_vol1', category: 'underattack', ogg: `${S}static01i_vol1.ogg` },
  796: { name: 'RadarOnline', category: 'underattack', ogg: `${S}radaronline.ogg` },

  // --- error ---
  799: { name: 'harvester_no_deposit_spice_1', category: 'error', ogg: `${S}harvester_no_deposit_spice_1.ogg` },

  // --- shot ---
  43: { name: 'at_light_infantry_4', category: 'shot', ogg: `${S}at_light_infantry_4.ogg` },
  44: { name: 'at_light_infantry_3', category: 'shot', ogg: `${S}at_light_infantry_3.ogg` },
  45: { name: 'at_light_infantry_2', category: 'shot', ogg: `${S}at_light_infantry_2.ogg` },
  46: { name: 'at_light_infantry_1', category: 'shot', ogg: `${S}at_light_infantry_1.ogg` },
  49: { name: 'hk_engineer_pistol_1', category: 'shot', ogg: `${S}hk_engineer_pistol_1.ogg` },
  56: { name: 'camouflage_apc_gun_1', category: 'shot', ogg: `${S}camouflage_apc_gun_1.ogg` },
  62: { name: 'sand_trike_gun_1', category: 'shot', ogg: `${S}sand_trike_gun_1.ogg` },
  74: { name: 'at_mgun_tower_1', category: 'shot', ogg: `${S}at_mgun_tower_1.ogg` },
  270: { name: 'aatrooperattack', category: 'shot', ogg: null },
  277: { name: 'APCAttack', category: 'shot', ogg: null },
  282: { name: 'DeviatorAttack', category: 'shot', ogg: null },
  304: { name: 'KobraAttack', category: 'shot', ogg: null },
  462: { name: 'hk_light_infantry_1f', category: 'shot', ogg: `${S}hk_light_infantry_1f.ogg` },
  463: { name: 'hk_light_infantry_1e', category: 'shot', ogg: `${S}hk_light_infantry_1e.ogg` },
  464: { name: 'hk_light_infantry_1d', category: 'shot', ogg: `${S}hk_light_infantry_1d.ogg` },
  465: { name: 'hk_light_infantry_1c', category: 'shot', ogg: `${S}hk_light_infantry_1c.ogg` },
  466: { name: 'hk_light_infantry_1b', category: 'shot', ogg: `${S}hk_light_infantry_1b.ogg` },
  467: { name: 'hk_light_infantry_1', category: 'shot', ogg: `${S}hk_light_infantry_1.ogg` },
  468: { name: 'adp_gun_2', category: 'shot', ogg: `${S}adp_gun_2.ogg` },
  469: { name: 'adp_gun_1', category: 'shot', ogg: `${S}adp_gun_1.ogg` },
  488: { name: 'hk_adp_gun_1', category: 'shot', ogg: `${S}hk_adp_gun_1.ogg` },
  705: { name: 'sardukar_mgun_2', category: 'shot', ogg: `${S}sardukar_mgun_2.ogg` },
  706: { name: 'sardukar_mgun_1', category: 'shot', ogg: `${S}sardukar_mgun_1.ogg` },
  707: { name: 'HMGL3', category: 'shot', ogg: null },
  708: { name: 'HMGL2', category: 'shot', ogg: null },
  709: { name: 'HMGL1', category: 'shot', ogg: null },
  717: { name: 'sardukar_knife_swing_1', category: 'shot', ogg: null },
  724: { name: 'niab_tank_fire_1', category: 'shot', ogg: `${S}niab_tank_fire_1.ogg` },
  726: { name: 'KindjalGun3', category: 'shot', ogg: `${S}kindjalgun3.ogg` },
  727: { name: 'KindjalGun2', category: 'shot', ogg: `${S}kindjalgun2.ogg` },
  728: { name: 'KindjalGun1', category: 'shot', ogg: `${S}kindjalgun1.ogg` },
  777: { name: 'niab_action_1', category: 'shot', ogg: null },
  778: { name: 'niab_action_2', category: 'shot', ogg: null },

  // --- shotRocket ---
  51: { name: 'mongoose_rocket_1', category: 'shotRocket', ogg: null },
  55: { name: 'at_drone_rocket_1', category: 'shotRocket', ogg: null },
  64: { name: 'ORNITHOPTER_ROCKET_1', category: 'shotRocket', ogg: `${S}ornithopter_rocket_1.ogg` },
  66: { name: 'ornithopter_rocket_2', category: 'shotRocket', ogg: `${S}ornithopter_rocket_2.ogg` },
  84: { name: 'at_rocket_turret_1', category: 'shotRocket', ogg: `${S}at_rocket_turret_1.ogg` },
  470: { name: 'hk_rocket_trooper_1', category: 'shotRocket', ogg: null },
  471: { name: 'hk_rocket_trooper_reload_1', category: 'shotRocket', ogg: null },
  485: { name: 'hk_missile_tank_1', category: 'shotRocket', ogg: `${S}hk_missile_tank_1.ogg` },
  710: { name: 'bazooka_mod_1', category: 'shotRocket', ogg: null },

  // --- shotLaser ---
  302: { name: 'LaserTankAttack', category: 'shotLaser', ogg: `${S}lasertankattack.ogg` },

  // --- shotFlame ---
  271: { name: 'chemflamerattack', category: 'shotFlame', ogg: `${S}chemflamerattack.ogg` },
  319: { name: 'ChemTurretAttack', category: 'shotFlame', ogg: `${S}chemturretattack.ogg` },
  472: { name: 'hk_flame_infantry_1', category: 'shotFlame', ogg: `${S}hk_flame_infantry_1.ogg` },
  491: { name: 'hk_flame_turret_1', category: 'shotFlame', ogg: `${S}hk_flame_turret_1.ogg` },

  // --- shotMortar ---
  272: { name: 'MortarAttack', category: 'shotMortar', ogg: `${S}mortarattack.ogg` },
  273: { name: 'MortarAttackPistol', category: 'shotMortar', ogg: `${S}mortarattackpistol.ogg` },

  // --- shotSniper ---
  41: { name: 'sniper_3', category: 'shotSniper', ogg: `${S}sniper_3.ogg` },

  // --- shotCannon ---
  47: { name: 'kindjal_infantry_cannon_2', category: 'shotCannon', ogg: `${S}kindjal_infantry_cannon_2.ogg` },
  50: { name: 'kindjal_infantry_canon_1', category: 'shotCannon', ogg: `${S}kindjal_infantry_canon_1.ogg` },
  65: { name: 'minotaurus_cannon_1', category: 'shotCannon', ogg: null },
  478: { name: 'hk_assault_tank_1a', category: 'shotCannon', ogg: `${S}hk_assault_tank_1a.ogg` },
  484: { name: 'hk_devastator_1d', category: 'shotCannon', ogg: null },

  // --- shotBuzzsaw ---
  481: { name: 'hk_buzzsaw_gun_1', category: 'shotBuzzsaw', ogg: `${S}hk_buzzsaw_gun_1.ogg` },
  482: { name: 'buzzsaw_rip_1', category: 'shotBuzzsaw', ogg: null },

  // --- shotInkvine ---
  473: { name: 'hk_inkvine_shot_1b', category: 'shotInkvine', ogg: `${S}hk_inkvine_shot_1b.ogg` },

  // --- shotSonic ---
  59: { name: 'sonic_tank_boom_large_1', category: 'shotSonic', ogg: `${S}sonic_tank_boom_large_1.ogg` },

  // --- shotPopupTurret ---
  85: { name: 'turret_start_11', category: 'shotPopupTurret', ogg: `${S}turret_start_11.ogg` },
  86: { name: 'turret_end_11', category: 'shotPopupTurret', ogg: `${S}turret_end_11.ogg` },
  87: { name: 'turret_loop_11', category: 'shotPopupTurret', ogg: `${S}turret_loop_11.ogg` },
  311: { name: 'PopupTurretAttack', category: 'shotPopupTurret', ogg: `${S}popupturretattack.ogg` },

  // --- shotPalace ---
  775: { name: 'palace_arc_1', category: 'shotPalace', ogg: `${S}palace_arc_1.ogg` },

  // --- weirdingWeapon ---
  715: { name: 'weirding_weapon_3', category: 'weirdingWeapon', ogg: `${S}weirding_weapon_3.ogg` },

  // --- explosion ---
  314: { name: 'explosion_medium_4', category: 'explosion', ogg: `${S}explosion_medium_4.ogg` },
  315: { name: 'explosion_medium_3', category: 'explosion', ogg: `${S}explosion_medium_3.ogg` },
  316: { name: 'explosion_medium_2', category: 'explosion', ogg: `${S}explosion_medium_2.ogg` },
  317: { name: 'explosion_medium_1', category: 'explosion', ogg: `${S}explosion_medium_1.ogg` },
  318: { name: 'explosionordos05', category: 'explosion', ogg: `${S}explosionordos05.ogg` },
  320: { name: 'explosionordos06', category: 'explosion', ogg: `${S}explosionordos06.ogg` },
  321: { name: 'explosionordos04', category: 'explosion', ogg: `${S}explosionordos04.ogg` },
  322: { name: 'explosionordos03', category: 'explosion', ogg: `${S}explosionordos03.ogg` },
  323: { name: 'explosionordos02', category: 'explosion', ogg: `${S}explosionordos02.ogg` },
  324: { name: 'explosionordos01', category: 'explosion', ogg: `${S}explosionordos01.ogg` },
  477: { name: 'hk_inkvine_hit_1', category: 'explosion', ogg: null },
  711: { name: 'ShellDet1', category: 'explosion', ogg: `${S}shelldet1.ogg` },
  736: { name: 'explosion_small_5', category: 'explosion', ogg: `${S}explosion_small_5.ogg` },
  737: { name: 'explosion_small_4', category: 'explosion', ogg: `${S}explosion_small_4.ogg` },
  738: { name: 'explosion_small_3', category: 'explosion', ogg: `${S}explosion_small_3.ogg` },
  739: { name: 'explosion_small_2', category: 'explosion', ogg: `${S}explosion_small_2.ogg` },
  740: { name: 'explosion_small_1', category: 'explosion', ogg: `${S}explosion_small_1.ogg` },
  741: { name: 'explosion_medium_5', category: 'explosion', ogg: `${S}explosion_medium_5.ogg` },
  766: { name: 'shell_dud_1', category: 'explosion', ogg: `${S}shell_dud_1.ogg` },

  // --- deathInfantry ---
  1: { name: 'normal_dying_22', category: 'deathInfantry', ogg: `${S}normal_dying_22.ogg` },
  2: { name: 'normal_dying_21', category: 'deathInfantry', ogg: `${S}normal_dying_21.ogg` },
  3: { name: 'normal_dying_20', category: 'deathInfantry', ogg: `${S}normal_dying_20.ogg` },
  4: { name: 'normal_dying_19', category: 'deathInfantry', ogg: `${S}normal_dying_19.ogg` },
  5: { name: 'normal_dying_18', category: 'deathInfantry', ogg: `${S}normal_dying_18.ogg` },
  6: { name: 'normal_dying_17', category: 'deathInfantry', ogg: `${S}normal_dying_17.ogg` },
  7: { name: 'normal_dying_16', category: 'deathInfantry', ogg: `${S}normal_dying_16.ogg` },
  8: { name: 'normal_dying_15', category: 'deathInfantry', ogg: `${S}normal_dying_15.ogg` },
  9: { name: 'normal_dying_14', category: 'deathInfantry', ogg: `${S}normal_dying_14.ogg` },
  10: { name: 'normal_dying_13', category: 'deathInfantry', ogg: `${S}normal_dying_13.ogg` },
  11: { name: 'normal_dying_12', category: 'deathInfantry', ogg: `${S}normal_dying_12.ogg` },
  12: { name: 'normal_dying_11', category: 'deathInfantry', ogg: `${S}normal_dying_11.ogg` },
  13: { name: 'normal_dying_10', category: 'deathInfantry', ogg: `${S}normal_dying_10.ogg` },
  14: { name: 'normal_dying_9', category: 'deathInfantry', ogg: `${S}normal_dying_9.ogg` },
  15: { name: 'normal_dying_8', category: 'deathInfantry', ogg: `${S}normal_dying_8.ogg` },
  16: { name: 'normal_dying_7', category: 'deathInfantry', ogg: `${S}normal_dying_7.ogg` },
  17: { name: 'normal_dying_6', category: 'deathInfantry', ogg: `${S}normal_dying_6.ogg` },
  18: { name: 'normal_dying_5', category: 'deathInfantry', ogg: `${S}normal_dying_5.ogg` },
  19: { name: 'normal_dying_4', category: 'deathInfantry', ogg: `${S}normal_dying_4.ogg` },
  20: { name: 'normal_dying_3', category: 'deathInfantry', ogg: `${S}normal_dying_3.ogg` },
  21: { name: 'normal_dying_2', category: 'deathInfantry', ogg: `${S}normal_dying_2.ogg` },
  22: { name: 'normal_dying_1', category: 'deathInfantry', ogg: `${S}normal_dying_1.ogg` },
  23: { name: 'burn_dying_8', category: 'deathInfantry', ogg: `${S}burn_dying_8.ogg` },
  24: { name: 'burn_dying_7', category: 'deathInfantry', ogg: `${S}burn_dying_7.ogg` },
  25: { name: 'burn_dying_6', category: 'deathInfantry', ogg: `${S}burn_dying_6.ogg` },
  26: { name: 'burn_dying_5', category: 'deathInfantry', ogg: `${S}burn_dying_5.ogg` },
  27: { name: 'burn_dying_4', category: 'deathInfantry', ogg: `${S}burn_dying_4.ogg` },
  28: { name: 'burn_dying_3', category: 'deathInfantry', ogg: `${S}burn_dying_3.ogg` },
  29: { name: 'burn_dying_2', category: 'deathInfantry', ogg: `${S}burn_dying_2.ogg` },
  30: { name: 'burn_dying_1', category: 'deathInfantry', ogg: `${S}burn_dying_1.ogg` },
  31: { name: 'choke_dying_6', category: 'deathInfantry', ogg: `${S}choke_dying_6.ogg` },
  32: { name: 'choke_dying_5', category: 'deathInfantry', ogg: `${S}choke_dying_5.ogg` },
  33: { name: 'choke_dying_4', category: 'deathInfantry', ogg: `${S}choke_dying_4.ogg` },
  34: { name: 'choke_dying_3', category: 'deathInfantry', ogg: `${S}choke_dying_3.ogg` },
  35: { name: 'choke_dying_2', category: 'deathInfantry', ogg: `${S}choke_dying_2.ogg` },
  36: { name: 'choke_dying_1', category: 'deathInfantry', ogg: `${S}choke_dying_1.ogg` },
  37: { name: 'crush_guy_4', category: 'deathInfantry', ogg: null },
  38: { name: 'crush_guy_3', category: 'deathInfantry', ogg: null },
  39: { name: 'crush_guy_2', category: 'deathInfantry', ogg: null },
  40: { name: 'crush_guy_1', category: 'deathInfantry', ogg: null },
  734: { name: 'yak_death_2', category: 'deathInfantry', ogg: `${S}yak_death_2.ogg` },
  735: { name: 'yak_death_1', category: 'deathInfantry', ogg: `${S}yak_death_1.ogg` },
  750: { name: 'female_death_4', category: 'deathInfantry', ogg: `${S}female_death_4.ogg` },
  751: { name: 'female_death_3', category: 'deathInfantry', ogg: `${S}female_death_3.ogg` },
  752: { name: 'female_death_2', category: 'deathInfantry', ogg: `${S}female_death_2.ogg` },
  753: { name: 'female_death_1', category: 'deathInfantry', ogg: `${S}female_death_1.ogg` },
  754: { name: 'contaminator_die_2', category: 'deathInfantry', ogg: null },
  755: { name: 'contaminator_die_1', category: 'deathInfantry', ogg: null },
  756: { name: 'KilGuild3', category: 'deathInfantry', ogg: null },
  757: { name: 'KilGuild2', category: 'deathInfantry', ogg: null },
  758: { name: 'KilGuild1', category: 'deathInfantry', ogg: null },

  // --- deathVehicle ---
  474: { name: 'explosion_vehicle_1', category: 'deathVehicle', ogg: `${S}explosion_vehicle_1.ogg` },
  480: { name: 'explosion_vehicle_2', category: 'deathVehicle', ogg: `${S}explosion_vehicle_2.ogg` },
  742: { name: 'explosion_large_5', category: 'deathVehicle', ogg: `${S}explosion_large_5.ogg` },
  743: { name: 'explosion_large_4', category: 'deathVehicle', ogg: `${S}explosion_large_4.ogg` },
  744: { name: 'explosion_large_3', category: 'deathVehicle', ogg: `${S}explosion_large_3.ogg` },
  745: { name: 'explosion_large_2', category: 'deathVehicle', ogg: `${S}explosion_large_2.ogg` },
  746: { name: 'explosion_large_1', category: 'deathVehicle', ogg: `${S}explosion_large_1.ogg` },

  // --- deathBuilding ---
  88: { name: 'bigxplosion17', category: 'deathBuilding', ogg: `${S}bigxplosion17.ogg` },
  89: { name: 'bigxplosion09', category: 'deathBuilding', ogg: `${S}bigxplosion09.ogg` },
  90: { name: 'bigxplosion02', category: 'deathBuilding', ogg: `${S}bigxplosion02.ogg` },
  91: { name: 'bigxplosion01', category: 'deathBuilding', ogg: `${S}bigxplosion01.ogg` },
  475: { name: 'bigxplosion04', category: 'deathBuilding', ogg: `${S}bigxplosion04.ogg` },
  747: { name: 'BurningL3', category: 'deathBuilding', ogg: null },
  748: { name: 'BurningL2', category: 'deathBuilding', ogg: null },
  749: { name: 'BurningL1', category: 'deathBuilding', ogg: null },

  // --- worm ---
  77: { name: 'Wingbeat', category: 'worm', ogg: `${S}wingbeat.ogg` },
  78: { name: 'Screech', category: 'worm', ogg: `${S}screech.ogg` },
  731: { name: 'worm_sign_elec_3', category: 'worm', ogg: `${S}worm_sign_elec_3.ogg` },
  732: { name: 'worm_sign_elec_2', category: 'worm', ogg: `${S}worm_sign_elec_2.ogg` },
  733: { name: 'worm_sign_elec_1', category: 'worm', ogg: `${S}worm_sign_elec_1.ogg` },
  809: { name: 'tornado_man_2', category: 'worm', ogg: `${S}tornado_man_2.ogg` },
  811: { name: 'worm_rumble_5', category: 'worm', ogg: `${S}worm_rumble_5.ogg` },
  812: { name: 'worm_rumble_4', category: 'worm', ogg: `${S}worm_rumble_4.ogg` },
  813: { name: 'worm_rumble_3', category: 'worm', ogg: `${S}worm_rumble_3.ogg` },
  814: { name: 'worm_rumble_2', category: 'worm', ogg: `${S}worm_rumble_2.ogg` },
  815: { name: 'worm_rumble_1', category: 'worm', ogg: `${S}worm_rumble_1.ogg` },
  816: { name: 'worm_roar_6_tc', category: 'worm', ogg: `${S}worm_roar_6_tc.ogg` },
  817: { name: 'worm_roar_5_tc', category: 'worm', ogg: `${S}worm_roar_5_tc.ogg` },
  818: { name: 'worm_roar_4_tc', category: 'worm', ogg: `${S}worm_roar_4_tc.ogg` },
  819: { name: 'worm_roar_3_tc', category: 'worm', ogg: `${S}worm_roar_3_tc.ogg` },
  820: { name: 'worm_roar_2_tc', category: 'worm', ogg: `${S}worm_roar_2_tc.ogg` },
  821: { name: 'worm_roar_1_tc', category: 'worm', ogg: `${S}worm_roar_1_tc.ogg` },

  // --- stealth ---
  276: { name: 'SaboteurDeploy', category: 'stealth', ogg: null },
  791: { name: 'Stealth1', category: 'stealth', ogg: `${S}stealth1.ogg` },
  792: { name: 'Stealth2', category: 'stealth', ogg: `${S}stealth2.ogg` },

  // --- repairSparks ---
  69: { name: 'REPAIR_VEHICLE_SPARKS_1D', category: 'repairSparks', ogg: `${S}repair_vehicle_sparks_1d.ogg` },
  70: { name: 'REPAIR_VEHICLE_SPARKS_1C', category: 'repairSparks', ogg: `${S}repair_vehicle_sparks_1c.ogg` },
  71: { name: 'REPAIR_VEHICLE_SPARKS_1B', category: 'repairSparks', ogg: `${S}repair_vehicle_sparks_1b.ogg` },
  72: { name: 'REPAIR_VEHICLE_SPARKS_1', category: 'repairSparks', ogg: `${S}repair_vehicle_sparks_1.ogg` },

  // --- veterancyUp ---
  790: { name: 'veteran_upgrade_1', category: 'veterancyUp', ogg: `${S}veteran_upgrade_1.ogg` },

  // --- thumperDeploy ---
  797: { name: 'thumper_deploy_1', category: 'thumperDeploy', ogg: `${S}thumper_deploy_1.ogg` },

  // --- thumperRhythm ---
  712: { name: 'thumper_single_2', category: 'thumperRhythm', ogg: `${S}thumper_single_2.ogg` },
  713: { name: 'thumper_single_1', category: 'thumperRhythm', ogg: `${S}thumper_single_1.ogg` },

  // --- popupTurretRise ---
  312: { name: 'PopUpTurretRise', category: 'popupTurretRise', ogg: `${S}popupturretrise.ogg` },

  // --- popupTurretDrop ---
  313: { name: 'PopUpTurretDrop', category: 'popupTurretDrop', ogg: `${S}popupturretdrop.ogg` },

  // --- leechAttack ---
  716: { name: 'contaminator_attack_2', category: 'leechAttack', ogg: null },
  718: { name: 'tx_leech_attack_7', category: 'leechAttack', ogg: `${S}tx_leech_attack_7.ogg` },
  719: { name: 'tx_leech_attack_6', category: 'leechAttack', ogg: `${S}tx_leech_attack_6.ogg` },
  759: { name: 'leech_suck_4', category: 'leechAttack', ogg: null },
  760: { name: 'leech_suck_3', category: 'leechAttack', ogg: null },
  761: { name: 'leech_suck_2', category: 'leechAttack', ogg: null },
  762: { name: 'leech_suck_1', category: 'leechAttack', ogg: null },

  // --- fleshBorn ---
  730: { name: 'replica_spawn_1', category: 'fleshBorn', ogg: `${S}replica_spawn_1.ogg` },
  772: { name: 'tx_flesh_born_3', category: 'fleshBorn', ogg: `${S}tx_flesh_born_3.ogg` },
  773: { name: 'tx_flesh_born_2', category: 'fleshBorn', ogg: `${S}tx_flesh_born_2.ogg` },

  // --- sonicDeploy ---
  61: { name: 'sonic_tank_deploy_1', category: 'sonicDeploy', ogg: `${S}sonic_tank_deploy_1.ogg` },

  // --- superweaponLaunch ---
  326: { name: 'ChaosLightning', category: 'superweaponLaunch', ogg: null },
  714: { name: 'death_hand_launch_3', category: 'superweaponLaunch', ogg: `${S}death_hand_launch_3.ogg` },

  // --- windLoop ---
  807: { name: 'wind_loop_medium_2', category: 'windLoop', ogg: `${S}wind_loop_medium_2.ogg` },
  808: { name: 'wind_loop_medium_1', category: 'windLoop', ogg: `${S}wind_loop_medium_1.ogg` },

  // --- uncategorized ---
  60: { name: 'sonic_tank_motor_1', category: null, ogg: `${S}sonic_tank_motor_1.ogg` },
  63: { name: 'sand_bike_move_1', category: null, ogg: `${S}sand_bike_move_1.ogg` },
  67: { name: 'ornithopter_motor_1c', category: null, ogg: `${S}ornithopter_motor_1c.ogg` },
  68: { name: 'ornithopter_motor_2c', category: null, ogg: `${S}ornithopter_motor_2c.ogg` },
  73: { name: 'camouflage_apc_motor_1', category: null, ogg: `${S}camouflage_apc_motor_1.ogg` },
  75: { name: 'mcv_a_motor_1', category: null, ogg: `${S}mcv_a_motor_1.ogg` },
  79: { name: 'mcv_b_open_1', category: null, ogg: `${S}mcv_b_open_1.ogg` },
  80: { name: 'mcv_d_drill_dig_1', category: null, ogg: `${S}mcv_d_drill_dig_1.ogg` },
  81: { name: 'mcv_f_scaffold_up_1', category: null, ogg: `${S}mcv_f_scaffold_up_1.ogg` },
  82: { name: 'mcv_g_building_out_1', category: null, ogg: `${S}mcv_g_building_out_1.ogg` },
  240: { name: 'ATRAttack2', category: null, ogg: `${S}atrattack2.ogg` },
  241: { name: 'ATRAttack1', category: null, ogg: `${S}atrattack1.ogg` },
  242: { name: 'ATRMove2', category: null, ogg: `${S}atrmove2.ogg` },
  243: { name: 'ATRMove1', category: null, ogg: `${S}atrmove1.ogg` },
  244: { name: 'ATRSelect2', category: null, ogg: `${S}atrselect2.ogg` },
  245: { name: 'ATRSelect1', category: null, ogg: `${S}atrselect1.ogg` },
  303: { name: 'lasertankmovestarta', category: null, ogg: `${S}lasertankmovestarta.ogg` },
  437: { name: 'ORDAttack2', category: null, ogg: `${S}ordattack2.ogg` },
  438: { name: 'ORDAttack1', category: null, ogg: `${S}ordattack1.ogg` },
  439: { name: 'ORDMove2', category: null, ogg: `${S}ordmove2.ogg` },
  440: { name: 'ORDMove1', category: null, ogg: `${S}ordmove1.ogg` },
  441: { name: 'ORDSelect2', category: null, ogg: `${S}ordselect2.ogg` },
  442: { name: 'ORDSelect1', category: null, ogg: `${S}ordselect1.ogg` },
  476: { name: 'inkvine_engine_1', category: null, ogg: `${S}inkvine_engine_1.ogg` },
  479: { name: 'assault_tank_engine_1', category: null, ogg: `${S}assault_tank_engine_1.ogg` },
  487: { name: 'hk_missile_tank_move_1', category: null, ogg: `${S}hk_missile_tank_move_1.ogg` },
  489: { name: 'hk_ornithopter_motor_down_1', category: null, ogg: `${S}hk_ornithopter_motor_down_1.ogg` },
  490: { name: 'hk_flame_tank_move_1', category: null, ogg: `${S}hk_flame_tank_move_1.ogg` },
  656: { name: 'HARAttack2', category: null, ogg: `${S}harattack2.ogg` },
  657: { name: 'HARAttack1', category: null, ogg: `${S}harattack1.ogg` },
  658: { name: 'HARMove2', category: null, ogg: `${S}harmove2.ogg` },
  659: { name: 'HARMove1', category: null, ogg: `${S}harmove1.ogg` },
  660: { name: 'HARSelect2', category: null, ogg: `${S}harselect2.ogg` },
  661: { name: 'HARSelect1', category: null, ogg: `${S}harselect1.ogg` },
  725: { name: 'niab_tank_motor_1', category: null, ogg: `${S}niab_tank_motor_1.ogg` },
  765: { name: 'tx_leech_attack_confirm_1', category: null, ogg: `${S}tx_leech_attack_confirm_1.ogg` },
  774: { name: 'ORNITHOPTER_MOTOR_2c', category: null, ogg: `${S}ornithopter_motor_2c.ogg` },
  905: { name: 'IXAttack2', category: null, ogg: `${S}ixattack2.ogg` },
  906: { name: 'IXAttack1', category: null, ogg: `${S}ixattack1.ogg` },
  907: { name: 'IXMove2', category: null, ogg: `${S}ixmove2.ogg` },
  908: { name: 'IXMove1', category: null, ogg: `${S}ixmove1.ogg` },
  909: { name: 'IXSelect2', category: null, ogg: `${S}ixselect2.ogg` },
  910: { name: 'IXSelect1', category: null, ogg: `${S}ixselect1.ogg` },
  911: { name: 'SarAttack2', category: null, ogg: `${S}sarattack2.ogg` },
  912: { name: 'SarAttack1', category: null, ogg: `${S}sarattack1.ogg` },
  913: { name: 'SarMove2', category: null, ogg: `${S}sarmove2.ogg` },
  914: { name: 'SarMove1', category: null, ogg: `${S}sarmove1.ogg` },
  915: { name: 'SarSelect2', category: null, ogg: `${S}sarselect2.ogg` },
  916: { name: 'SarSelect1', category: null, ogg: `${S}sarselect1.ogg` },
  917: { name: 'FREAttack2', category: null, ogg: `${S}freattack2.ogg` },
  918: { name: 'FREAttack1', category: null, ogg: `${S}freattack1.ogg` },
  919: { name: 'FREMove2', category: null, ogg: `${S}fremove2.ogg` },
  920: { name: 'FREMove1', category: null, ogg: `${S}fremove1.ogg` },
  921: { name: 'FRESelect2', category: null, ogg: `${S}freselect2.ogg` },
  922: { name: 'FRESelect1', category: null, ogg: `${S}freselect1.ogg` },
  923: { name: 'GUIAttack2', category: null, ogg: `${S}guiattack2.ogg` },
  924: { name: 'GUIAttack1', category: null, ogg: `${S}guiattack1.ogg` },
  925: { name: 'GUIMove2', category: null, ogg: `${S}guimove2.ogg` },
  926: { name: 'GUIMove1', category: null, ogg: `${S}guimove1.ogg` },
  927: { name: 'GUISelect2', category: null, ogg: `${S}guiselect2.ogg` },
  928: { name: 'GUISelect1', category: null, ogg: `${S}guiselect1.ogg` },

};

/** Total number of entries in AUDIO.BAG. */
export const SOUND_ID_COUNT = 945;

/**
 * Look up a sound ID and return the SfxManifest category to play.
 * Returns null if the ID is unknown or unmapped.
 */
export function lookupSoundCategory(soundId: number): string | null {
  const entry = SOUND_ID_TABLE[soundId];
  return entry?.category ?? null;
}

/**
 * Look up a sound ID and return its direct OGG file path.
 * Returns null if no OGG is available for this ID.
 */
export function lookupSoundOgg(soundId: number): string | null {
  const entry = SOUND_ID_TABLE[soundId];
  return entry?.ogg ?? null;
}

