#!/usr/bin/env bash
# Build the macOS-native ASR helper (PRD-9). macOS + Xcode toolchain only.
#
# Usage:
#   ./build.sh                # Apple Speech only (default; no extra deps)
#   ./build.sh --foundation   # also enable the Apple Foundation Models GENERATIVE
#                             #   summary engine (macOS 26 SDK; needs Apple Intelligence
#                             #   at runtime). PRD-10: the real on-device summary.
#   ./build.sh --whisperkit   # also enable the WhisperKit/MLX ANE ASR path
#   ./build.sh --mlx          # also enable the bundled MLX generative summary engine
#   (flags combine, e.g. ./build.sh --foundation --whisperkit)
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
for arg in "$@"; do
  case "$arg" in
    --whisperkit)
      echo "Enabling WhisperKit path. Uncomment the WhisperKit dependency in Package.swift first."
      FLAGS+=(-Xswiftc -DWHISPERKIT) ;;
    --foundation)
      echo "Enabling Apple Foundation Models generative summary engine (macOS 26)."
      FLAGS+=(-Xswiftc -DFOUNDATION_MODELS) ;;
    --mlx)
      echo "Enabling bundled MLX summary engine. Add the MLX Swift package to Package.swift first."
      FLAGS+=(-Xswiftc -DMLX_SUMMARY) ;;
    *)
      echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

swift build -c release "${FLAGS[@]}"
BIN="$PWD/.build/release/loqui-asr-helper"
echo "Built: $BIN"
echo "Run the sidecar with: export LOQUI_ASR_HELPER_BIN=\"$BIN\""
