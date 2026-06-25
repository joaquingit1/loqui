// PRD-10 — native on-device SUMMARY engines for the helper.
//
// Adds a uniform `SummaryEngine` seam + three implementations behind the SAME
// line/JSON protocol the host (loqui_sidecar/providers/native_provider.py) drives:
//
//   * apple-foundation — Apple Foundation Models (the macOS 26 on-device
//     Apple-Intelligence LLM). Preferred GENERATIVE target. Gated behind
//     `-DFOUNDATION_MODELS` (the FoundationModels framework ships on macOS 26+);
//     availability is also probed at runtime so the host degrades gracefully.
//   * apple-nl — Apple NaturalLanguage EXTRACTIVE fallback (always available on
//     macOS 13+). Picks the most salient sentences as highlights — zero download,
//     zero key, no LLM. Used when Foundation Models is unavailable.
//   * mlx — a bundled small instruct model (Qwen/Gemma-class) via MLX on Apple
//     Silicon. Gated behind `-DMLX_SUMMARY`; the model is fetched on first use
//     (the first-run fetch seam) then runs fully offline.
//
// Each engine maps the protocol's `summaryGenerate` (a full prompt incl. the
// read-only transcript) onto ONE generated/extracted text string. The host treats
// the whole result as a single delta — request/response, not a token stream.
//
// READ-ONLY: these engines receive only the prompt text and return text. They are
// handed no file handle and never touch any transcript/meta file — the invariant
// "the AI never edits the transcript" holds for the native path too.
import Foundation
import NaturalLanguage

/// One native summary engine behind a uniform generate seam.
protocol SummaryEngine {
    /// Generate (or extract) a summary for the given prompt. The prompt already
    /// contains the read-only transcript (spliced in by the host). Returns the
    /// result text; may throw `EngineError` (host maps it to an `error` reply).
    func generate(_ prompt: String) throws -> String
    func stop()
}

// MARK: - Apple Foundation Models (generative, on-device) — -DFOUNDATION_MODELS

#if FOUNDATION_MODELS
import FoundationModels

/// Apple Foundation Models engine — the on-device Apple-Intelligence LLM.
/// Available only when the OS supports it AND Apple Intelligence is enabled; the
/// initializer throws `EngineError.unavailable` otherwise so the host falls back
/// to apple-nl (or, on the host side, to Ollama / cloud).
final class AppleFoundationEngine: SummaryEngine {
    private let session: LanguageModelSession

    init() throws {
        let model = SystemLanguageModel.default
        switch model.availability {
        case .available:
            self.session = LanguageModelSession(model: model)
        case let .unavailable(reason):
            throw EngineError.unavailable("Apple Foundation Models unavailable: \(reason)")
        }
    }

    func generate(_ prompt: String) throws -> String {
        let sem = DispatchSemaphore(value: 0)
        var out = ""
        var failure: Error?
        Task {
            do {
                let response = try await session.respond(to: prompt)
                out = response.content
            } catch {
                failure = error
            }
            sem.signal()
        }
        sem.wait()
        if let failure = failure { throw EngineError.unavailable("\(failure)") }
        return out
    }

    func stop() {}
}
#endif

// MARK: - Apple NaturalLanguage (extractive fallback, always available)

/// Apple NaturalLanguage extractive engine. Zero download, zero key, no LLM:
/// tokenizes the prompt's transcript portion into sentences and returns the most
/// salient ones as highlights. A robust fallback when no generative model is
/// available, so a macOS user ALWAYS gets an on-device summary with no key.
final class AppleNaturalLanguageEngine: SummaryEngine {
    func generate(_ prompt: String) throws -> String {
        // The prompt carries the transcript (the host splices it in). We summarize
        // the whole prompt text extractively — picking the longest, most
        // information-dense sentences as a lightweight highlight set.
        let text = prompt
        let tokenizer = NLTokenizer(unit: .sentence)
        tokenizer.string = text
        var sentences: [String] = []
        tokenizer.enumerateTokens(in: text.startIndex..<text.endIndex) { range, _ in
            let s = text[range].trimmingCharacters(in: .whitespacesAndNewlines)
            if s.count >= 24 { sentences.append(s) }
            return true
        }
        if sentences.isEmpty {
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        // Rank by length as a cheap salience proxy; keep first-appearance order for
        // the top-k so the highlights read in chronological order.
        let k = min(5, sentences.count)
        let topSet = Set(
            sentences.enumerated()
                .sorted { $0.element.count > $1.element.count }
                .prefix(k)
                .map { $0.offset }
        )
        let highlights = sentences.enumerated()
            .filter { topSet.contains($0.offset) }
            .map { "• " + $0.element }
        return highlights.joined(separator: "\n")
    }

    func stop() {}
}

// MARK: - Bundled MLX small model (generative) — -DMLX_SUMMARY

#if MLX_SUMMARY
import MLX
import MLXLLM

/// Bundled MLX instruct-model engine. Downloads the model on first use (the
/// first-run fetch seam) then runs fully offline on Apple Silicon. Gated behind
/// `-DMLX_SUMMARY`; throws `unavailable` when the runtime/model can't load so the
/// host falls back. The concrete model id arrives on `summaryStart.model`.
final class MlxSummaryEngine: SummaryEngine {
    private let container: ModelContainer

    init(modelId: String?) throws {
        let id = (modelId?.isEmpty == false) ? modelId! : "mlx-community/Qwen2.5-3B-Instruct-4bit"
        let sem = DispatchSemaphore(value: 0)
        var built: ModelContainer?
        var failure: Error?
        Task {
            do {
                // First-run fetch (cached afterwards) then load.
                built = try await LLMModelFactory.shared.loadContainer(
                    configuration: ModelConfiguration(id: id)
                )
            } catch {
                failure = error
            }
            sem.signal()
        }
        sem.wait()
        if let failure = failure { throw EngineError.unavailable("MLX load failed: \(failure)") }
        guard let container = built else { throw EngineError.unavailable("MLX returned nil container") }
        self.container = container
    }

    func generate(_ prompt: String) throws -> String {
        let sem = DispatchSemaphore(value: 0)
        var out = ""
        var failure: Error?
        Task {
            do {
                out = try await container.perform { context in
                    let input = try await context.processor.prepare(input: .init(prompt: prompt))
                    var text = ""
                    let stream = try MLXLMCommon.generate(
                        input: input, parameters: .init(), context: context
                    )
                    for await item in stream {
                        if case let .chunk(c) = item { text += c }
                    }
                    return text
                }
            } catch {
                failure = error
            }
            sem.signal()
        }
        sem.wait()
        if let failure = failure { throw EngineError.unavailable("MLX generate failed: \(failure)") }
        return out
    }

    func stop() {}
}
#endif

// MARK: - Summary capability probe + factory

/// Which native SUMMARY engines are available on THIS OS/arch. apple-nl is always
/// available (macOS 13+). apple-foundation only when compiled in AND the model is
/// available at runtime. mlx only when compiled in.
func probeSummaryEngines() -> [String] {
    var engines: [String] = []
    #if FOUNDATION_MODELS
    if case .available = SystemLanguageModel.default.availability {
        engines.append("apple-foundation")
    }
    #endif
    engines.append("apple-nl")
    #if MLX_SUMMARY
    engines.append("mlx")
    #endif
    return engines
}

/// Build the summary engine for a `summaryStart` request, or throw (host falls
/// back). For `apple-foundation` we degrade to `apple-nl` when the generative
/// model is unavailable, so a macOS user always gets an on-device summary.
func makeSummaryEngine(_ req: HostRequest) throws -> SummaryEngine {
    switch req.engine {
    case "apple-foundation":
        #if FOUNDATION_MODELS
        if let engine = try? AppleFoundationEngine() { return engine }
        #endif
        // Generative model unavailable -> extractive fallback (still on-device).
        return AppleNaturalLanguageEngine()
    case "apple-nl":
        return AppleNaturalLanguageEngine()
    case "mlx":
        #if MLX_SUMMARY
        return try MlxSummaryEngine(modelId: req.model)
        #else
        throw EngineError.unavailable("MLX summary not compiled in (build with -DMLX_SUMMARY)")
        #endif
    default:
        throw EngineError.unavailable("unknown summary engine \(req.engine ?? "nil")")
    }
}
