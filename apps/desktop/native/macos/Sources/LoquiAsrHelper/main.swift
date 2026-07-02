// loqui-asr-helper entry point — the line/JSON protocol loop (PRD-9).
//
// Reads one JSON request per line from stdin and writes one JSON reply per line
// to stdout, per the protocol in Protocol.swift / native_backend.py. It is a
// passive, host-driven loop: the Python sidecar owns the windowing + the
// streaming policy; the helper only runs the chosen on-device recognizer.
//
// Lifecycle:
//   probe                 -> capabilities (then keep reading; host may close)
//   start{engine,...}     -> ready  (or error -> host falls back)
//   decode{pcmBase64}     -> tokens (one per decode)
//   stop                  -> release the engine
//   EOF on stdin          -> exit (parent gone)
import Foundation

setbuf(stdout, nil) // line-flush each reply promptly.

// stdout line atomicity: capture frames are emitted from the SCStream callback
// queue WHILE the main loop blocks on `readLine()`, so two threads write stdout
// concurrently. Funnel EVERY reply through one lock and flush each line so lines
// never interleave.
let stdoutLock = NSLock()

func emit(_ reply: HelperReply) {
    let line = reply.jsonLine()
    stdoutLock.lock()
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
    stdoutLock.unlock()
}

var engine: AsrEngine?
var summaryEngine: SummaryEngine?  // PRD-10: the active on-device summary engine.

// System-audio ("They") capture state (the loopback fix). Only ever touched from
// the main request loop; the capturer's frames flow through the thread-safe
// `emit` above.
#if canImport(ScreenCaptureKit)
var systemAudioCapture: AnyObject?  // SystemAudioCapture, boxed to avoid @available on the var.
#endif

while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    guard let data = line.data(using: .utf8),
          let req = try? JSONDecoder().decode(HostRequest.self, from: data)
    else {
        emit(.error(code: "bad_request", message: "could not parse line"))
        continue
    }

    switch req.type {
    case "probe":
        emit(.capabilities(engines: probeEngines(), os: "darwin", arch: currentArch()))

    case "start":
        do {
            engine?.stop()
            let e = try makeEngine(req)
            engine = e
            emit(.ready(engine: req.engine ?? "unknown", version: "1.0.0"))
        } catch let EngineError.permissionDenied(msg) {
            emit(.error(code: "permission_denied", message: msg))
        } catch let EngineError.unavailable(msg) {
            emit(.error(code: "unavailable", message: msg))
        } catch {
            emit(.error(code: "start_failed", message: "\(error)"))
        }

    case "decode":
        guard let e = engine else {
            emit(.error(code: "not_started", message: "decode before start"))
            continue
        }
        let samples = decodePcmFloat(req.pcmBase64 ?? "")
        do {
            let (tokens, final) = try e.decode(samples, sampleRate: req.sampleRate ?? 16000)
            emit(.tokens(tokens: tokens, final: final))
        } catch {
            emit(.error(code: "decode_failed", message: "\(error)"))
        }

    case "stop":
        engine?.stop()
        engine = nil

    // --- PRD-10 summary protocol -------------------------------------------
    case "summaryProbe":
        emit(.summaryCapabilities(engines: probeSummaryEngines(), os: "darwin", arch: currentArch()))

    case "summaryStart":
        do {
            summaryEngine?.stop()
            let e = try makeSummaryEngine(req)
            summaryEngine = e
            emit(.summaryReady(engine: req.engine ?? "unknown", model: req.model))
        } catch let EngineError.permissionDenied(msg) {
            emit(.error(code: "permission_denied", message: msg))
        } catch let EngineError.unavailable(msg) {
            emit(.error(code: "unavailable", message: msg))
        } catch {
            emit(.error(code: "summary_start_failed", message: "\(error)"))
        }

    case "summaryGenerate":
        guard let e = summaryEngine else {
            emit(.error(code: "not_started", message: "summaryGenerate before summaryStart"))
            continue
        }
        do {
            // Stream incremental chunks as `summaryToken` so the renderer shows
            // the answer as it generates, then send the terminal `summaryResult`
            // with the full text (a client that ignores tokens still works).
            let text = try e.generateStream(req.prompt ?? "", instructions: req.system) { delta in
                emit(.summaryToken(delta: delta))
            }
            emit(.summaryResult(text: text))
        } catch let EngineError.unavailable(msg) {
            emit(.error(code: "unavailable", message: msg))
        } catch {
            emit(.error(code: "summary_failed", message: "\(error)"))
        }

    case "summaryStop":
        summaryEngine?.stop()
        summaryEngine = nil

    // --- System-audio capture protocol (the loopback fix) ------------------
    case "captureStart":
        #if canImport(ScreenCaptureKit)
        if #available(macOS 13.0, *) {
            if systemAudioCapture != nil {
                emit(.error(code: "capture_failed", message: "capture already running"))
                continue
            }
            let capture = SystemAudioCapture(
                emitFrame: { pcmBase64, level in
                    emit(.captureFrame(pcmBase64: pcmBase64, level: level))
                },
                emitError: { code, message in
                    emit(.error(code: code, message: message))
                }
            )
            do {
                try capture.start { emit(.captureReady) }
                systemAudioCapture = capture
            } catch let EngineError.permissionDenied(msg) {
                emit(.error(code: "capture_denied", message: msg))
            } catch let EngineError.unavailable(msg) {
                emit(.error(code: "capture_failed", message: msg))
            } catch {
                // SCShareableContent throws its own error type on TCC denial; the
                // Screen Recording permission maps to `capture_denied`.
                emit(.error(code: "capture_denied", message: "\(error)"))
            }
        } else {
            emit(.error(code: "capture_unavailable", message: "system-audio capture requires macOS 13 or later"))
        }
        #else
        emit(.error(code: "capture_unavailable", message: "ScreenCaptureKit not available in this build"))
        #endif

    case "captureStop":
        #if canImport(ScreenCaptureKit)
        if #available(macOS 13.0, *), let capture = systemAudioCapture as? SystemAudioCapture {
            capture.stop()
        }
        systemAudioCapture = nil
        #endif
        // Terminal ack — always sent, even if no capture was active (harmless).
        emit(.captureStopped)

    default:
        // Unknown request type: ignore (forward-compatible).
        continue
    }
}

// stdin EOF (parent gone): tear down all engines and stop capture.
engine?.stop()
summaryEngine?.stop()
#if canImport(ScreenCaptureKit)
if #available(macOS 13.0, *), let capture = systemAudioCapture as? SystemAudioCapture {
    capture.stop()
}
systemAudioCapture = nil
#endif
