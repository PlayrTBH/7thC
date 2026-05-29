#!/usr/bin/env bash
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  echo "Please run update.sh as a script, not with source, so failures cannot close your shell." >&2
  return 1
fi

set -euo pipefail

APP_NAME="7th Circle Team Hub"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATE_MODE="${UPDATE_MODE:-auto}"

say() {
  printf '\n\033[1m%s\033[0m\n' "$*"
}

note() {
  printf '  %s\n' "$*"
}

prompt_yes_no() {
  local label="$1"
  local default_value="$2"
  local answer=""
  local suffix="[y/N]"

  if [[ "$default_value" == "y" ]]; then
    suffix="[Y/n]"
  fi

  while true; do
    printf '%s %s: ' "$label" "$suffix"
    IFS= read -r answer
    answer="${answer:-$default_value}"
    case "${answer,,}" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
      *) note "Please answer yes or no." ;;
    esac
  done
}

ensure_clean_checkout() {
  if ! git diff --quiet || ! git diff --cached --quiet; then
    note "This checkout has uncommitted tracked changes. Commit/stash them before updating."
    git status --short
    return 1
  fi
}

pull_latest() {
  if [[ ! -d .git ]]; then
    note "This directory is not a git checkout: $SCRIPT_DIR"
    note "Run update.sh from the installed repository directory."
    return 1
  fi

  ensure_clean_checkout

  local branch
  branch="$(git branch --show-current)"
  say "Fetching latest changes"
  git fetch --all --prune

  say "Updating ${branch:-current checkout}"
  if [[ -n "$branch" ]]; then
    git pull --ff-only origin "$branch"
  else
    git pull --ff-only
  fi
}

docker_service_exists() {
  command -v docker >/dev/null 2>&1 && [[ -f docker-compose.yml ]] && docker compose ps --services 2>/dev/null | grep -qx 'discord-team-hub'
}

run_docker_update() {
  if ! command -v docker >/dev/null 2>&1; then
    note "Docker was not found. Cannot run Docker update."
    return 1
  fi
  if [[ ! -f docker-compose.yml ]]; then
    note "docker-compose.yml was not found. Cannot run Docker update."
    return 1
  fi

  say "Rebuilding and restarting Docker service"
  docker compose up -d --build
}

run_local_update() {
  if ! command -v npm >/dev/null 2>&1; then
    note "npm was not found. Install Node.js 20+ before running local update."
    return 1
  fi

  say "Installing dependencies"
  npm install

  say "Building app"
  npm run build

  note "Local build updated. Restart your running process/service so it uses the new dist files."
}

cd "$SCRIPT_DIR"
say "$APP_NAME updater"

pull_latest

case "$UPDATE_MODE" in
  docker)
    run_docker_update
    ;;
  local)
    run_local_update
    ;;
  skip)
    note "Skipped build/restart because UPDATE_MODE=skip."
    ;;
  auto)
    if docker_service_exists; then
      run_docker_update
    elif [[ -t 0 ]] && prompt_yes_no "Use Docker Compose for this update?" "n"; then
      run_docker_update
    else
      run_local_update
    fi
    ;;
  *)
    note "Unknown UPDATE_MODE '$UPDATE_MODE'. Use auto, docker, local, or skip."
    exit 1
    ;;
esac

say "Update complete"
note "If your Cloudflare Tunnel points at this app, verify it with: curl -v http://127.0.0.1:3000"
