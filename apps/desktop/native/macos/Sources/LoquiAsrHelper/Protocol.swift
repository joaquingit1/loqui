// The line/JSON protocol shared with the Python sidecar (the host).
//
// Mirror of the protocol documented in
// loqui_sidecar/transcription/native_backend.py. One JSON object per line
// (\n-terminated, UTF-8) in each direction. PCM rides base64-encoded inside a
// `decode` request so the whole channel is a single line-oriented stream.
//
// Keep these shapes BYTE-COMPATIBLE with the Python side — the host parses by
// `type` and the camelCase field names below.
import Foundation

// MARK: - Host -> helper requests

/// A request line from the host. Decoded leniently: unknown `type`s are ignored.
///
/// PRD-10 adds the SUMMARY fields (`model`, `prompt`) used by the summary
/// requests (`summaryProbe` / `summaryStart` / `summaryGenerate` / `summaryStop`),
/// alongside the PRD-9 ASR fields. All optional so one struct decodes every line.
struct HostRequest: Decodable {
    let type: String
    let engine: String?
    let modelSize: String?
    let language: String?
    let sampleRate: Int?
    let pcmBase64: String?
    /// PRD-10 summary: the on-device model id (e.g. an MLX model id) for `summaryStart`.
    let model: String?
    /// PRD-10 summary: the USER prompt (the read-only transcript + the ask) for `summaryGenerate`.
    let prompt: String?
    /// PRD-10 summary: the SYSTEM instructions (the notetaker prompt) for `summaryGenerate`.
    /// Apple Foundation Models follows its `instructions` channel far more reliably
    /// than an inlined instruction blob, so the host sends them separately.
    let system: String?
}

// MARK: - Helper -> host replies

/// One recognized token with buffer-relative timestamps (seconds).
struct TokenWire: Encodable {
    let text: String
    let tStart: Double
    let tEnd: Double
}

enum HelperReply {
    case ready(engine: String, version: String)
    case capabilities(engines: [String], os: String, arch: String)
    case tokens(tokens: [TokenWire], final: Bool)
    case error(code: String, message: String)
    // PRD-10 summary replies (mirror of native_provider.py's summary protocol).
    case summaryCapabilities(engines: [String], os: String, arch: String)
    case summaryReady(engine: String, model: String?)
    /// Incremental chunk of the summary/chat answer, streamed as it generates so
    /// the renderer shows tokens immediately instead of waiting for the whole
    /// response. Always followed by a terminal `summaryResult` carrying the full
    /// text (so a client that ignores tokens still works).
    case summaryToken(delta: String)
    case summaryResult(text: String)
    // System-audio capture replies (the loopback fix). The host streams these
    // pcm frames into the same pipeline the mic ("Me") audio feeds.
    /// SCStream is running and about to deliver frames.
    case captureReady
    /// One chunk of captured system audio: pcm_s16le 16 kHz MONO, base64-encoded,
    /// with `level` = peak |sample| / 32768 in 0..1 for a live meter.
    case captureFrame(pcmBase64: String, level: Float)
    /// Terminal ack for `captureStop` — capture has fully stopped.
    case captureStopped

    /// Serialize to a single JSON line (no embedded newline).
    func jsonLine() -> String {
        let obj: [String: Any]
        switch self {
        case let .ready(engine, version):
            obj = ["type": "ready", "engine": engine, "version": version]
        case let .capabilities(engines, os, arch):
            obj = ["type": "capabilities", "engines": engines, "os": os, "arch": arch]
        case let .tokens(tokens, final):
            obj = [
                "type": "tokens",
                "final": final,
                "tokens": tokens.map { ["text": $0.text, "tStart": $0.tStart, "tEnd": $0.tEnd] },
            ]
        case let .error(code, message):
            obj = ["type": "error", "code": code, "message": message]
        case let .summaryCapabilities(engines, os, arch):
            obj = ["type": "summaryCapabilities", "engines": engines, "os": os, "arch": arch]
        case let .summaryReady(engine, model):
            obj = ["type": "summaryReady", "engine": engine, "model": (model ?? NSNull()) as Any]
        case let .summaryToken(delta):
            obj = ["type": "summaryToken", "delta": delta]
        case let .summaryResult(text):
            obj = ["type": "summaryResult", "text": text]
        case .captureReady:
            obj = ["type": "captureReady"]
        case let .captureFrame(pcmBase64, level):
            obj = ["type": "captureFrame", "pcmBase64": pcmBase64, "level": level]
        case .captureStopped:
            obj = ["type": "captureStopped"]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let line = String(data: data, encoding: .utf8)
        else {
            return "{\"type\":\"error\",\"code\":\"encode\",\"message\":\"failed to encode reply\"}"
        }
        return line
    }
}

/// Decode a 16-bit little-endian PCM buffer (base64) to Float32 samples in
/// [-1, 1) for the recognizers.
func decodePcmFloat(_ base64: String) -> [Float] {
    guard let data = Data(base64Encoded: base64) else { return [] }
    let count = data.count / 2
    var out = [Float](repeating: 0, count: count)
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        let ints = raw.bindMemory(to: Int16.self)
        for i in 0..<count {
            out[i] = Float(Int16(littleEndian: ints[i])) / 32768.0
        }
    }
    return out
}
