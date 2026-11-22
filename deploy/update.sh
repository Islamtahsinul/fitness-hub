#!/usr/bin/env bash
# Fitness Hub: replace the code and content with a new bundle. Your data in data/ is never changed.
#
#   bash ~/fitness-hub/deploy/update.sh ~/fitness-hub.zip     # update from a bundle (or an unpacked folder)
#   bash ~/fitness-hub/deploy/update.sh --rollback [STAMP]    # put back the code saved by an earlier update
#   bash ~/fitness-hub/deploy/update.sh --list                # list the saved copies
#
# Order: copy the bundle into a private temporary folder, unpack it and check it there (its
# BUILD_ID, the import check and the server tests) -> copy data.json and keep the current code ->
# self-check the new code against that copy -> unpack a second, pristine copy of the same bundle
# (the code installed is never the tree the tests ran in) -> stop -> swap the code -> enable and
# start -> verify. If anything fails (or the script is interrupted) after the swap, the previous
# code is put back; if that fails its verification too, the service is stopped and disabled.
# Everything in ~/fitness-hub except data/ comes from the bundle and is replaced. Afterwards the
# hub folder and ~/fitness-hub-backups are private to you (folders 700, files 600, scripts 700):
# permissions are only ever tightened, and the contents of data/ are never touched.
# Copies go to ~/fitness-hub-backups/<STAMP>/ (data.json, code/, swap.journal).
#
# Phone access over Tailscale (the optional tailscale.conf drop-in) is kept as it is: the new code's
# self-check runs with the unit's FITNESS_HUB_TS_* settings, and verify.sh checks that mode too.
#
# Testing only, and only with FITNESS_HUB_TESTING=1: FITNESS_HUB_DIR, FITNESS_HUB_BACKUP_ROOT,
# FITNESS_HUB_NO_SYSTEMD=1, FITNESS_HUB_VERIFY_PORT, FITNESS_HUB_VERIFY_SOCKET and the other
# FITNESS_HUB_VERIFY_* settings of verify.sh.
set -Eeuo pipefail
umask 077

TEST_VARS=(FITNESS_HUB_DIR FITNESS_HUB_BACKUP_ROOT FITNESS_HUB_NO_SYSTEMD FITNESS_HUB_VERIFY_PORT FITNESS_HUB_VERIFY_SOCKET
           FITNESS_HUB_VERIFY_TS_SOCKET FITNESS_HUB_VERIFY_TS_HOST FITNESS_HUB_VERIFY_TS_LOGIN FITNESS_HUB_VERIFY_TAILSCALE)
for _name in "${TEST_VARS[@]}"; do
  if [ -n "${!_name:-}" ] && [ "${FITNESS_HUB_TESTING:-}" != 1 ]; then
    printf '[FAIL] %s is a setting for the test suite only. Unset it, or set FITNESS_HUB_TESTING=1 if you are running the tests.\n' "$_name" >&2
    exit 2
  fi
done
unset _name

if [ "${FITNESS_HUB_TESTING:-}" = 1 ]; then
  HUB_DIR="${FITNESS_HUB_DIR:-$HOME/fitness-hub}"
  BACKUP_ROOT="${FITNESS_HUB_BACKUP_ROOT:-$HOME/fitness-hub-backups}"
else
  HUB_DIR="$HOME/fitness-hub"
  BACKUP_ROOT="$HOME/fitness-hub-backups"
fi
SYSTEMD=1
[ -z "${FITNESS_HUB_NO_SYSTEMD:-}" ] || SYSTEMD=0
UNIT=fitness-hub.service
UNIT_DIR="$HOME/.config/systemd/user"
if [ "$SYSTEMD" = 1 ]; then PY=/usr/bin/python3; else PY="$(command -v python3 || command -v python || true)"; fi
STAGE=""
SWAPPED_INTO=""
JOURNAL=""
MOVED=()   # names this run moved from the hub folder into <backup>/code
PLACED=()  # names this run copied into the hub folder

step() { printf '\n== %s\n' "$*"; }
ok()   { printf '[ OK ] %s\n' "$*"; }
info() { printf '[INFO] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; }
die()  { printf '[FAIL] %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Fitness Hub update: replace the code and content with a new bundle (data/ is never changed).
  bash ~/fitness-hub/deploy/update.sh ~/fitness-hub.zip     update from a bundle (or an unpacked folder)
  bash ~/fitness-hub/deploy/update.sh --rollback [STAMP]    put back the code saved by an earlier update
  bash ~/fitness-hub/deploy/update.sh --list                list the saved copies
EOF
}

cleanup() { if [ -n "$STAGE" ] && [ -d "$STAGE" ]; then rm -rf -- "$STAGE"; fi; }

user_bus() {
  local rt
  rt="/run/user/$(id -u)"
  if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "$rt" ]; then export XDG_RUNTIME_DIR="$rt"; fi
  if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "${XDG_RUNTIME_DIR:-/nonexistent}/bus" ]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
  fi
}

service() {  # stop | start | enable | off (skipped in test mode). off = disable --now: fail closed
  [ "$SYSTEMD" = 1 ] || return 0
  case "$1" in
    start)
      systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true
      systemctl --user start "$UNIT" ;;
    enable) systemctl --user enable --quiet "$UNIT" ;;
    off) systemctl --user disable --now --quiet "$UNIT" ;;
    *) systemctl --user "$1" "$UNIT" ;;
  esac
}

unit_ts_env() {  # the FITNESS_HUB_TS_* settings (phone access) the installed unit and its drop-ins set, one per line
  [ "$SYSTEMD" = 1 ] || return 0
  systemctl --user show "$UNIT" --property=Environment --value 2>/dev/null | tr ' ' '\n' \
    | grep -E '^FITNESS_HUB_TS_(SOCKET|HOST|USERS)=' || true
}

require_unit() {  # the service must already be installed (by install.sh)
  [ "$SYSTEMD" = 1 ] || return 0
  local load
  load="$(systemctl --user show "$UNIT" --property=LoadState --value 2>/dev/null || true)"
  [ "$load" = loaded ] || die "The service isn't installed (Unit $UNIT not loaded: '${load:-unknown}'). Run install.sh first: bash $HUB_DIR/deploy/install.sh"
}

refresh_unit() {
  [ "$SYSTEMD" = 1 ] || return 0
  if ! cmp -s -- "$HUB_DIR/deploy/$UNIT" "$UNIT_DIR/$UNIT"; then
    mkdir -p -- "$UNIT_DIR"
    install -m 600 -- "$HUB_DIR/deploy/$UNIT" "$UNIT_DIR/$UNIT"
    ok "Service file updated"
  fi
  systemctl --user daemon-reload
}

run_verify() {
  if [ "$SYSTEMD" = 1 ]; then
    bash "$HUB_DIR/deploy/verify.sh"
  elif [ -n "${FITNESS_HUB_VERIFY_PORT:-}${FITNESS_HUB_VERIFY_SOCKET:-}" ]; then
    bash "$HUB_DIR/deploy/verify.sh" --no-systemd
  else
    warn "Test mode: verification skipped"
  fi
}

run_limited() {  # $1 seconds, then the command
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then timeout "$seconds" "$@"; else "$@"; fi
}

make_private() {  # SRE1: nothing the update leaves behind may be readable by other users (verify.sh checks)
  chmod -R go-rwx -- "$HUB_DIR"
  if [ -d "$BACKUP_ROOT" ]; then chmod -R go-rwx -- "$BACKUP_ROOT"; fi
  chmod 700 "$HUB_DIR"/deploy/*.sh "$HUB_DIR/start_hub.sh" 2>/dev/null || true
}

guard_hub_dir() {
  local real
  [ -d "$HUB_DIR" ] || die "No hub at $HUB_DIR. Install it first (CODEX_HOSTING_GUIDE.md, step 3)."
  real="$(cd -- "$HUB_DIR" && pwd -P)"
  case "$real" in / | "$(cd -- "$HOME" && pwd -P)") die "Refusing to work on $real";; esac
}

new_backup_dir() {  # prints a fresh, private <BACKUP_ROOT>/<STAMP>[-N] folder (never reuses one)
  local stamp base n=1
  stamp="$(date +%Y%m%d-%H%M%S)"
  mkdir -p -- "$BACKUP_ROOT"
  chmod 700 -- "$BACKUP_ROOT"
  base="$BACKUP_ROOT/$stamp${1:-}"
  local dir="$base"
  until mkdir -- "$dir" 2>/dev/null; do
    n=$((n + 1))
    [ "$n" -le 50 ] || die "Couldn't create a backup folder under $BACKUP_ROOT"
    dir="$base-$n"
  done
  printf '%s\n' "$dir"
}

extract_bundle() {  # $1 zip file, $2 empty folder; refuses odd paths and never unpacks data/
  "$PY" -I - "$1" "$2" <<'PYEOF'
import os, shutil, sys, zipfile
from pathlib import PurePosixPath
src, dest = sys.argv[1], sys.argv[2]
try:
    bundle = zipfile.ZipFile(src)
except (OSError, zipfile.BadZipFile) as exc:
    sys.exit(f"not a readable zip file ({exc.__class__.__name__})")
skipped = 0
with bundle:
    bad = bundle.testzip()
    if bad:
        sys.exit(f"the bundle is damaged (bad checksum in {bad}); copy it again")
    for info in bundle.infolist():
        name = info.filename
        parts = PurePosixPath(name).parts
        if name.startswith("/") or "\\" in name or ".." in parts or not parts or parts[0] != "fitness-hub":
            sys.exit(f"unexpected path in the bundle: {name!r}")
        if len(parts) > 1 and parts[1] == "data":
            skipped += 1
            continue
        target = os.path.join(dest, *parts)
        if name.endswith("/"):
            os.makedirs(target, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with bundle.open(info) as s, open(target, "wb") as d:
            shutil.copyfileobj(s, d)
        mode = (info.external_attr >> 16) & 0o777
        os.chmod(target, (mode or 0o600) & 0o700)  # private: never group or other bits
if skipped:
    print(f"[WARN] The bundle contains data/ ({skipped} file(s)): ignored, updates never touch your data")
PYEOF
}

copy_tree() {  # $1 an unpacked hub folder, $2 a new folder: a private copy of all of it except data/
  # Callers use `copy_tree ... || die`, where bash ignores set -e inside: so failures are counted here.
  local entry name failed=0
  mkdir -p -- "$2" || return 1
  shopt -s dotglob nullglob
  for entry in "$1"/*; do
    name="${entry##*/}"
    [ "$name" = data ] && continue
    cp -a -T -- "$entry" "$2/$name" || failed=1
  done
  shopt -u dotglob nullglob
  chmod -R go-rwx -- "$2" || failed=1
  return "$failed"
}

check_staged() {  # $1 unpacked hub folder: complete, built by make_bundle.py, and passing its own checks
  local f build log summary
  for f in server.py public/index.html deploy/fitness-hub.service deploy/verify.sh deploy/update.sh \
           deploy/check_imports.py tests/test_server.py BUILD_ID; do
    [ -f "$1/$f" ] || die "The bundle has no $f. Build it on the PC with deploy/make_bundle.py. Nothing was changed."
  done
  build="$(tr -d '[:space:]' < "$1/BUILD_ID")"
  [[ "$build" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "The bundle's BUILD_ID isn't valid. Rebuild it with make_bundle.py. Nothing was changed."
  ok "The bundle is complete (build $build)"
  "$PY" -I -B "$1/deploy/check_imports.py" "$1/public" \
    || die "Some of the app's imports don't resolve (see above), so it would not load. Nothing was changed."
  log="$STAGE/server-tests.log"
  info "Running the new code's server tests on temporary ports and folders (a minute or two)..."
  if ! (cd -- "$1" && run_limited 900 "$PY" -I -B tests/test_server.py) > "$log" 2>&1; then
    tail -n 40 -- "$log" >&2
    die "The new code failed its server tests (see above). Nothing was changed."
  fi
  summary="$(grep -E '^Ran [0-9]+ tests? ' "$log" | tail -n 1 || true)"
  case "$summary" in
    "" | "Ran 0 tests"*) die "The new code's server tests ran no tests at all, which can't count as passing. Nothing was changed." ;;
  esac
  ok "Server tests passed: $summary ($(tail -n 1 -- "$log"))"
  info "The client tests (node) ran on the PC when the bundle was built: make_bundle.py refuses to build otherwise."
}

journal() { printf '%s\n' "$*" >> "$JOURNAL"; }

swap_code() {  # $1 backup folder (gets code/), $2 source folder; data/ is skipped on both sides.
  # Journaled (in memory for undo_swap, on disk in swap.journal for a manual recovery).
  local keep="$1/code" src="$2" entry name
  mkdir -p -- "$keep"
  JOURNAL="$1/swap.journal"
  : > "$JOURNAL"
  MOVED=()
  PLACED=()
  shopt -s dotglob nullglob
  for entry in "$HUB_DIR"/*; do
    name="${entry##*/}"
    [ "$name" = data ] && continue
    mv -T -- "$entry" "$keep/$name"
    MOVED+=("$name")
    journal "moved $name"
  done
  for entry in "$src"/*; do
    name="${entry##*/}"
    [ "$name" = data ] && continue
    PLACED+=("$name")  # recorded first, so a half-finished copy is cleaned up too
    journal "placing $name"
    cp -a -T -- "$entry" "$HUB_DIR/$name"
  done
  shopt -u dotglob nullglob
  journal "complete"
  make_private
}

undo_swap() {  # $1 the same backup folder: remove what was placed, move back what was moved
  local keep="$1/code" name failed=0
  for name in "${PLACED[@]}"; do
    [ "$name" = data ] && continue
    rm -rf -- "${HUB_DIR:?}/$name" || failed=1
  done
  for name in "${MOVED[@]}"; do
    [ -e "$keep/$name" ] || continue
    mv -T -- "$keep/$name" "$HUB_DIR/$name" || failed=1
  done
  [ "$failed" = 1 ] || { MOVED=(); PLACED=(); printf 'undone\n' >> "$1/swap.journal"; }
  make_private || failed=1
  return "$failed"
}

roll_back_now() {  # $1 reason; puts the hub folder back exactly as it was before the swap
  local from="$SWAPPED_INTO"
  trap - ERR
  trap '' INT TERM HUP
  set +e
  SWAPPED_INTO=""
  printf '\n[FAIL] %s. Putting the previous code back from %s/code\n' "$1" "$from" >&2
  service stop >/dev/null 2>&1
  if ! undo_swap "$from"; then
    service off >/dev/null 2>&1  # a half-restored folder must not start at the next boot
    printf '[FAIL] Some files could not be put back, so the hub was stopped and disabled. The previous code is\n' >&2
    printf '       in %s/code and the list of what moved is in %s/swap.journal: copy the code back\n' "$from" "$from" >&2
    printf '       into %s by hand (everything except data/, which was not touched). Guide, section 8.\n' "$HUB_DIR" >&2
    exit 1
  fi
  refresh_unit
  if service enable && service start && run_verify; then
    printf '\n[FAIL] update.sh: failed and rolled back; data/ was not touched. Show the output above to the user.\n' >&2
  else
    service off >/dev/null 2>&1  # fail closed: never leave running a hub that failed its verification
    printf '\n[FAIL] update.sh: failed, and the previous code (put back) failed to start or to pass its verification\n' >&2
    printf '       too, so the hub was stopped and disabled (fail closed). data/ was not touched. Show the output\n' >&2
    printf '       above to the user (guide, section 8).\n' >&2
  fi
  exit 1
}

on_error() {
  [ "${BASH_SUBSHELL:-0}" -eq 0 ] || exit 1  # inside $(...) or (...): let the parent shell decide
  if [ -n "$SWAPPED_INTO" ]; then roll_back_now "A step failed (update.sh line $1)"; fi
  printf '[FAIL] update.sh stopped at line %s before changing the installed code (data/ is never changed).\n' "$1" >&2
  exit 1
}

on_signal() {
  if [ -n "$SWAPPED_INTO" ]; then roll_back_now "Interrupted"; fi
  printf '[FAIL] update.sh was interrupted before changing the installed code.\n' >&2
  exit 1
}

latest_stamp() {  # newest STAMP folder that holds saved code, or nothing (never fails)
  local names name found=""
  [ -d "$BACKUP_ROOT" ] || return 0
  names="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null || true)"
  while IFS= read -r name; do
    if [[ "$name" =~ ^[0-9]{8}-[0-9]{6}(-[0-9]+)?$ ]] && [ -f "$BACKUP_ROOT/$name/code/server.py" ]; then found="$name"; fi
  done < <(printf '%s\n' "$names" | sort)
  printf '%s' "$found"
}

do_update() {
  local bundle="$1" new pristine dest src
  guard_hub_dir
  [ -f "$HUB_DIR/server.py" ] || die "$HUB_DIR has no server.py. For a first install use install.sh (guide, step 3)."
  { [ -n "$PY" ] && [ -x "$PY" ]; } || die "python3 not found (${PY:-none})"
  [ -e "$bundle" ] || die "No such file: $bundle"
  require_unit

  step "1/5 Unpack the new bundle and check it (on a temporary copy)"
  STAGE="$(mktemp -d)"
  # Everything below comes from one private snapshot of the bundle: the tests run in one copy of
  # it, and the code installed is a second, pristine copy, never the tree the tests ran in.
  new="$STAGE/tested/fitness-hub"
  pristine="$STAGE/pristine/fitness-hub"
  if [ -d "$bundle" ]; then
    src="$(cd -- "$bundle" && pwd -P)"
    [ "$src" != "$(cd -- "$HUB_DIR" && pwd -P)" ] || die "That folder is the installed hub itself; give the new bundle."
    copy_tree "$src" "$pristine" || die "Couldn't copy $bundle. Nothing was changed."
    copy_tree "$pristine" "$new" || die "Couldn't copy $bundle. Nothing was changed."
  else
    cp -- "$bundle" "$STAGE/bundle.zip" || die "Couldn't read $bundle. Nothing was changed."
    extract_bundle "$STAGE/bundle.zip" "$STAGE/tested" || die "Couldn't unpack $bundle. Nothing was changed."
  fi
  check_staged "$new"

  step "2/5 Back up, then self-check the new code against the copy"
  dest="$(new_backup_dir)"
  if [ -f "$HUB_DIR/data/data.json" ]; then
    cp -p -- "$HUB_DIR/data/data.json" "$dest/data.json"
    chmod 600 -- "$dest/data.json"
    ok "Copied data/data.json to $dest/data.json"
  else
    warn "There is no data/data.json yet: nothing to copy"
  fi
  # The new server.py checks its settings (with the unit's phone-access settings, if any) and reads
  # the copy (never the live data/).
  local socket_env=() ts_env=()
  if [ "$SYSTEMD" = 1 ]; then
    socket_env=(FITNESS_HUB_SOCKET="/run/user/$(id -u)/fitness-hub/hub.sock" FITNESS_HUB_PORT=8642)
    mapfile -t ts_env < <(unit_ts_env)
  fi
  (cd -- "$new" && env -u FITNESS_HUB_HOST -u FITNESS_HUB_PORT -u FITNESS_HUB_SOCKET -u FITNESS_HUB_EXTRA_HOSTS \
      -u FITNESS_HUB_TIMEOUT_SCALE -u FITNESS_HUB_TS_SOCKET -u FITNESS_HUB_TS_HOST -u FITNESS_HUB_TS_USERS \
      "${socket_env[@]}" "${ts_env[@]}" FITNESS_HUB_DATA_DIR="$dest" "$PY" -I -B server.py --check) \
    || die "The new server.py failed its self-check. Nothing was changed (the copies in $dest are harmless)."
  if [ ! -d "$bundle" ]; then
    extract_bundle "$STAGE/bundle.zip" "$STAGE/pristine" >/dev/null \
      || die "Couldn't unpack the bundle a second time. Nothing was changed."
  fi
  { [ -f "$pristine/server.py" ] && cmp -s -- "$new/BUILD_ID" "$pristine/BUILD_ID"; } \
    || die "The pristine copy of the bundle doesn't match the tested one. Nothing was changed."
  ok "Unpacked a pristine copy to install (the tests ran in another copy)"

  step "3/5 Stop the hub and swap the code (data/ stays as it is)"
  trap '' INT TERM HUP  # this part takes well under a second: don't let a dropped SSH session cut it short
  service stop
  SWAPPED_INTO="$dest"
  swap_code "$dest" "$pristine"
  ok "New code in place and private; the previous code is in $dest/code"

  step "4/5 Enable and start"
  refresh_unit
  service enable
  service start
  ok "Service enabled (starts at boot) and started"
  trap on_signal INT TERM HUP  # from here an interruption rolls back

  step "5/5 Verify"
  run_verify || roll_back_now "Verification failed"
  SWAPPED_INTO=""
  printf '\nupdate: done. Saved copies: %s\n' "$dest"
  printf 'To undo it: bash %s/deploy/update.sh --rollback %s\n' "$HUB_DIR" "${dest##*/}"
}

do_rollback() {
  local stamp="${1:-}" keep
  if [ -n "$stamp" ] && ! [[ "$stamp" =~ ^[0-9]{8}-[0-9]{6}(-before-rollback)?(-[0-9]{1,3})?$ ]]; then
    die "'$stamp' is not a saved-copy name (like 20261121-153000, as listed by update.sh --list)."
  fi
  guard_hub_dir
  require_unit
  [ -n "$stamp" ] || stamp="$(latest_stamp)"
  [ -n "$stamp" ] && [ -f "$BACKUP_ROOT/$stamp/code/server.py" ] \
    || die "No saved code found in $BACKUP_ROOT/${stamp:-<none>}/code (see: update.sh --list)"
  keep="$(new_backup_dir -before-rollback)"
  step "Roll back to the code saved at $stamp (data/ stays as it is)"
  trap '' INT TERM HUP
  service stop
  SWAPPED_INTO="$keep"  # if anything below fails, the code from before this rollback goes back
  swap_code "$keep" "$BACKUP_ROOT/$stamp/code"
  ok "Saved code back in place and private; the code it replaced is in $keep/code"
  refresh_unit
  service enable
  service start
  trap on_signal INT TERM HUP
  run_verify || roll_back_now "The rolled-back hub failed verification"
  SWAPPED_INTO=""
  printf '\nrollback: done. Running the code saved at %s. data/ was not touched.\n' "$stamp"
}

do_list() {
  local d
  if [ ! -d "$BACKUP_ROOT" ]; then
    printf 'No saved copies yet (%s does not exist).\n' "$BACKUP_ROOT"
    return 0
  fi
  printf 'Saved copies in %s:\n' "$BACKUP_ROOT"
  for d in "$BACKUP_ROOT"/*/; do
    [ -d "$d" ] || continue
    d="${d%/}"
    printf '  %-34s code: %-3s data.json: %-3s swap: %s\n' "${d##*/}" \
      "$([ -f "$d/code/server.py" ] && echo yes || echo no)" "$([ -f "$d/data.json" ] && echo yes || echo no)" \
      "$(tail -n 1 -- "$d/swap.journal" 2>/dev/null || echo -)"
  done
}

one_at_a_time() {  # an exclusive lock, so two updates or rollbacks can never interleave
  command -v flock >/dev/null 2>&1 || { [ "$SYSTEMD" = 0 ] && return 0; die "flock not found (util-linux)"; }
  mkdir -p -- "$BACKUP_ROOT"
  exec 9> "$BACKUP_ROOT/.update.lock"
  chmod 600 -- "$BACKUP_ROOT/.update.lock"
  flock -n 9 || die "Another update.sh (update or rollback) is running. Wait for it to finish."
}

main() {
  [ "$(id -u)" -ne 0 ] || die "Run this as your normal user, not as root or with sudo."
  if [ "$SYSTEMD" = 1 ]; then user_bus; fi
  case "${1:-}" in "" | -h | --help | --list) ;; *) one_at_a_time ;; esac
  trap cleanup EXIT
  trap 'on_error $LINENO' ERR
  trap on_signal INT TERM HUP
  case "${1:-}" in
    --rollback) do_rollback "${2:-}" ;;
    --list) do_list ;;
    "" | -h | --help) usage ;;
    -*) usage; exit 2 ;;
    *) do_update "$1" ;;
  esac
}

# Run when executed (bash update.sh ...). The tests source this file to call its functions with a
# stand-in systemctl, and then main doesn't run.
if ! (return 0 2>/dev/null); then main "$@"; fi
