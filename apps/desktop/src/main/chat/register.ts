/**
 * Chat IPC + WS bridge registration (PRD-4).
 *
 * The single place main binds the `window.loqui.chat` surface (defined in
 * src/preload/index.ts) to the sidecar supervisor + the secure keystore.
 *
 * Flow:
 *   renderer `chat:send` {chatId, meetingId, messages, providerConfig}
 *     -> registerChatIpc: validate, read the BYOK key from the keystore
 *        (decrypted via safeStorage), and forward a `chatRequest` WS
 *        notification to the sidecar (providerConfig + transient apiKey)
 *     -> sidecar streams `chatToken`/`chatDone`/`chatError` notifications
 *     -> forwardChatStream: tag each as a ChatStreamEvent and push to the
 *        renderer on IPC.chatStream.
 *
 * INVARIANT (the AI never edits the transcript): this bridge has NO transcript
 * write path. It forwards a chat request and relays streamed text; the sidecar
 * reads the transcript READ-ONLY. The api key is read here and forwarded
 * transiently — it is never logged and never pushed to the renderer.
 *
 * Channel names come from src/shared/ipc.ts. Build units flesh out the renderer
 * panel; this is the additive main-process seam.
 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import {
  CHAT_DONE_EVENT,
  CHAT_ERROR_EVENT,
  CHAT_TOKEN_EVENT,
  CHAT_REQUEST_EVENT,
  chatDoneSchema,
  chatErrorSchema,
  chatProviderSchema,
  chatSendParamsSchema,
  chatTokenSchema,
  providerConfigSchema,
  setApiKeyParamsSchema,
  type ApiKeyStatus,
  type ChatProvider,
  type ChatStreamEvent,
  type ProviderConfig,
} from "@loqui/shared";
import { IPC } from "../../shared/ipc.js";
import type { SidecarSupervisor } from "../sidecar/supervisor.js";
import type { ChatKeystore } from "./keystore.js";

export interface ChatIpcDeps {
  /** Forwards the `chatRequest` notification to the sidecar over the live WS. */
  supervisor: Pick<SidecarSupervisor, "sendControlNotification">;
  /** Secure provider settings + BYOK key storage. */
  keystore: ChatKeystore;
}

/**
 * Register the chat IPC handlers (the `chat:send` send-channel + the
 * provider-settings / key invoke channels). Returns a disposer.
 *
 * `chat:send` is a fire-and-forget `ipcMain.on` (not `handle`) mirroring the
 * audio-frame hot path — the reply is the streamed {@link IPC.chatStream} push,
 * not a return value. main reads the BYOK key here (out of band) so the
 * persisted/forwarded provider config never carries a secret.
 */
export function registerChatIpc(deps: ChatIpcDeps): () => void {
  const { supervisor, keystore } = deps;

  const onSend = (_e: unknown, rawParams: unknown): void => {
    const parsed = chatSendParamsSchema.safeParse(rawParams);
    if (!parsed.success) return; // drop malformed sends, never forward.
    const { chatId, meetingId, messages, providerConfig } = parsed.data;

    // Inject the transient BYOK key from the OS keychain only for key-requiring
    // providers (today: anthropic). Local providers get null. The key is never
    // logged and never returned to the renderer.
    const apiKey =
      providerConfig.provider === "anthropic"
        ? keystore.getApiKey("anthropic")
        : null;

    supervisor.sendControlNotification(CHAT_REQUEST_EVENT, {
      chatId,
      meetingId,
      messages,
      providerConfig,
      apiKey,
    });
  };
  ipcMain.on(IPC.chatSend, onSend);

  ipcMain.handle(IPC.chatGetProviderSettings, (): ProviderConfig => {
    return keystore.getProviderSettings();
  });

  ipcMain.handle(
    IPC.chatSetProviderSettings,
    (_e: IpcMainInvokeEvent, config: ProviderConfig): ProviderConfig => {
      return keystore.setProviderSettings(providerConfigSchema.parse(config ?? {}));
    },
  );

  ipcMain.handle(
    IPC.chatSetApiKey,
    (_e: IpcMainInvokeEvent, params: unknown): ApiKeyStatus => {
      return keystore.setApiKey(setApiKeyParamsSchema.parse(params));
    },
  );

  ipcMain.handle(
    IPC.chatGetApiKeyStatus,
    (_e: IpcMainInvokeEvent, provider?: ChatProvider): ApiKeyStatus => {
      const p = chatProviderSchema.catch("anthropic").parse(provider ?? "anthropic");
      return keystore.getApiKeyStatus(p);
    },
  );

  return () => {
    ipcMain.removeListener(IPC.chatSend, onSend);
    ipcMain.removeHandler(IPC.chatGetProviderSettings);
    ipcMain.removeHandler(IPC.chatSetProviderSettings);
    ipcMain.removeHandler(IPC.chatSetApiKey);
    ipcMain.removeHandler(IPC.chatGetApiKeyStatus);
  };
}

/**
 * Forward the sidecar's chat WS notifications to the renderer on
 * {@link IPC.chatStream} (PRD-4). Subscribes to the supervisor's notification
 * fan-out, filters to the chat events, validates + normalizes each payload, tags
 * it as a {@link ChatStreamEvent}, and pushes it to the live window. Malformed
 * payloads are dropped, never forwarded. Returns an unsubscribe fn; `getWindow`
 * resolves the live window at emit time so the push survives window recreation.
 * Reuses the exact PRD-2 notification wire pattern — no new transport.
 */
export function forwardChatStream(
  supervisor: Pick<SidecarSupervisor, "onNotification">,
  getWindow: () => BrowserWindow | null,
): () => void {
  return supervisor.onNotification((event: string, data: unknown) => {
    let streamEvent: ChatStreamEvent | null = null;
    if (event === CHAT_TOKEN_EVENT) {
      const parsed = chatTokenSchema.safeParse(data);
      if (parsed.success) streamEvent = { kind: "token", ...parsed.data };
    } else if (event === CHAT_DONE_EVENT) {
      const parsed = chatDoneSchema.safeParse(data);
      if (parsed.success) streamEvent = { kind: "done", ...parsed.data };
    } else if (event === CHAT_ERROR_EVENT) {
      const parsed = chatErrorSchema.safeParse(data);
      if (parsed.success) streamEvent = { kind: "error", ...parsed.data };
    }
    if (streamEvent === null) return; // not a chat event, or malformed: ignore.
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.chatStream, streamEvent);
    }
  });
}
