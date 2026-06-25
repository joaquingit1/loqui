import { describe, it, expect } from "vitest";
import {
  SUMMARY_PROVIDERS,
  ONDEVICE_SUMMARY_PROVIDERS,
  DEFAULT_SUMMARY_TEMPLATES,
  SUMMARY_TEMPLATE_PLACEHOLDER,
  summaryProviderSchema,
  summaryProviderInfoSchema,
  summaryProviderStatusSchema,
  summaryPromptTemplateSchema,
  summaryTemplateSettingsSchema,
  summaryProviderClass,
  isMacOnlySummaryProvider,
  summaryProviderNeedsKey,
  resolveSelectedTemplatePrompt,
  type SummaryTemplateSettings,
} from "./summaryprovider.js";
import { providerConfigSchema } from "./chat.js";
import { postProcessRequestSchema } from "./postprocess.js";

describe("PRD-10 summary provider contract", () => {
  it("round-trips every provider id", () => {
    for (const provider of SUMMARY_PROVIDERS) {
      const parsed = summaryProviderSchema.parse(provider);
      expect(parsed).toBe(provider);
      const reparsed = summaryProviderSchema.parse(
        JSON.parse(JSON.stringify(parsed)),
      );
      expect(reparsed).toBe(provider);
    }
  });

  it("classifies on-device vs cloud vs local-cli", () => {
    expect(summaryProviderClass("native")).toBe("on-device");
    expect(summaryProviderClass("mlx")).toBe("on-device");
    expect(summaryProviderClass("ollama")).toBe("on-device");
    expect(summaryProviderClass("anthropic")).toBe("cloud");
    expect(summaryProviderClass("agent-cli")).toBe("local-cli");
    expect(summaryProviderClass("fake")).toBe("test");
  });

  it("marks the native providers macOS-only + keyless", () => {
    for (const p of ONDEVICE_SUMMARY_PROVIDERS) {
      expect(summaryProviderNeedsKey(p)).toBe(false);
    }
    expect(isMacOnlySummaryProvider("native")).toBe(true);
    expect(isMacOnlySummaryProvider("mlx")).toBe(true);
    expect(isMacOnlySummaryProvider("ollama")).toBe(false);
    // Only anthropic needs a key (the cloud BYOK distinction).
    expect(summaryProviderNeedsKey("anthropic")).toBe(true);
    expect(summaryProviderNeedsKey("native")).toBe(false);
  });

  it("round-trips a provider-info probe row", () => {
    const info = summaryProviderInfoSchema.parse({
      provider: "native",
      label: "Apple on-device (no key)",
      providerClass: "on-device",
      macOnly: true,
      needsKey: false,
      availability: "unsupported-os",
      note: "macOS-only — using Ollama on this system",
    });
    const reparsed = summaryProviderInfoSchema.parse(
      JSON.parse(JSON.stringify(info)),
    );
    expect(reparsed).toEqual(info);
  });

  it("round-trips a resolved status (fallback)", () => {
    const status = summaryProviderStatusSchema.parse({
      requestedProvider: "native",
      activeProvider: "ollama",
      fellBack: true,
      reason: "native unavailable on win32 — using ollama",
    });
    expect(status.fellBack).toBe(true);
    expect(
      summaryProviderStatusSchema.parse(JSON.parse(JSON.stringify(status))),
    ).toEqual(status);
  });
});

describe("PRD-10 custom summary prompt templates", () => {
  it("ships the three default templates with the placeholder", () => {
    expect(DEFAULT_SUMMARY_TEMPLATES.map((t) => t.id)).toEqual([
      "tldr",
      "decisions",
      "action-items",
    ]);
    for (const t of DEFAULT_SUMMARY_TEMPLATES) {
      expect(t.builtin).toBe(true);
      expect(t.prompt).toContain(SUMMARY_TEMPLATE_PLACEHOLDER);
      summaryPromptTemplateSchema.parse(t); // validates the shape
    }
  });

  it("defaults the template settings to the built-ins + no selection", () => {
    const settings = summaryTemplateSettingsSchema.parse({});
    expect(settings.selectedId).toBeNull();
    expect(settings.templates.length).toBe(DEFAULT_SUMMARY_TEMPLATES.length);
    // No selection => no custom template (the default summary behavior).
    expect(resolveSelectedTemplatePrompt(settings)).toBe("");
  });

  it("resolves the selected template prompt", () => {
    const settings: SummaryTemplateSettings = summaryTemplateSettingsSchema.parse({
      selectedId: "decisions",
    });
    const prompt = resolveSelectedTemplatePrompt(settings);
    expect(prompt).toContain("key decisions");
    expect(prompt).toContain(SUMMARY_TEMPLATE_PLACEHOLDER);
  });

  it("supports a user-defined template + switching selection", () => {
    const custom = summaryPromptTemplateSchema.parse({
      id: "mine",
      name: "My prompt",
      prompt: "One-liner please.",
    });
    const settings = summaryTemplateSettingsSchema.parse({
      templates: [...DEFAULT_SUMMARY_TEMPLATES, custom],
      selectedId: "mine",
    });
    expect(custom.builtin).toBe(false);
    expect(resolveSelectedTemplatePrompt(settings)).toBe("One-liner please.");
    // Switching to a different (default) template uses the new one.
    expect(
      resolveSelectedTemplatePrompt({ ...settings, selectedId: "tldr" }),
    ).toContain("TL;DR");
  });

  it("unknown selectedId resolves to no template (safe fallback)", () => {
    const settings = summaryTemplateSettingsSchema.parse({ selectedId: "ghost" });
    expect(resolveSelectedTemplatePrompt(settings)).toBe("");
  });
});

describe("PRD-10 ProviderConfig additive fields (chat + postProcess)", () => {
  it("defaults nativeModel + summaryTemplate to empty (backward-compatible)", () => {
    const cfg = providerConfigSchema.parse({ provider: "native" });
    expect(cfg.nativeModel).toBe("");
    expect(cfg.summaryTemplate).toBe("");
  });

  it("carries nativeModel + summaryTemplate through providerConfig", () => {
    const cfg = providerConfigSchema.parse({
      provider: "mlx",
      nativeModel: "qwen2.5-3b",
      summaryTemplate: "TL;DR please {transcript}",
    });
    expect(cfg.nativeModel).toBe("qwen2.5-3b");
    expect(cfg.summaryTemplate).toContain("{transcript}");
    const reparsed = providerConfigSchema.parse(JSON.parse(JSON.stringify(cfg)));
    expect(reparsed).toEqual(cfg);
  });

  it("threads the template through the postProcess request", () => {
    const req = postProcessRequestSchema.parse({
      meetingId: "m1",
      providerConfig: {
        provider: "native",
        summaryTemplate: "Decisions only: {transcript}",
      },
    });
    expect(req.providerConfig.provider).toBe("native");
    expect(req.providerConfig.summaryTemplate).toBe("Decisions only: {transcript}");
    expect(req.providerConfig.nativeModel).toBe("");
  });

  it("an older postProcess payload (no new fields) still parses forward", () => {
    const req = postProcessRequestSchema.parse({
      meetingId: "m1",
      providerConfig: { provider: "anthropic", model: "claude-opus-4-8" },
    });
    expect(req.providerConfig.summaryTemplate).toBe("");
    expect(req.providerConfig.nativeModel).toBe("");
  });
});
