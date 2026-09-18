#!/usr/bin/env bash
# Вычисляет версию из conventional commits и создаёт git-тег/релиз (semantic-release).
# Пишет в GITHUB_OUTPUT: released=true|false и version=<x.y.z>.
set -euo pipefail

git fetch --tags --force >/dev/null 2>&1 || true
BEFORE="$(git describe --tags --abbrev=0 2>/dev/null || echo none)"

# semantic-release сам завершается 0 даже когда релиз не нужен.
npx semantic-release

git fetch --tags --force >/dev/null 2>&1 || true
AFTER="$(git describe --tags --abbrev=0 2>/dev/null || echo none)"

if [ "$AFTER" != "none" ] && [ "$AFTER" != "$BEFORE" ]; then
  echo "released=true" >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
  echo "version=${AFTER#v}" >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
  echo "Новый релиз: $AFTER"
else
  echo "released=false" >> "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
  echo "Релиз не требуется (нет feat/fix в коммитах)"
fi
