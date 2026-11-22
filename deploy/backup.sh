#!/usr/bin/env bash
# Fitness Hub: copy data/ (your data plus the hub's own backups) to a folder you choose.
#
#   bash ~/fitness-hub/deploy/backup.sh /path/to/folder [--keep 30]                  # one backup now
#   bash ~/fitness-hub/deploy/backup.sh --install-timer /path/to/folder [--keep 30]  # daily, via systemd --user
#   bash ~/fitness-hub/deploy/backup.sh --remove-timer
#   Unattended runs (the timer, or cron) add --require-marker; cron also logs to a file (guide, section 9).
#
# Each run writes fitness-hub-data-YYYYmmdd-HHMMSS.tar.gz plus a .sha256 file next to it, both
# readable only by you on a Linux filesystem, and keeps the newest N (default 30). The folder must
# already exist (for example a mounted USB drive or NAS share) and must be outside ~/fitness-hub.
# The first run leaves a .fitness-hub-backup-target marker there; --require-marker refuses a folder
# without it, so an unmounted drive's empty mount point never receives backups. Every run records
# its result in ~/.local/state/fitness-hub/backup-status, and verify.sh fails if the last one failed.
# Precondition: the hub has created data/data.json (verify.sh shows GET /api/data: 200); without it
# nothing is written. --install-timer runs the first backup through the new unit before it enables
# the timer, and takes everything out again if that run fails.
#
# It's personal health data. Pick a folder that doesn't sync to the cloud unless the user decided it
# should. On FAT, exFAT or NTFS drives and on network shares, Linux permissions don't protect the
# files (a warning says so). To encrypt the archives with age or gpg, see the hosting guide, section 9.
#
# Testing only, with FITNESS_HUB_TESTING=1: FITNESS_HUB_DIR, FITNESS_HUB_STATE_DIR.
set -Eeuo pipefail
umask 077  # archives, checksums, the marker and the timer's unit files are private to you

for _name in FITNESS_HUB_DIR FITNESS_HUB_STATE_DIR; do
  if [ -n "${!_name:-}" ] && [ "${FITNESS_HUB_TESTING:-}" != 1 ]; then
    printf '[FAIL] %s is a setting for the test suite only. Unset it, or set FITNESS_HUB_TESTING=1.\n' "$_name" >&2
    exit 2
  fi
done
unset _name
if [ "${FITNESS_HUB_TESTING:-}" = 1 ]; then
  HUB_DIR="${FITNESS_HUB_DIR:-$HOME/fitness-hub}"
  STATE_DIR="${FITNESS_HUB_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/fitness-hub}"
else
  HUB_DIR="$HOME/fitness-hub"
  STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/fitness-hub"
fi
UNIT_DIR="$HOME/.config/systemd/user"
TIMER=fitness-hub-backup.timer
SERVICE=fitness-hub-backup.service
MARKER=.fitness-hub-backup-target
KEEP=30
RUNNING=0      # 1 once a backup run has started: its result is recorded on exit
RESULT_NOTE=""

ok()   { printf '[ OK ] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; }
die()  { RESULT_NOTE="${*//$'\n'/ }"; printf '[FAIL] %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Fitness Hub backup: copy data/ to a folder you choose (an absolute path that already exists).
  bash ~/fitness-hub/deploy/backup.sh /path/to/folder [--keep 30] [--require-marker]
  bash ~/fitness-hub/deploy/backup.sh --install-timer /path/to/folder [--keep 30]
  bash ~/fitness-hub/deploy/backup.sh --remove-timer
EOF
}

record_result() {  # EXIT trap: write ok/fail for the run, which verify.sh reads
  local rc=$?
  [ "$RUNNING" = 1 ] || return 0
  mkdir -p -- "$STATE_DIR" 2>/dev/null || return 0
  if [ "$rc" -eq 0 ]; then
    printf 'ok %s %s\n' "$(date -Is 2>/dev/null || date)" "$RESULT_NOTE" > "$STATE_DIR/backup-status" 2>/dev/null || true
  else
    printf 'fail %s exit %s: %s\n' "$(date -Is 2>/dev/null || date)" "$rc" "${RESULT_NOTE:-see the log}" > "$STATE_DIR/backup-status" 2>/dev/null || true
  fi
}
trap record_result EXIT

user_bus() {
  local rt
  rt="/run/user/$(id -u)"
  if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "$rt" ]; then export XDG_RUNTIME_DIR="$rt"; fi
  if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "${XDG_RUNTIME_DIR:-/nonexistent}/bus" ]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
  fi
}

require_data() {  # the precondition: the hub has created data/data.json (verify.sh: GET /api/data: 200)
  [ -d "$HUB_DIR/data" ] || die "No data folder at $HUB_DIR/data"
  [ -s "$HUB_DIR/data/data.json" ] \
    || die "There is no $HUB_DIR/data/data.json yet. Open the hub once (through the tunnel) so it creates it, check that verify.sh shows 'GET /api/data: 200', then run this again. Nothing was written."
}

resolve_dest() {  # prints the real path of a safe destination folder, or dies
  local dest="$1" real hub
  [ -n "$dest" ] || die "Say where the backups should go, for example: backup.sh /media/$(id -un)/usb/fitness-backups"
  case "$dest" in /*) ;; *) die "Use an absolute path (starting with /): $dest" ;; esac
  [ -d "$dest" ] || die "$dest doesn't exist. Create or mount it first (backups never create it, so an unmounted drive can't fill the system disk)."
  [ -w "$dest" ] || die "$dest isn't writable by $(id -un)."
  real="$(cd -- "$dest" && pwd -P)"
  hub="$(cd -- "$HUB_DIR" && pwd -P)"
  [ "$real" != / ] || die "Refusing to put backups in /"
  case "$real/" in "$hub/"*) die "Choose a folder outside $hub: updates replace everything there except data/, and public/ is served." ;; esac
  printf '%s\n' "$real"
}

filesystem_warning() {  # $1 destination: warn where Linux permissions don't protect the archives
  local fstype="" where=""
  if command -v findmnt >/dev/null 2>&1; then
    fstype="$(findmnt -no FSTYPE -T "$1" 2>/dev/null | head -n 1 || true)"
    where="$(findmnt -no SOURCE,TARGET -T "$1" 2>/dev/null | head -n 1 || true)"
  fi
  [ -n "$fstype" ] || fstype="$(stat -f -c %T -- "$1" 2>/dev/null || true)"
  [ -z "$where" ] || printf '[INFO] Writing to the filesystem %s (%s)\n' "$where" "${fstype:-unknown type}"
  case "$fstype" in
    vfat|fat|msdos|exfat|ntfs|ntfs3|fuseblk|cifs|smb3|smbfs|9p|v9fs|davfs|fuse|fuse.*)
      warn "$1 is on a $fstype filesystem, where Linux file permissions don't protect the archives: anyone with this drive or share can read them. Consider encrypting them (hosting guide, section 9)." ;;
  esac
}

run_backup() {  # $1 destination, $2 "require-marker" for unattended (timer or cron) runs
  local dest stamp out part where rc=0 name
  RUNNING=1
  dest="$(resolve_dest "$1")"
  require_data
  if [ ! -f "$dest/$MARKER" ]; then
    # An unmounted drive leaves an empty mount point behind; the marker tells them apart.
    [ "${2:-}" != require-marker ] || die "$dest has no $MARKER file: is the drive or share mounted? Nothing was written."
    : > "$dest/$MARKER"
  fi
  filesystem_warning "$dest"
  stamp="$(date +%Y%m%d-%H%M%S)"
  name="fitness-hub-data-$stamp.tar.gz"
  out="$dest/$name"
  part="$dest/.$name.part"
  # data.json is replaced atomically by the hub, so tar always reads a complete version.
  tar -C "$HUB_DIR" --warning=no-file-changed --warning=no-file-removed \
      --exclude='data/.hub.lock' --exclude='data/.hub.instance' --exclude='data/.tmp-*' --exclude='data/.check-*' \
      --exclude='data/backups/.tmp-*' -czf "$part" data || rc=$?
  if [ "$rc" -gt 1 ]; then rm -f -- "$part"; die "tar failed (exit $rc)"; fi
  if ! tar -tzf "$part" data/data.json >/dev/null 2>&1; then  # no pipe: nothing to SIGPIPE
    rm -f -- "$part"
    die "The archive has no data/data.json (has the hub been opened at least once?)"
  fi
  mv -- "$part" "$out"
  (cd -- "$dest" && sha256sum -- "$name") > "$dest/.$name.sha256.part"
  mv -- "$dest/.$name.sha256.part" "$out.sha256"
  ok "Wrote $out ($(du -h -- "$out" | cut -f1)) and $name.sha256"
  RESULT_NOTE="$name"
  local old removed=0
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    rm -f -- "$old" "$old.sha256"
    removed=$((removed + 1))
  done < <(find "$dest" -maxdepth 1 -type f -name 'fitness-hub-data-*.tar.gz' | sort | head -n -"$KEEP")
  if [ "$removed" -gt 0 ]; then ok "Removed $removed older backup(s); keeping the newest $KEEP"; fi
}

install_timer() {  # $1 destination
  local dest had_status=0 old_status=""
  dest="$(resolve_dest "$1")"
  case "$dest" in *[\"\\%\$\`]*) die "The path has characters systemd can't take safely (\" \\ % \$ \`). Use a simpler folder name." ;; esac
  require_data
  if [ -e "$UNIT_DIR/$TIMER" ] || [ -e "$UNIT_DIR/$SERVICE" ]; then
    die "A backup timer is already installed ($UNIT_DIR/$TIMER). To change it, run backup.sh --remove-timer first. Nothing was changed."
  fi
  user_bus
  if [ -f "$STATE_DIR/backup-status" ]; then had_status=1; old_status="$(cat -- "$STATE_DIR/backup-status")"; fi
  : > "$dest/$MARKER"  # timer runs refuse a folder without it (an unmounted drive)
  mkdir -p -- "$UNIT_DIR"
  cat > "$UNIT_DIR/$SERVICE" <<EOF
# Written by deploy/backup.sh --install-timer. Remove with: backup.sh --remove-timer
[Unit]
Description=Fitness Hub data backup to $dest

[Service]
Type=oneshot
ExecStart=/bin/bash %h/fitness-hub/deploy/backup.sh "$dest" --keep $KEEP --require-marker
UMask=0077
NoNewPrivileges=yes
Nice=10
EOF
  cat > "$UNIT_DIR/$TIMER" <<'EOF'
# Written by deploy/backup.sh --install-timer. Remove with: backup.sh --remove-timer
[Unit]
Description=Daily Fitness Hub data backup

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload
  # The first run comes BEFORE the timer is enabled, through the very unit the timer will start. If
  # it fails, everything is taken out again: no timer is left behind that would fail every night.
  if ! systemctl --user start "$SERVICE"; then
    rm -f -- "$UNIT_DIR/$TIMER" "$UNIT_DIR/$SERVICE"
    systemctl --user daemon-reload || true
    systemctl --user reset-failed "$SERVICE" >/dev/null 2>&1 || true
    if [ "$had_status" = 1 ]; then printf '%s\n' "$old_status" > "$STATE_DIR/backup-status"; else rm -f -- "$STATE_DIR/backup-status"; fi
    die "The first backup run failed, so no timer was installed. See why: journalctl --user -u $SERVICE -n 20. Fix that, then run --install-timer again."
  fi
  ok "First backup written to $dest"
  systemctl --user enable --now "$TIMER" >/dev/null
  ok "Daily backup timer installed (03:30, or at the next boot if the server was off)"
  systemctl --user list-timers "$TIMER" --no-pager || true
}

remove_timer() {
  user_bus
  systemctl --user disable --now "$TIMER" >/dev/null 2>&1 || true
  rm -f -- "$UNIT_DIR/$TIMER" "$UNIT_DIR/$SERVICE"
  systemctl --user daemon-reload
  ok "Backup timer removed (existing backup files were left alone)"
}

main() {
  [ "$(id -u)" -ne 0 ] || die "Run this as your normal user, not as root or with sudo."
  local mode=once dest="" arg marker=""
  while [ $# -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --install-timer) mode=timer ;;
      --remove-timer) mode=remove ;;
      --require-marker) marker=require-marker ;;
      --keep)
        [ $# -ge 2 ] || die "--keep needs a number"
        KEEP="$2"
        shift ;;
      -h | --help) usage; exit 0 ;;
      -*) usage; exit 2 ;;
      *) [ -z "$dest" ] || die "Only one destination folder, please"; dest="$arg" ;;
    esac
    shift
  done
  [[ "$KEEP" =~ ^[0-9]+$ ]] && [ "$KEEP" -ge 1 ] && [ "$KEEP" -le 1000 ] || die "--keep must be a whole number from 1 to 1000"
  case "$mode" in
    once) run_backup "$dest" "$marker" ;;
    timer) install_timer "$dest" ;;
    remove) remove_timer ;;
  esac
}

main "$@"
