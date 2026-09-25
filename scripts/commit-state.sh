#!/usr/bin/env bash
# Commit + push d'un état (data/*.json, builds/…) avec retries et résolution de conflit.
#
# Usage : scripts/commit-state.sh "message de commit" chemin1 [chemin2 …]
#
# - fichiers : ajoutés avec -f (même s'ils sont ignorés)
# - dossiers : ajoutés avec -A (suppressions incluses, .gitignore respecté)
# - conflit au rebase : on repart de origin/main (reset --hard) et on réapplique
#   UNIQUEMENT les chemins de cet état → jamais d'écrasement des autres fichiers
#   (l'ancien « reset --soft » pouvait annuler les commits des autres workflows).
#
# Env : COMMIT_MAX_ATTEMPTS (8), COMMIT_SOFT_FAIL=1 → exit 0 si push impossible.
set -euo pipefail

MSG="${1:?message de commit requis}"
shift
[ "$#" -gt 0 ] || { echo "commit-state: aucun chemin"; exit 0; }

MAX="${COMMIT_MAX_ATTEMPTS:-8}"
BRANCH="${COMMIT_BRANCH:-main}"

git config user.name >/dev/null 2>&1 || git config user.name "github-actions[bot]"
git config user.email >/dev/null 2>&1 || git config user.email "github-actions[bot]@users.noreply.github.com"

SNAP="$(mktemp -d)"
trap 'rm -rf "$SNAP"' EXIT

stage() {
  for p in "$@"; do
    if [ -d "$p" ]; then
      git add -A -- "$p"
    elif [ -e "$p" ]; then
      git add -f -- "$p"
    elif git ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
      git add -A -- "$p"   # fichier supprimé
    fi
  done
}

snapshot() {
  for p in "$@"; do
    [ -e "$p" ] || continue
    mkdir -p "$SNAP/$(dirname "$p")"
    cp -a "$p" "$SNAP/$p"
  done
}

restore() {
  for p in "$@"; do
    if [ -e "$SNAP/$p" ]; then
      rm -rf "$p"
      mkdir -p "$(dirname "$p")"
      cp -a "$SNAP/$p" "$p"
    fi
  done
}

stage "$@"
if git diff --cached --quiet; then
  echo "commit-state: aucun changement"
  exit 0
fi
snapshot "$@"
git commit -q -m "$MSG"

for i in $(seq 1 "$MAX"); do
  git fetch -q origin "$BRANCH"
  if git rebase -q "origin/$BRANCH" >/dev/null 2>&1; then
    if git push -q origin "HEAD:$BRANCH"; then
      echo "commit-state: push OK (tentative $i) — $MSG"
      exit 0
    fi
  else
    echo "commit-state: conflit — réapplication de l'état sur origin/$BRANCH"
    git rebase --abort 2>/dev/null || true
    git reset -q --hard "origin/$BRANCH"
    restore "$@"
    stage "$@"
    if git diff --cached --quiet; then
      echo "commit-state: état déjà identique sur origin"
      exit 0
    fi
    git commit -q -m "$MSG"
    if git push -q origin "HEAD:$BRANCH"; then
      echo "commit-state: push OK après conflit (tentative $i)"
      exit 0
    fi
  fi
  sleep $(( i * 2 ))
done

echo "::error::commit-state: push impossible après $MAX tentatives — $MSG"
if [ "${COMMIT_SOFT_FAIL:-0}" = "1" ]; then exit 0; fi
exit 1
