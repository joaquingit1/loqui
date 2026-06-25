/**
 * ProviderSettings — choose the AI provider/model/base-URL/CLI and store the
 * BYOK API key (PRD-4).
 *
 *   - Provider picker: Anthropic (BYOK) / Ollama (local) / Local agent CLI.
 *   - Per-provider tuning: Anthropic model, Ollama base URL + pulled model,
 *     which agent CLI (Claude Code / Codex).
 *   - Anthropic API key entry: typed into a password field, sent to MAIN for
 *     OS-keychain (Electron safeStorage) encryption via `chat.setApiKey`. The
 *     key is NEVER echoed back — after saving we only show "Key saved" (read
 *     from `chat.getApiKeyStatus`, which returns a boolean, never the key).
 *   - Settings persist via `chat.setProviderSettings` and take effect on the
 *     next send with no restart (AC #3).
 *
 * SECURITY: the plaintext key lives only in this component's transient input
 * state until Save; after Save it is cleared from the input and we never render
 * it again. The renderer has no other place to keep a key.
 *
 * Talks ONLY to the typed `window.loqui.chat` bridge (injectable for tests).
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import {
  DEFAULT_ANTHROPIC_CHAT_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_SUMMARY_TEMPLATES,
  providerConfigSchema,
  type AgentCli,
  type AnthropicChatModel,
  type ChatProvider,
  type ProviderConfig,
} from "@loqui/shared";
import type { LoquiChatApi } from "../../preload/index.js";
import {
  ANTHROPIC_MODELS,
  ANTHROPIC_MODEL_LABEL,
  AGENT_CLI_LABEL,
  PROVIDER_LABEL,
  SELECTABLE_AGENT_CLIS,
  SELECTABLE_PROVIDERS,
  providerNeedsApiKey,
} from "../chat/index.js";

export interface ProviderSettingsProps {
  /** Chat bridge. Injectable for tests; defaults to window.loqui.chat. */
  api?: Pick<
    LoquiChatApi,
    "getProviderSettings" | "setProviderSettings" | "setApiKey" | "getApiKeyStatus"
  >;
  /** Called with the persisted config after a successful Save. */
  onSaved?: (config: ProviderConfig) => void;
}

/** A defaulted config so the form always has a coherent starting point. */
function defaultConfig(): ProviderConfig {
  return providerConfigSchema.parse({ provider: "anthropic" });
}

export function ProviderSettings({ api, onSaved }: ProviderSettingsProps): JSX.Element {
  const chat = api ?? (typeof window !== "undefined" ? window.loqui?.chat : undefined);

  const [config, setConfig] = useState<ProviderConfig>(defaultConfig);
  const [hasKey, setHasKey] = useState(false);
  // Transient plaintext key; never persisted in component state past Save.
  const [keyInput, setKeyInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Load the persisted config + whether a key is stored for the active provider.
  useEffect(() => {
    if (!chat?.getProviderSettings) return;
    let cancelled = false;
    chat
      .getProviderSettings()
      .then((cfg) => {
        if (!cancelled) setConfig(cfg);
      })
      .catch(() => {
        /* keep the default config */
      });
    return () => {
      cancelled = true;
    };
  }, [chat]);

  const refreshKeyStatus = useCallback(
    (provider: ChatProvider) => {
      if (!chat?.getApiKeyStatus || !providerNeedsApiKey(provider)) {
        setHasKey(false);
        return;
      }
      chat
        .getApiKeyStatus(provider)
        .then((s) => setHasKey(Boolean(s?.hasKey)))
        .catch(() => setHasKey(false));
    },
    [chat],
  );

  useEffect(() => {
    refreshKeyStatus(config.provider);
  }, [config.provider, refreshKeyStatus]);

  const patch = useCallback((next: Partial<ProviderConfig>) => {
    setConfig((prev) => ({ ...prev, ...next }));
    setStatus(null);
  }, []);

  const onSave = useCallback(() => {
    if (!chat) return;
    setSaving(true);
    setStatus(null);

    const persistSettings = chat.setProviderSettings(config);

    // If the user typed a key for a key-using provider, store it via
    // safeStorage. The key string leaves the renderer only on this call.
    const needsKey = providerNeedsApiKey(config.provider);
    const trimmedKey = keyInput.trim();
    const persistKey =
      needsKey && trimmedKey.length > 0
        ? chat.setApiKey({ provider: config.provider, apiKey: keyInput })
        : Promise.resolve(null);

    Promise.all([persistSettings, persistKey])
      .then(([savedConfig, keyStatus]) => {
        const finalConfig = (savedConfig as ProviderConfig | undefined) ?? config;
        setConfig(finalConfig);
        // Clear the plaintext input the moment it has been handed to main.
        setKeyInput("");
        if (keyStatus && typeof (keyStatus as { hasKey?: boolean }).hasKey === "boolean") {
          setHasKey((keyStatus as { hasKey: boolean }).hasKey);
        } else {
          refreshKeyStatus(finalConfig.provider);
        }
        setStatus("Settings saved.");
        onSaved?.(finalConfig);
      })
      .catch((err: unknown) => {
        setStatus(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => setSaving(false));
  }, [chat, config, keyInput, onSaved, refreshKeyStatus]);

  const onClearKey = useCallback(() => {
    if (!chat?.setApiKey) return;
    chat
      .setApiKey({ provider: config.provider, apiKey: null })
      .then((s) => {
        setHasKey(Boolean(s?.hasKey));
        setKeyInput("");
        setStatus("Key cleared.");
      })
      .catch((err: unknown) => {
        setStatus(`Could not clear key: ${err instanceof Error ? err.message : String(err)}`);
      });
  }, [chat, config.provider]);

  const needsKey = providerNeedsApiKey(config.provider);

  // PRD-10 summary-template selection. The persisted knob is the template TEXT
  // (config.summaryTemplate); we resolve which named slot it matches (if any) so
  // the dropdown reflects it, and offer "Custom…" for free-form text.
  const matchingTemplate = DEFAULT_SUMMARY_TEMPLATES.find(
    (t) => t.prompt === config.summaryTemplate,
  );
  const isCustomTemplate =
    config.summaryTemplate.length > 0 && matchingTemplate === undefined;
  const selectedTemplateId = matchingTemplate
    ? matchingTemplate.id
    : isCustomTemplate
      ? "custom"
      : "";

  const onSelectTemplate = useCallback((id: string) => {
    if (id === "") {
      patch({ summaryTemplate: "" });
      return;
    }
    if (id === "custom") {
      // Keep any existing text; if empty, seed a starter so the textarea is usable.
      setConfig((prev) => ({
        ...prev,
        summaryTemplate: prev.summaryTemplate || "Summarize this meeting:\n\n{transcript}",
      }));
      setStatus(null);
      return;
    }
    const tmpl = DEFAULT_SUMMARY_TEMPLATES.find((t) => t.id === id);
    if (tmpl) patch({ summaryTemplate: tmpl.prompt });
  }, [patch]);

  return (
    <div className="chat__settings" data-testid="provider-settings">
      <label className="chat__field">
        <span className="chat__field-label">Provider</span>
        <select
          className="chat__select"
          data-testid="provider-select"
          value={config.provider}
          onChange={(e) => patch({ provider: e.target.value as ChatProvider })}
        >
          {SELECTABLE_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABEL[p]}
            </option>
          ))}
        </select>
      </label>

      {config.provider === "anthropic" && (
        <label className="chat__field">
          <span className="chat__field-label">Model</span>
          <select
            className="chat__select"
            data-testid="anthropic-model-select"
            value={config.model}
            onChange={(e) => patch({ model: e.target.value })}
          >
            {ANTHROPIC_MODELS.map((m) => (
              <option key={m} value={m}>
                {ANTHROPIC_MODEL_LABEL[m as AnthropicChatModel] ?? m}
              </option>
            ))}
          </select>
        </label>
      )}

      {config.provider === "ollama" && (
        <>
          <label className="chat__field">
            <span className="chat__field-label">Base URL</span>
            <input
              type="text"
              className="chat__text"
              data-testid="ollama-base-url"
              value={config.baseUrl}
              placeholder={DEFAULT_OLLAMA_BASE_URL}
              onChange={(e) => patch({ baseUrl: e.target.value })}
            />
          </label>
          <label className="chat__field">
            <span className="chat__field-label">Model</span>
            <input
              type="text"
              className="chat__text"
              data-testid="ollama-model"
              value={config.ollamaModel}
              placeholder="llama3.1"
              onChange={(e) => patch({ ollamaModel: e.target.value })}
            />
          </label>
        </>
      )}

      {config.provider === "agent-cli" && (
        <label className="chat__field">
          <span className="chat__field-label">CLI</span>
          <select
            className="chat__select"
            data-testid="agent-cli-select"
            value={config.cli}
            onChange={(e) => patch({ cli: e.target.value as AgentCli })}
          >
            {SELECTABLE_AGENT_CLIS.map((c) => (
              <option key={c} value={c}>
                {AGENT_CLI_LABEL[c as AgentCli] ?? c}
              </option>
            ))}
          </select>
        </label>
      )}

      {(config.provider === "native" || config.provider === "mlx") && (
        <p className="chat__hint" data-testid="ondevice-hint">
          Fully on-device — no API key, no cloud. Available on macOS; on other
          systems this falls back to Ollama or a cloud provider.
        </p>
      )}

      {config.provider === "mlx" && (
        <label className="chat__field">
          <span className="chat__field-label">On-device model</span>
          <input
            type="text"
            className="chat__text"
            data-testid="native-model"
            value={config.nativeModel}
            placeholder="bundled default"
            onChange={(e) => patch({ nativeModel: e.target.value })}
          />
        </label>
      )}

      {/* PRD-10 custom summary prompt template — applies to the SUMMARY job for
          every provider. "Default" => the built-in structured summary. */}
      <label className="chat__field" data-testid="summary-template-field">
        <span className="chat__field-label">Summary prompt</span>
        <select
          className="chat__select"
          data-testid="summary-template-select"
          value={selectedTemplateId}
          onChange={(e) => onSelectTemplate(e.target.value)}
        >
          <option value="">Default (structured summary)</option>
          {DEFAULT_SUMMARY_TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
        {(selectedTemplateId === "custom" || isCustomTemplate) && (
          <textarea
            className="chat__text"
            data-testid="summary-template-text"
            value={config.summaryTemplate}
            placeholder="Your prompt. Use {transcript} where the transcript should go."
            rows={3}
            onChange={(e) => patch({ summaryTemplate: e.target.value })}
          />
        )}
      </label>

      {needsKey && (
        <div className="chat__field" data-testid="api-key-field">
          <span className="chat__field-label">
            API key{" "}
            <span
              className={`chat__key-status chat__key-status--${hasKey ? "set" : "unset"}`}
              data-testid="api-key-status"
              data-has-key={hasKey ? "true" : "false"}
            >
              {hasKey ? "Key saved" : "No key stored"}
            </span>
          </span>
          <div className="chat__key-row">
            <input
              type="password"
              className="chat__text"
              data-testid="api-key-input"
              value={keyInput}
              placeholder={hasKey ? "Enter a new key to replace" : "sk-ant-…"}
              autoComplete="off"
              onChange={(e) => setKeyInput(e.target.value)}
              aria-label="API key"
            />
            {hasKey && (
              <button
                type="button"
                className="chat__clear-key"
                data-testid="api-key-clear"
                onClick={onClearKey}
              >
                Clear
              </button>
            )}
          </div>
          <p className="chat__hint">
            Stored encrypted in your OS keychain. Never shown again after saving.
          </p>
        </div>
      )}

      <div className="chat__settings-actions">
        <button
          type="button"
          className="btn"
          data-testid="provider-save"
          disabled={saving}
          onClick={onSave}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {status && (
          <span className="chat__settings-status" data-testid="provider-save-status" role="status">
            {status}
          </span>
        )}
      </div>
    </div>
  );
}

/** Re-export for callers that want the default-config builder in tests. */
export { DEFAULT_ANTHROPIC_CHAT_MODEL };
