// swift-tools-version:5.9
//
// loqui-asr-helper — the macOS-native on-device ASR helper (PRD-9).
//
// A small, notarizable command-line binary the Python sidecar spawns and streams
// 16 kHz mono pcm_s16le to over a line-delimited JSON protocol (see README.md and
// loqui_sidecar/transcription/native_backend.py). It exposes:
//   * Apple Speech  — SFSpeechRecognizer, requiresOnDeviceRecognition = true.
//   * WhisperKit/MLX — an ANE-accelerated Whisper path (optional dependency).
//   * a capability probe — which engines are available on this OS/arch.
//
// Build:  ./build.sh   (or: swift build -c release)
// Output: .build/release/loqui-asr-helper  (PRD-8 bundles + notarizes it).
//
// WhisperKit is an OPTIONAL dependency, gated behind the `WHISPERKIT` compile
// flag, so the default build needs only the system Speech framework (zero extra
// download, fastest CI). Enable it with: swift build -c release -Xswiftc -DWHISPERKIT
// after adding the package dependency below.
import PackageDescription

let package = Package(
    name: "loqui-asr-helper",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "loqui-asr-helper", targets: ["LoquiAsrHelper"]),
    ],
    dependencies: [
        // Uncomment to enable the WhisperKit/MLX ANE path (build with -DWHISPERKIT):
        // .package(url: "https://github.com/argmaxinc/WhisperKit.git", from: "0.9.0"),
    ],
    targets: [
        .executableTarget(
            name: "LoquiAsrHelper",
            dependencies: [
                // .product(name: "WhisperKit", package: "WhisperKit"),
            ],
            path: "Sources/LoquiAsrHelper"
        ),
    ]
)
