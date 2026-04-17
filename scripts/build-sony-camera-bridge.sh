#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_SRC="${ROOT}/native/sony-camera-bridge"
BRIDGE_BUILD="${BRIDGE_SRC}/build-mac"

if ! command -v cmake &> /dev/null; then
  echo "cmake not found. Install it with: brew install cmake"
  exit 1
fi

rm -rf "${BRIDGE_BUILD}"
mkdir -p "${BRIDGE_BUILD}"
cd "${BRIDGE_BUILD}"

cmake \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  ..

cmake --build . --config Release

echo ""
echo "Built: ${ROOT}/vendor/sony-camera-bridge/mac-arm64/sony-camera-bridge"
