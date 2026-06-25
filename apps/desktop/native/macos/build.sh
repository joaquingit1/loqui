#!/usr/bin/env bash
# Build the macOS-native ASR helper (PRD-9). macOS + Xcode toolchain only.
#
# Usage:
#   ./build.sh                # Apple Speech only (default; no extra deps)
#   ./build.sh --whisperkit   # also enable the WhisperKit/MLX ANE path
#
# Output: .build/release/loqui-asr-helper
# Point the sidecar at it with:  export LOQUI_ASR_HELPER_BIN="$PWD/.build/release/loqui-asr-helper"
# PRD-8 packaging bundles + notarizes this binary into the app.
set -euo pipefail

cd "$(dirname "$0")"

if [[ "${OSTYPE:-}" != darwin* ]]; then
  echo "loqui-asr-helper builds on macOS only (needs the Speech framework)." >&2
  exit 1
fi

FLAGS=()
if [[ "${1:-}" == "--whisperkit" ]]; then
  echo "Enabling WhisperKit path. Uncomment the WhisperKit dependency in Package.swift first."
  FLAGS+=(-Xswiftc -DWHISPERKIT)
fi

swift build -c release "${FLAGS[@]}"
BIN="$PWD/.build/release/loqui-asr-helper"
echo "Built: $BIN"
echo "Run the sidecar with: export LOQUI_ASR_HELPER_BIN=\"$BIN\""
