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

func emit(_ reply: HelperReply) {
    print(reply.jsonLine())
}

var engine: AsrEngine?
var summaryEngine: SummaryEngine?  // PRD-10: the active on-device summary engine.

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
            let text = try e.generate(req.prompt ?? "")
            emit(.summaryResult(text: text))
        } catch let EngineError.unavailable(msg) {
            emit(.error(code: "unavailable", message: msg))
        } catch {
            emit(.error(code: "summary_failed", message: "\(error)"))
        }

    case "summaryStop":
        summaryEngine?.stop()
        summaryEngine = nil

    default:
        // Unknown request type: ignore (forward-compatible).
        continue
    }
}

engine?.stop()
summaryEngine?.stop()
