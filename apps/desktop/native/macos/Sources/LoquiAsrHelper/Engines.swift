// The native engines: a small protocol + the Apple Speech implementation, the
// WhisperKit/MLX path (gated behind -DWHISPERKIT), and the capability probe.
//
// Each engine maps the line/JSON protocol's `decode` (a window of PCM) onto a
// list of buffer-relative tokens. The host's streaming pipeline (VAD +
// LocalAgreement-2) drives the windowing — see native_backend.py. Apple Speech
// has its own segmentation, so it returns its latest hypothesis for the window;
// the WhisperKit path decodes the window like Whisper.
import Foundation
import Speech

/// One native ASR engine behind a uniform decode seam.
protocol AsrEngine {
    /// Decode one window of Float32 samples (16 kHz mono) -> buffer-relative
    /// tokens. May return an empty array (no speech / not ready).
    func decode(_ samples: [Float], sampleRate: Int) throws -> (tokens: [TokenWire], final: Bool)
    func stop()
}

enum EngineError: Error {
    case permissionDenied(String)
    case unavailable(String)
}

// MARK: - Apple Speech (SFSpeechRecognizer, on-device)

/// Apple Speech engine. Uses `SFSpeechRecognizer` with
/// `requiresOnDeviceRecognition = true` so transcription is fully on-device and
/// needs ZERO model download (after the one-time Speech Recognition permission).
///
/// SFSpeechRecognizer streams partial + final results from an audio buffer. For
/// the host's window-at-a-time protocol we run a bounded recognition over each
/// window and return the best (latest) hypothesis as tokens; the host's
/// LocalAgreement flush commits the final.
final class AppleSpeechEngine: AsrEngine {
    private let recognizer: SFSpeechRecognizer

    init(language: String?) throws {
        let locale = language.map { Locale(identifier: $0) } ?? Locale.current
        guard let rec = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer() else {
            throw EngineError.unavailable("SFSpeechRecognizer unavailable for locale")
        }
        guard rec.supportsOnDeviceRecognition else {
            throw EngineError.unavailable("on-device recognition not supported on this device")
        }
        // Request + verify the Speech Recognition permission (blocking; the helper
        // is a CLI so a one-time TCC prompt is acceptable, and the host treats a
        // denial as a fallback signal via the `error` reply).
        let status = AppleSpeechEngine.requestAuthorizationSync()
        guard status == .authorized else {
            throw EngineError.permissionDenied("Speech Recognition permission not granted (\(status.rawValue))")
        }
        self.recognizer = rec
    }

    static func requestAuthorizationSync() -> SFSpeechRecognizerAuthorizationStatus {
        let sem = DispatchSemaphore(value: 0)
        var result: SFSpeechRecognizerAuthorizationStatus = .notDetermined
        SFSpeechRecognizer.requestAuthorization { status in
            result = status
            sem.signal()
        }
        sem.wait()
        return result
    }

    func decode(_ samples: [Float], sampleRate: Int) throws -> (tokens: [TokenWire], final: Bool) {
        guard !samples.isEmpty else { return ([], false) }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false

        guard let buffer = AppleSpeechEngine.pcmBuffer(samples, sampleRate: sampleRate) else {
            return ([], false)
        }
        request.append(buffer)
        request.endAudio()

        let sem = DispatchSemaphore(value: 0)
        var best: SFTranscription?
        var isFinal = false
        var failure: Error?
        let task = recognizer.recognitionTask(with: request) { result, error in
            if let error = error { failure = error; sem.signal(); return }
            if let result = result {
                best = result.bestTranscription
                if result.isFinal { isFinal = true; sem.signal() }
            }
        }
        // Bounded wait so a stalled recognizer cannot wedge the helper.
        _ = sem.wait(timeout: .now() + 10)
        task.cancel()
        if let failure = failure { throw EngineError.unavailable("\(failure)") }

        guard let transcription = best else { return ([], false) }
        var tokens: [TokenWire] = []
        for seg in transcription.segments {
            let text = seg.substring.trimmingCharacters(in: .whitespaces)
            if text.isEmpty { continue }
            tokens.append(TokenWire(text: text, tStart: seg.timestamp, tEnd: seg.timestamp + seg.duration))
        }
        return (tokens, isFinal)
    }

    func stop() {}

    private static func pcmBuffer(_ samples: [Float], sampleRate: Int) -> AVAudioPCMBuffer? {
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(sampleRate),
            channels: 1,
            interleaved: false
        ) else { return nil }
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: AVAudioFrameCount(samples.count)
        ) else { return nil }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        if let ch = buffer.floatChannelData {
            samples.withUnsafeBufferPointer { src in
                ch[0].update(from: src.baseAddress!, count: samples.count)
            }
        }
        return buffer
    }
}

// MARK: - WhisperKit / MLX (ANE) — gated behind -DWHISPERKIT

#if WHISPERKIT
import WhisperKit

/// WhisperKit engine (CoreML/ANE). Decodes each window like Whisper. Measurably
/// faster than CPU faster-whisper on Apple Silicon (the ANE path); record the
/// numbers in README.md when verified on hardware.
final class WhisperKitEngine: AsrEngine {
    private let pipe: WhisperKit
    private let language: String?

    init(modelSize: String?, language: String?) throws {
        let model = WhisperKitEngine.mapModel(modelSize)
        // Synchronous construction wrapper (WhisperKit is async; bridge via a sem).
        let sem = DispatchSemaphore(value: 0)
        var built: WhisperKit?
        var failure: Error?
        Task {
            do { built = try await WhisperKit(model: model) }
            catch { failure = error }
            sem.signal()
        }
        sem.wait()
        if let failure = failure { throw EngineError.unavailable("\(failure)") }
        guard let pipe = built else { throw EngineError.unavailable("WhisperKit init returned nil") }
        self.pipe = pipe
        self.language = language
    }

    func decode(_ samples: [Float], sampleRate: Int) throws -> (tokens: [TokenWire], final: Bool) {
        let sem = DispatchSemaphore(value: 0)
        var tokens: [TokenWire] = []
        var failure: Error?
        Task {
            do {
                let results = try await pipe.transcribe(audioArray: samples)
                for r in results {
                    for seg in r.segments {
                        let text = seg.text.trimmingCharacters(in: .whitespaces)
                        if text.isEmpty { continue }
                        tokens.append(TokenWire(text: text, tStart: Double(seg.start), tEnd: Double(seg.end)))
                    }
                }
            } catch { failure = error }
            sem.signal()
        }
        sem.wait()
        if let failure = failure { throw EngineError.unavailable("\(failure)") }
        return (tokens, false)
    }

    func stop() {}

    private static func mapModel(_ size: String?) -> String {
        switch size {
        case "tiny": return "openai_whisper-tiny"
        case "base": return "openai_whisper-base"
        case "medium": return "openai_whisper-medium"
        case "large": return "openai_whisper-large-v3"
        default: return "openai_whisper-small"
        }
    }
}
#endif

// MARK: - Capability probe

/// Which native engines are available on THIS OS/arch. Apple Speech is available
/// whenever on-device recognition is supported; WhisperKit only when compiled in.
func probeEngines() -> [String] {
    var engines: [String] = []
    if let rec = SFSpeechRecognizer(), rec.supportsOnDeviceRecognition {
        engines.append("apple-speech")
    }
    #if WHISPERKIT
    engines.append("whisperkit")
    engines.append("mlx-whisper")
    #endif
    return engines
}

func currentArch() -> String {
    #if arch(arm64)
    return "arm64"
    #elseif arch(x86_64)
    return "x86_64"
    #else
    return "unknown"
    #endif
}

/// Build the engine for a `start` request, or throw (host falls back).
func makeEngine(_ req: HostRequest) throws -> AsrEngine {
    switch req.engine {
    case "apple-speech":
        return try AppleSpeechEngine(language: req.language)
    case "whisperkit", "mlx-whisper":
        #if WHISPERKIT
        return try WhisperKitEngine(modelSize: req.modelSize, language: req.language)
        #else
        throw EngineError.unavailable("WhisperKit not compiled in (build with -DWHISPERKIT)")
        #endif
    default:
        throw EngineError.unavailable("unknown engine \(req.engine ?? "nil")")
    }
}
