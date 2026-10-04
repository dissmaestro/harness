#!/bin/sh
# Builds the Arch package from this checkout without network access.
# Usage: packaging/arch/build.sh [makepkg args, e.g. --nocheck]
# Then install: sudo pacman -U packaging/arch/local-agent-<ver>-1-any.pkg.tar.zst
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
ver=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$root/package.json")
sed -i "s/^pkgver=.*/pkgver=$ver/" "$here/PKGBUILD"

tarball="$here/local-agent-$ver.tar.gz"
rm -f "$tarball"
if git -C "$root" rev-parse --git-dir >/dev/null 2>&1 && [ -z "$(git -C "$root" status --porcelain -- . ':!node_modules' ':!packaging/arch')" ]; then
  echo "==> Packing HEAD with git archive"
  git -C "$root" archive --format=tar.gz --prefix="local-agent-$ver/" -o "$tarball" HEAD
else
  echo "==> Uncommitted changes: packing the working tree"
  tar -czf "$tarball" -C "$root" \
    --exclude=./node_modules --exclude=./.git --exclude=./.claude --exclude=./packaging \
    --transform "s,^\.,local-agent-$ver," .
fi

cd "$here"
makepkg -f "$@"
