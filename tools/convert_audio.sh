#!/usr/bin/env bash
# Convert extracted WAV SFX to OGG (Opus) for web playback.
# Uses ffmpeg with libopus at 96kbps, 48000 Hz (Opus minimum).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SRC_DIR="$PROJECT_DIR/extracted/AUDIO"
DST_DIR="$PROJECT_DIR/assets/audio/sfx"

if [ ! -d "$SRC_DIR" ]; then
  echo "ERROR: Source directory not found: $SRC_DIR"
  exit 1
fi

mkdir -p "$DST_DIR"

converted=0
skipped=0
failed=0

convert_file() {
  local src="$1"
  local basename
  basename="$(basename "$src" .wav)"
  # Normalise filename: lowercase, spaces to underscores
  local dst_name
  dst_name="$(echo "$basename" | tr '[:upper:]' '[:lower:]' | tr ' ' '_')"
  local dst="$DST_DIR/${dst_name}.ogg"

  if [ -f "$dst" ]; then
    skipped=$((skipped + 1))
    return
  fi

  if ffmpeg -y -i "$src" -c:a libopus -b:a 96k -ar 48000 "$dst" -loglevel error 2>/dev/null; then
    converted=$((converted + 1))
  else
    echo "  FAILED: $basename"
    failed=$((failed + 1))
  fi
}

echo "=== Emperor: Battle for Dune - SFX Converter ==="
echo "Source: $SRC_DIR"
echo "Destination: $DST_DIR"
echo ""

# --- Explosions ---
echo "Converting explosions..."
for f in "$SRC_DIR"/explosion_large_*.wav \
         "$SRC_DIR"/explosion_medium_*.wav \
         "$SRC_DIR"/explosion_small_*.wav \
         "$SRC_DIR"/explosion_vehicle_*.wav \
         "$SRC_DIR"/bigxplosion*.wav \
         "$SRC_DIR"/explosionordos*.wav; do
  [ -f "$f" ] && convert_file "$f"
done

# --- Weapon shots ---
echo "Converting weapon shots..."
for f in "$SRC_DIR"/adp_gun_*.wav \
         "$SRC_DIR"/at_light_infantry_*.wav \
         "$SRC_DIR"/at_mgun_tower_*.wav \
         "$SRC_DIR"/hk_light_infantry_*.wav \
         "$SRC_DIR"/hk_adp_gun_*.wav \
         "$SRC_DIR"/hk_buzzsaw_gun_*.wav \
         "$SRC_DIR"/hk_flame_infantry_*.wav \
         "$SRC_DIR"/hk_flame_turret_*.wav \
         "$SRC_DIR"/hk_missile_tank_*.wav \
         "$SRC_DIR"/hk_assault_tank_*.wav \
         "$SRC_DIR"/sand_trike_gun_*.wav \
         "$SRC_DIR"/sardukar_mgun_*.wav \
         "$SRC_DIR"/sniper_*.wav \
         "$SRC_DIR"/LaserTankAttack.wav \
         "$SRC_DIR"/MortarAttack.wav \
         "$SRC_DIR"/MortarAttackPistol.wav \
         "$SRC_DIR"/PopupTurretAttack.wav \
         "$SRC_DIR"/ChemTurretAttack.wav \
         "$SRC_DIR"/chemflamerattack.wav \
         "$SRC_DIR"/KindjalGun*.wav \
         "$SRC_DIR"/kindjal_infantry_cannon_*.wav \
         "$SRC_DIR"/kindjal_infantry_canon_*.wav \
         "$SRC_DIR"/niab_tank_fire_*.wav \
         "$SRC_DIR"/sonic_tank_boom_large_*.wav \
         "$SRC_DIR"/at_rocket_turret_*.wav \
         "$SRC_DIR"/camouflage_apc_gun_*.wav \
         "$SRC_DIR"/hk_engineer_pistol_*.wav \
         "$SRC_DIR"/hk_inkvine_shot_*.wav \
         "$SRC_DIR"/ORNITHOPTER_ROCKET_*.wav \
         "$SRC_DIR"/ornithopter_rocket_*.wav \
         "$SRC_DIR"/weirding_weapon_*.wav \
         "$SRC_DIR"/palace_arc_*.wav \
         "$SRC_DIR"/ShellDet*.wav \
         "$SRC_DIR"/shell_dud_*.wav; do
  [ -f "$f" ] && convert_file "$f"
done

# --- Deaths / Dying ---
echo "Converting death/dying sounds..."
for f in "$SRC_DIR"/normal_dying_*.wav \
         "$SRC_DIR"/burn_dying_*.wav \
         "$SRC_DIR"/choke_dying_*.wav \
         "$SRC_DIR"/female_death_*.wav \
         "$SRC_DIR"/yak_death_*.wav \
         "$SRC_DIR"/death_hand_launch_*.wav; do
  [ -f "$f" ] && convert_file "$f"
done

# --- Building / Construction ---
echo "Converting building/construction sounds..."
for f in "$SRC_DIR"/constructionelement*.wav \
         "$SRC_DIR"/constructionsparks.wav \
         "$SRC_DIR"/building_thud_*.wav \
         "$SRC_DIR"/fremen_tent_build_*.wav \
         "$SRC_DIR"/mcv_*.wav \
         "$SRC_DIR"/MCVDeploy.wav \
         "$SRC_DIR"/MCVUnDeploy.wav \
         "$SRC_DIR"/wall_thud_*.wav; do
  [ -f "$f" ] && convert_file "$f"
done

# --- Worm ---
echo "Converting worm sounds..."
for f in "$SRC_DIR"/worm_roar_*.wav \
         "$SRC_DIR"/worm_rumble_*.wav \
         "$SRC_DIR"/worm_sign_elec_*.wav; do
  [ -f "$f" ] && convert_file "$f"
done

# --- Vehicle / Engine ---
echo "Converting vehicle/engine sounds..."
for f in "$SRC_DIR"/assault_tank_engine_*.wav \
         "$SRC_DIR"/sand_bike_move_*.wav \
         "$SRC_DIR"/hk_flame_tank_move_*.wav \
         "$SRC_DIR"/hk_missile_tank_move_*.wav \
         "$SRC_DIR"/sonic_tank_motor_*.wav \
         "$SRC_DIR"/niab_tank_motor_*.wav \
         "$SRC_DIR"/lasertankmovestarta.wav \
         "$SRC_DIR"/camouflage_apc_motor_*.wav \
         "$SRC_DIR"/inkvine_engine_*.wav \
         "$SRC_DIR"/ornithopter_motor_*.wav \
         "$SRC_DIR"/hk_ornithopter_motor_down_*.wav; do
  [ -f "$f" ] && convert_file "$f"
done

# --- UI ---
echo "Converting UI sounds..."
for f in "$SRC_DIR"/Button1.wav \
         "$SRC_DIR"/nav_button_press_*.wav \
         "$SRC_DIR"/nav_button_roll_over_*.wav \
         "$SRC_DIR"/sn_sci_fi_click_*.wav \
         "$SRC_DIR"/credit_down_*.wav \
         "$SRC_DIR"/credit_up_*.wav; do
  [ -f "$f" ] && convert_file "$f"
done

# --- Power ---
echo "Converting power sounds..."
for f in "$SRC_DIR"/Powrdn1.wav \
         "$SRC_DIR"/Powrup1.wav; do
  [ -f "$f" ] && convert_file "$f"
done

# --- Harvester ---
echo "Converting harvester sounds..."
for f in "$SRC_DIR"/harvester_deposit_spice_*.wav \
         "$SRC_DIR"/harvester_harvest_spice_*.wav \
         "$SRC_DIR"/harvester_no_deposit_spice_*.wav; do
  [ -f "$f" ] && convert_file "$f"
done

# --- Deploy / Special ---
echo "Converting deploy/special sounds..."
for f in "$SRC_DIR"/thumper_deploy_*.wav \
         "$SRC_DIR"/thumper_single_*.wav \
         "$SRC_DIR"/Stealth*.wav \
         "$SRC_DIR"/RadarOnline.wav \
         "$SRC_DIR"/sonic_tank_deploy_*.wav \
         "$SRC_DIR"/ix_deploy_*.wav \
         "$SRC_DIR"/kindjal_infantry_deploy_*.wav \
         "$SRC_DIR"/replica_spawn_*.wav \
         "$SRC_DIR"/veteran_upgrade_*.wav \
         "$SRC_DIR"/Screech.wav \
         "$SRC_DIR"/Wingbeat.wav \
         "$SRC_DIR"/tornado_man_*.wav \
         "$SRC_DIR"/tx_flesh_born_*.wav \
         "$SRC_DIR"/tx_leech_attack_*.wav; do
  [ -f "$f" ] && convert_file "$f"
done

# --- Turrets ---
echo "Converting turret sounds..."
for f in "$SRC_DIR"/turret_start_*.wav \
         "$SRC_DIR"/turret_loop_*.wav \
         "$SRC_DIR"/turret_end_*.wav \
         "$SRC_DIR"/PopUpTurretRise.wav \
         "$SRC_DIR"/PopUpTurretDrop.wav; do
  [ -f "$f" ] && convert_file "$f"
done

# --- Faction select/move/attack acknowledgements ---
echo "Converting faction voice responses..."
for f in "$SRC_DIR"/ATRSelect*.wav \
         "$SRC_DIR"/ATRAttack*.wav \
         "$SRC_DIR"/ATRMove*.wav \
         "$SRC_DIR"/HARSelect*.wav \
         "$SRC_DIR"/HARAttack*.wav \
         "$SRC_DIR"/HARMove*.wav \
         "$SRC_DIR"/ORDSelect*.wav \
         "$SRC_DIR"/ORDAttack*.wav \
         "$SRC_DIR"/ORDMove*.wav \
         "$SRC_DIR"/FRESelect*.wav \
         "$SRC_DIR"/FREAttack*.wav \
         "$SRC_DIR"/FREMove*.wav \
         "$SRC_DIR"/SarSelect*.wav \
         "$SRC_DIR"/SarAttack*.wav \
         "$SRC_DIR"/SarMove*.wav \
         "$SRC_DIR"/IXSelect*.wav \
         "$SRC_DIR"/IXAttack*.wav \
         "$SRC_DIR"/IXMove*.wav \
         "$SRC_DIR"/GUISelect*.wav \
         "$SRC_DIR"/GUIAttack*.wav \
         "$SRC_DIR"/GUIMove*.wav; do
  [ -f "$f" ] && convert_file "$f"
done

# --- Wind / Ambience ---
echo "Converting ambient sounds..."
for f in "$SRC_DIR"/wind_loop_medium_*.wav \
         "$SRC_DIR"/Static01i_vol1.wav \
         "$SRC_DIR"/Static02i_vol1.wav \
         "$SRC_DIR"/sn_monitor_on_*.wav \
         "$SRC_DIR"/sn_monitor_off_*.wav; do
  [ -f "$f" ] && convert_file "$f"
done

# --- REPAIR ---
echo "Converting repair sounds..."
for f in "$SRC_DIR"/REPAIR_VEHICLE_SPARKS_*.wav; do
  [ -f "$f" ] && convert_file "$f"
done

echo ""
echo "=== Done ==="
echo "Converted: $converted"
echo "Skipped (already exist): $skipped"
echo "Failed: $failed"
echo "Total OGG files: $(ls -1 "$DST_DIR"/*.ogg 2>/dev/null | wc -l | tr -d ' ')"
