// System-audio ("They") capture via ScreenCaptureKit (PART 1 of the loopback fix).
//
// Electron's `audio:"loopback"` is WINDOWS-ONLY, so Loqui's macOS system-audio
// capture never worked. This class captures the system audio mix with
// ScreenCaptureKit (macOS 13+) and streams 16 kHz mono pcm_s16le frames to the
// host over the existing stdio line/JSON protocol (see Protocol.swift).
//
// It captures AUDIO ONLY: it adds an `.audio` stream output and configures a
// near-zero video path (2x2, huge frame interval) with no `.screen` output, so
// the video encoder does no real work. `excludesCurrentProcessAudio = true`
// guarantees we never re-capture Loqui's own output (no feedback loop).
//
// TCC: `SCShareableContent.excludingDesktopWindows(...)` triggers/checks the
// Screen Recording permission. A denial surfaces as a thrown error the host maps
// to `capture_denied`.
import Foundation

#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
import AVFoundation
import CoreMedia

/// A single-instance system-audio capturer. Constructed on `captureStart`, torn
/// down on `captureStop` / stdin EOF. Frames are delivered on a dedicated serial
/// queue and emitted through the caller's thread-safe `emitFrame` closure.
@available(macOS 13.0, *)
final class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    /// Emit one `captureFrame` (pcm_s16le 16 kHz mono base64, peak level 0..1).
    private let emitFrame: (String, Float) -> Void
    /// Emit an `error` reply (code, message) — used for asynchronous stream errors.
    private let emitError: (String, String) -> Void

    private var stream: SCStream?
    private let sampleQueue = DispatchQueue(label: "loqui.systemaudio.samples")

    /// Target output format: 16 kHz mono int16 little-endian.
    private let targetSampleRate: Double = 16_000

    /// Accumulates resampled int16 samples until we have ~100 ms (1600 samples),
    /// then flushes one frame. Guarded by `sampleQueue` (only the audio callback
    /// touches it), so no extra lock is needed.
    private var pending: [Int16] = []
    private let framePeriodSamples = 1600 // 100 ms @ 16 kHz

    /// Fractional resampler carry-over so decimation is continuous across buffers.
    private var resamplePhase: Double = 0

    init(
        emitFrame: @escaping (String, Float) -> Void,
        emitError: @escaping (String, String) -> Void
    ) {
        self.emitFrame = emitFrame
        self.emitError = emitError
        super.init()
    }

    /// Start capture. Calls `onReady` once the SCStream is running. Throws
    /// `EngineError.permissionDenied` when Screen Recording TCC is denied, or
    /// `EngineError.unavailable` when no display / stream can't be built.
    func start(onReady: @escaping () -> Void) throws {
        // Query shareable content — this triggers / checks the Screen Recording
        // TCC. A denial (or no permission yet) throws here.
        let content = try Self.shareableContentSync()
        guard let display = content.displays.first else {
            throw EngineError.unavailable("no display available for system-audio capture")
        }

        // AUDIO only: include the whole display, exclude nothing. We never read
        // the video frames (no `.screen` output) but SCStream still requires a
        // valid content filter + video config.
        let filter = SCContentFilter(display: display, excludingWindows: [])

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        // CRITICAL: never capture Loqui's own audio output (no feedback loop).
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 16_000
        config.channelCount = 1
        // Near-zero video path: tiny frame, huge interval, so the video encoder
        // does essentially no work (we add no `.screen` output anyway).
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1) // 1 fps
        config.queueDepth = 5

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        do {
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
        } catch {
            throw EngineError.unavailable("addStreamOutput(.audio) failed: \(error)")
        }
        self.stream = stream

        // startCapture is async; bridge to sync so `captureStart` can report the
        // outcome deterministically before the loop reads the next request.
        let sem = DispatchSemaphore(value: 0)
        var failure: Error?
        stream.startCapture { error in
            failure = error
            sem.signal()
        }
        sem.wait()
        if let failure = failure {
            self.stream = nil
            throw EngineError.unavailable("startCapture failed: \(failure)")
        }
        onReady()
    }

    /// Stop capture synchronously. Safe to call more than once.
    func stop() {
        guard let stream = stream else { return }
        self.stream = nil
        let sem = DispatchSemaphore(value: 0)
        stream.stopCapture { _ in sem.signal() }
        _ = sem.wait(timeout: .now() + 5)
    }

    // MARK: - SCShareableContent (sync bridge)

    /// Synchronously fetch shareable content. Rethrows the underlying error so the
    /// host can distinguish TCC denial (mapped to `capture_denied`) from other
    /// failures.
    @available(macOS 13.0, *)
    private static func shareableContentSync() throws -> SCShareableContent {
        let sem = DispatchSemaphore(value: 0)
        var content: SCShareableContent?
        var failure: Error?
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { result, error in
            content = result
            failure = error
            sem.signal()
        }
        sem.wait()
        if let failure = failure { throw failure }
        guard let content = content else {
            throw EngineError.unavailable("SCShareableContent returned nil")
        }
        return content
    }

    // MARK: - SCStreamDelegate

    func stream(_: SCStream, didStopWithError error: Error) {
        // The OS stopped the stream (e.g. permission revoked mid-capture). Report
        // it so the host can surface a failure rather than silently going quiet.
        self.stream = nil
        emitError("capture_failed", "stream stopped: \(error)")
    }

    // MARK: - SCStreamOutput (audio callback, on sampleQueue)

    func stream(_: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        guard sampleBuffer.isValid, CMSampleBufferDataIsReady(sampleBuffer) else { return }
        guard let mono16k = Self.extractMono16k(from: sampleBuffer, targetRate: targetSampleRate, phase: &resamplePhase)
        else { return }
        if mono16k.isEmpty { return }

        pending.append(contentsOf: mono16k)
        // Flush in ~100 ms frames; never emit gigantic lines.
        while pending.count >= framePeriodSamples {
            let chunk = Array(pending.prefix(framePeriodSamples))
            pending.removeFirst(framePeriodSamples)
            flush(chunk)
        }
    }

    /// Encode + emit one frame of 16 kHz mono int16 samples.
    private func flush(_ samples: [Int16]) {
        guard !samples.isEmpty else { return }
        var peak: Int16 = 0
        for s in samples {
            let a = (s == Int16.min) ? Int16.max : abs(s)
            if a > peak { peak = a }
        }
        let level = Float(peak) / 32768.0
        let le = samples.map { $0.littleEndian }
        let data = le.withUnsafeBytes { Data($0) }
        emitFrame(data.base64EncodedString(), level)
    }

    // MARK: - PCM extraction / downmix / resample

    /// Extract PCM from a `CMSampleBuffer` and return 16 kHz MONO int16 LE samples.
    /// Handles both float32 and int16 input and any channel count / input sample
    /// rate, downmixing to mono then resampling (linear/decimation) to 16 kHz.
    private static func extractMono16k(
        from sampleBuffer: CMSampleBuffer,
        targetRate: Double,
        phase: inout Double
    ) -> [Int16]? {
        guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)
        else { return nil }
        let asbd = asbdPtr.pointee
        let inputRate = asbd.mSampleRate > 0 ? asbd.mSampleRate : targetRate
        let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let isBigEndian = (asbd.mFormatFlags & kAudioFormatFlagIsBigEndian) != 0
        let isNonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
        let channels = Int(asbd.mChannelsPerFrame == 0 ? 1 : asbd.mChannelsPerFrame)

        // Pull the AudioBufferList backing the sample buffer.
        var blockBuffer: CMBlockBuffer?
        var abl = AudioBufferList()
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &abl,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else { return nil }

        let buffers = UnsafeMutableAudioBufferListPointer(&abl)

        // Decode each buffer to Float32, downmixed to mono.
        var mono: [Float] = []

        if isNonInterleaved {
            // One buffer per channel; each buffer holds `frames` samples for that
            // channel. Average across channels.
            let firstBytes = Int(buffers[0].mDataByteSize)
            let bytesPerSample = isFloat ? 4 : 2
            let frames = firstBytes / bytesPerSample
            guard frames > 0 else { return [] }
            mono = [Float](repeating: 0, count: frames)
            var usedChannels = 0
            for ch in 0..<buffers.count {
                guard let base = buffers[ch].mData else { continue }
                usedChannels += 1
                if isFloat {
                    let p = base.bindMemory(to: Float.self, capacity: frames)
                    for i in 0..<frames { mono[i] += p[i] }
                } else {
                    let p = base.bindMemory(to: Int16.self, capacity: frames)
                    for i in 0..<frames {
                        let v = isBigEndian ? Int16(bigEndian: p[i]) : Int16(littleEndian: p[i])
                        mono[i] += Float(v) / 32768.0
                    }
                }
            }
            if usedChannels > 1 {
                let inv = 1.0 / Float(usedChannels)
                for i in 0..<frames { mono[i] *= inv }
            }
        } else {
            // Interleaved: a single buffer with frame-major channel-interleaved
            // samples. Average the channels of each frame.
            guard let base = buffers[0].mData else { return [] }
            let byteSize = Int(buffers[0].mDataByteSize)
            let bytesPerSample = isFloat ? 4 : 2
            let totalSamples = byteSize / bytesPerSample
            guard totalSamples > 0, channels > 0 else { return [] }
            let frames = totalSamples / channels
            guard frames > 0 else { return [] }
            mono = [Float](repeating: 0, count: frames)
            let invCh = 1.0 / Float(channels)
            if isFloat {
                let p = base.bindMemory(to: Float.self, capacity: totalSamples)
                for f in 0..<frames {
                    var acc: Float = 0
                    let off = f * channels
                    for c in 0..<channels { acc += p[off + c] }
                    mono[f] = acc * invCh
                }
            } else {
                let p = base.bindMemory(to: Int16.self, capacity: totalSamples)
                for f in 0..<frames {
                    var acc: Float = 0
                    let off = f * channels
                    for c in 0..<channels {
                        let raw = p[off + c]
                        let v = isBigEndian ? Int16(bigEndian: raw) : Int16(littleEndian: raw)
                        acc += Float(v) / 32768.0
                    }
                    mono[f] = acc * invCh
                }
            }
        }

        guard !mono.isEmpty else { return [] }

        // Resample mono Float32 @ inputRate -> targetRate. If the OS already gave
        // us the target rate, this is a straight pass-through (ratio == 1).
        let resampled = resampleLinear(mono, inputRate: inputRate, targetRate: targetRate, phase: &phase)

        // Convert to int16 LE with clamping.
        var out = [Int16](repeating: 0, count: resampled.count)
        for i in 0..<resampled.count {
            let scaled = resampled[i] * 32767.0
            if scaled >= 32767.0 { out[i] = 32767 }
            else if scaled <= -32768.0 { out[i] = -32768 }
            else { out[i] = Int16(scaled.rounded()) }
        }
        return out
    }

    /// Linear-interpolation resampler with a persistent fractional phase so
    /// consecutive buffers join seamlessly. `phase` is the fractional read
    /// position (in input samples) carried across calls.
    private static func resampleLinear(
        _ input: [Float],
        inputRate: Double,
        targetRate: Double,
        phase: inout Double
    ) -> [Float] {
        if input.isEmpty { return [] }
        if abs(inputRate - targetRate) < 0.5 {
            phase = 0
            return input
        }
        let step = inputRate / targetRate // input samples advanced per output sample
        var out: [Float] = []
        out.reserveCapacity(Int(Double(input.count) / step) + 2)
        var pos = phase
        let n = input.count
        while pos < Double(n - 1) {
            let i0 = Int(pos)
            let frac = Float(pos - Double(i0))
            let a = input[i0]
            let b = input[i0 + 1]
            out.append(a + (b - a) * frac)
            pos += step
        }
        // Carry the leftover fractional position (relative to the buffer end) into
        // the next call so we don't drop/duplicate samples at the seam.
        phase = pos - Double(n)
        if phase < 0 { phase = 0 }
        return out
    }
}
#endif
