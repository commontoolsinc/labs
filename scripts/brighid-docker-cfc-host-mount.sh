#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ACTION="${1:-restart}"
MOUNT_NAME="${MOUNT_NAME:-ct-fuse-brighid-docker-cfc}"
MOUNTPOINT="${MOUNTPOINT:-/tmp/$MOUNT_NAME}"
IDENTITY="${IDENTITY:-/tmp/$MOUNT_NAME.id}"
API_URL="${API_URL:-https://toolshed.saga-castor.ts.net}"
DOCKER_RUNTIME="${BRIGHID_DOCKER_RUNTIME:-runsc-cfc}"

ensure_safe_mountpoint() {
  case "$MOUNTPOINT" in
    /tmp/*) ;;
    *)
      echo "error: refusing to reset non-/tmp mountpoint: $MOUNTPOINT" >&2
      exit 1
      ;;
  esac
}

print_env() {
  cat <<EOF
BRIGHID_FABRIC_HOST_PATH=$MOUNTPOINT
BRIGHID_SANDBOX_RUNTIME=docker-cfc
BRIGHID_DOCKER_RUNTIME=$DOCKER_RUNTIME
EOF
}

ensure_identity() {
  if [[ -s "$IDENTITY" ]]; then
    return
  fi

  (
    cd "$REPO_ROOT"
    deno task cf id new > "$IDENTITY"
  )
  chmod 600 "$IDENTITY"
}

force_cleanup() {
  ensure_safe_mountpoint

  (
    cd "$REPO_ROOT"
    deno task cf fuse unmount "$MOUNTPOINT" >/dev/null 2>&1 || true
  )

  if mount | grep -F " on $MOUNTPOINT " >/dev/null 2>&1; then
    umount "$MOUNTPOINT" >/dev/null 2>&1 || true
  fi

  if mount | grep -F " on $MOUNTPOINT " >/dev/null 2>&1 && command -v diskutil >/dev/null 2>&1; then
    diskutil unmount force "$MOUNTPOINT" >/dev/null 2>&1 || true
  fi

  rm -rf "$MOUNTPOINT"
  mkdir -p "$MOUNTPOINT"
}

restart_mount() {
  ensure_identity
  force_cleanup

  (
    cd "$REPO_ROOT"
    deno task cf fuse mount "$MOUNTPOINT" \
      --api-url="$API_URL" \
      --identity="$IDENTITY" \
      --allow-root \
      --background
  )

  echo
  print_env
}

case "$ACTION" in
  restart|start)
    restart_mount
    ;;
  stop)
    force_cleanup
    ;;
  status)
    (
      cd "$REPO_ROOT"
      deno task cf fuse status
    )
    ;;
  env)
    print_env
    ;;
  *)
    echo "usage: $(basename "$0") [restart|start|stop|status|env]" >&2
    exit 1
    ;;
esac
