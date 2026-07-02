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
    /// contains the read-only transcript (spliced in by the host). `instructions`
    /// is the SYSTEM prompt (the notetaker instructions), passed separately so a
    /// generative engine can use its system channel. Returns the result text; may
    /// throw `EngineError` (host maps it to an `error` reply).
    func generate(_ prompt: String, instructions: String?) throws -> String
    /// Streaming variant: invoke `onToken` with each incremental chunk as it is
    /// produced, and return the full text. The default implementation is
    /// non-streaming (it calls `generate` and emits the whole result as one
    /// chunk), so engines that can't stream still work; generative engines that
    /// can (Apple Foundation Models) override this to emit tokens live.
    func generateStream(
        _ prompt: String,
        instructions: String?,
        onToken: @escaping (String) -> Void
    ) throws -> String
    /// Warm up the engine so the FIRST generation's first token comes faster.
    /// Called by the host loop right after `summaryReady` (before any prompt is
    /// known), so it must be a no-op or a cheap resource load. The default does
    /// nothing (extractive/MLX engines have nothing to prewarm); the Apple
    /// Foundation Models engine overrides it to load the model into memory.
    func prewarm()
    func stop()
}

extension SummaryEngine {
    func generateStream(
        _ prompt: String,
        instructions: String?,
        onToken: @escaping (String) -> Void
    ) throws -> String {
        let text = try generate(prompt, instructions: instructions)
        if !text.isEmpty { onToken(text) }
        return text
    }

    func prewarm() {}
}

// MARK: - Apple Foundation Models (generative, on-device) — -DFOUNDATION_MODELS

#if FOUNDATION_MODELS
import FoundationModels

/// Apple Foundation Models engine — the on-device Apple-Intelligence LLM
/// (macOS 26+). The initializer throws `EngineError.unavailable` when the OS is
/// too old, Apple Intelligence is off, or the model isn't ready — the host then
/// surfaces a clear error (it does NOT silently fall back to extractive output,
/// which would echo the prompt instead of summarizing).
@available(macOS 26.0, *)
final class AppleFoundationEngine: SummaryEngine {
    private let model: SystemLanguageModel
    /// A persistent, prewarmed session kept alive for the life of the engine so the
    /// model's resources stay RESIDENT across turns (the host reuses this engine's
    /// helper process across chat turns now). We do NOT reuse it as the generation
    /// session because the host re-sends the FULL conversation history every turn —
    /// reusing a session would append that history on top of the session's own
    /// accumulated transcript and double the context. So each `respond`/`stream`
    /// uses a FRESH session built with this turn's instructions; the warm session
    /// exists purely to keep the model loaded (and it's prewarmed on `prewarm()`).
    private var warmSession: LanguageModelSession?

    init() throws {
        let model = SystemLanguageModel.default
        switch model.availability {
        case .available:
            self.model = model
        case let .unavailable(reason):
            throw EngineError.unavailable("Apple Foundation Models unavailable: \(reason)")
        }
    }

    /// Build a fresh generation session for this turn (with the notetaker
    /// `instructions` on the system channel), and `prewarm()` it so the first token
    /// comes faster. Instructions vary per request, so this is per-turn; the model
    /// weights themselves are already resident thanks to the warm session.
    private func makeSession(_ instructions: String?) -> LanguageModelSession {
        let session: LanguageModelSession
        if let instructions = instructions, !instructions.isEmpty {
            session = LanguageModelSession(model: self.model) { instructions }
        } else {
            session = LanguageModelSession(model: self.model)
        }
        // Warm this session's resources ahead of the respond/stream call.
        session.prewarm()
        return session
    }

    /// Load the model into memory ahead of the first prompt (called by the host
    /// right after `summaryReady`). Creates + prewarms a persistent session so the
    /// weights are resident when the first `summaryGenerate` arrives.
    func prewarm() {
        if warmSession == nil {
            warmSession = LanguageModelSession(model: self.model)
        }
        warmSession?.prewarm()
    }

    func generate(_ prompt: String, instructions: String?) throws -> String {
        let sem = DispatchSemaphore(value: 0)
        var out = ""
        var failure: Error?
        Task {
            do {
                // Put the notetaker prompt on the SYSTEM `instructions` channel —
                // the model follows it FAR more reliably than an inlined blob (which
                // it largely ignored, defaulting to a short English paragraph). The
                // transcript + ask ride as the user `prompt`. A generous token
                // budget gives room for a full multi-section document.
                let session = self.makeSession(instructions)
                let options = GenerationOptions(maximumResponseTokens: 4000)
                let response = try await session.respond(to: prompt, options: options)
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

    /// Streaming override: emit each incremental chunk via `onToken` as Apple
    /// Foundation Models produces it, so chat/summary tokens appear immediately
    /// instead of after the whole answer is ready. `streamResponse` yields
    /// CUMULATIVE snapshots; we diff against what we've emitted to send only the
    /// new suffix. The helper's main loop is blocked on the semaphore during
    /// generation, so calling `onToken` (a stdout write) from the Task is safe —
    /// no concurrent writer.
    func generateStream(
        _ prompt: String,
        instructions: String?,
        onToken: @escaping (String) -> Void
    ) throws -> String {
        let sem = DispatchSemaphore(value: 0)
        var out = ""
        var failure: Error?
        Task {
            do {
                let session = self.makeSession(instructions)
                let options = GenerationOptions(maximumResponseTokens: 4000)
                var emitted = ""
                let stream = session.streamResponse(to: prompt, options: options)
                for try await partial in stream {
                    let content = partial.content
                    if content.hasPrefix(emitted), content.count > emitted.count {
                        let delta = String(content.dropFirst(emitted.count))
                        onToken(delta)
                    } else if content != emitted {
                        // Non-monotonic snapshot (shouldn't happen): re-sync.
                        onToken(content)
                    }
                    emitted = content
                    out = content
                }
            } catch {
                failure = error
            }
            sem.signal()
        }
        sem.wait()
        if let failure = failure { throw EngineError.unavailable("\(failure)") }
        return out
    }

    func stop() { warmSession = nil }
}
#endif

// MARK: - Apple NaturalLanguage (extractive fallback, always available)

/// Apple NaturalLanguage extractive engine. Zero download, zero key, no LLM:
/// tokenizes the prompt's transcript portion into sentences and returns the most
/// salient ones as highlights. A robust fallback when no generative model is
/// available, so a macOS user ALWAYS gets an on-device summary with no key.
final class AppleNaturalLanguageEngine: SummaryEngine {
    func generate(_ prompt: String, instructions _: String?) throws -> String {
        // Extractive: instructions are irrelevant (this engine can't follow them).
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
            // Never echo the raw prompt back as a "summary" — return nothing so
            // the host treats it as no usable summary rather than rendering the
            // instruction text. (This engine is extractive and not used for the
            // structured summary; this guard is defense in depth.)
            return ""
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

    func generate(_ prompt: String, instructions: String?) throws -> String {
        // MLX has no separate system channel here — prepend the instructions.
        let fullPrompt = (instructions?.isEmpty == false) ? instructions! + "\n\n" + prompt : prompt
        let sem = DispatchSemaphore(value: 0)
        var out = ""
        var failure: Error?
        Task {
            do {
                out = try await container.perform { context in
                    let input = try await context.processor.prepare(input: .init(prompt: fullPrompt))
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
    if #available(macOS 26.0, *), case .available = SystemLanguageModel.default.availability {
        engines.append("apple-foundation")
    }
    #endif
    engines.append("apple-nl")
    #if MLX_SUMMARY
    engines.append("mlx")
    #endif
    return engines
}

/// Build the summary engine for a `summaryStart` request, or throw (the host
/// surfaces the error). `apple-foundation` requires a real GENERATIVE model — if
/// Foundation Models isn't compiled in, the OS is < macOS 26, or Apple
/// Intelligence is unavailable, we THROW `unavailable` rather than silently
/// degrading to the extractive `apple-nl` engine (which can't write a structured
/// summary and would echo the prompt). The host turns that into a clear error.
func makeSummaryEngine(_ req: HostRequest) throws -> SummaryEngine {
    switch req.engine {
    case "apple-foundation":
        #if FOUNDATION_MODELS
        if #available(macOS 26.0, *) {
            return try AppleFoundationEngine()
        }
        throw EngineError.unavailable("Apple Foundation Models requires macOS 26 or later.")
        #else
        throw EngineError.unavailable(
            "Apple Foundation Models not compiled in (rebuild the helper with -DFOUNDATION_MODELS)."
        )
        #endif
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
