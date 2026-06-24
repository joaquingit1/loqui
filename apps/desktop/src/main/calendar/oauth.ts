/**
 * PRD-15 — loopback-redirect PKCE OAuth helper (main process).
 *
 * The ONE place that runs the interactive OAuth code grant for a calendar
 * provider. It is provider-agnostic: each provider supplies its endpoints +
 * client id + scope (see {@link OAuthClientConfig}); this module drives the
 * RFC 8252 "OAuth for native apps" loopback flow:
 *
 *   1. generate a PKCE code_verifier + S256 code_challenge + a CSRF `state`;
 *   2. bind a ONE-SHOT HTTP listener on 127.0.0.1 (an ephemeral port) — the
 *      loopback redirect target. We bind LOOPBACK ONLY (host "127.0.0.1"),
 *      never 0.0.0.0;
 *   3. open the provider consent page in the system browser via
 *      `shell.openExternal` (injectable);
 *   4. the provider redirects back to http://127.0.0.1:<port>/<path>?code=...
 *      &state=...; the listener captures it, validates `state`, replies with a
 *      tiny "you can close this tab" page, and closes;
 *   5. exchange the authorization code for tokens at the provider token
 *      endpoint (PKCE: send the verifier, NO client secret where avoidable),
 *      over an INJECTABLE fetch so tests mock it — NO real network in any test.
 *
 * SECURITY / HERMETICITY invariants:
 *   - the redirect listener binds 127.0.0.1 only (asserted by a unit test);
 *   - all token-endpoint HTTP is behind the injectable {@link OAuthHttp} — the
 *     only permitted real socket in a test is the loopback redirect listener;
 *   - the client SECRET is never hardcoded: providers that need one read it from
 *     an env var (documented per provider); PKCE means the public clients
 *     (Google/Microsoft "desktop"/"public" apps) ship NO secret.
 *   - tokens are returned to the caller (the service persists them via the
 *     safeStorage keystore) and are NEVER logged here.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import type { CalendarOAuthTokens } from "./types.js";

/** Loopback host for the redirect listener. NEVER 0.0.0.0 / a public host. */
export const LOOPBACK_HOST = "127.0.0.1";

/**
 * The slice of the network we depend on, injected so tests mock it. Mirrors the
 * Fetch API; production passes a thin wrapper over Node's global `fetch`.
 */
export interface OAuthHttp {
  (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body: string;
    },
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
}

/** Open a URL in the system browser. Injected (production: Electron `shell.openExternal`). */
export type OpenExternal = (url: string) => Promise<void>;

/** A provider's OAuth client configuration (endpoints + public client id + scope). */
export interface OAuthClientConfig {
  /** Authorization (consent) endpoint. */
  authorizeUrl: string;
  /** Token endpoint (code exchange + refresh). */
  tokenUrl: string;
  /** Public OAuth client id. NOT a secret. */
  clientId: string;
  /**
   * Client secret, if the provider mandates one even for a native app (e.g.
   * Zoom). NEVER hardcoded — providers read it from an env var. PKCE-only public
   * clients (Google/Microsoft desktop) leave this undefined.
   */
  clientSecret?: string;
  /** The narrowest read-only scope this provider offers (space-delimited). */
  scope: string;
  /** Path component of the loopback redirect URI (e.g. "/oauth/callback"). */
  redirectPath: string;
  /** Extra params appended to the authorize URL (e.g. Google's access_type=offline). */
  extraAuthParams?: Record<string, string>;
}

export interface RunPkceFlowDeps {
  config: OAuthClientConfig;
  http: OAuthHttp;
  openExternal: OpenExternal;
  /** Override for tests; production uses Math.random-free crypto. */
  now?: () => number;
}

/** The token-endpoint response we normalize from (snake_case per the OAuth spec). */
interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/** base64url with no padding (PKCE + state). */
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a PKCE code_verifier (43–128 chars) + its S256 challenge. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** A random opaque CSRF `state`. */
export function generateState(): string {
  return base64url(randomBytes(16));
}

/** Compute an access-token expiry ISO-8601 from `expires_in` seconds (null if absent). */
export function expiresAtFrom(expiresIn: number | undefined, nowMs: number): string | null {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) return null;
  // Subtract a small skew so we refresh slightly early.
  const skewMs = 30_000;
  return new Date(nowMs + expiresIn * 1000 - skewMs).toISOString();
}

/**
 * Bind a one-shot loopback redirect listener, returning the listening port +
 * the live {@link Server} + a promise that resolves with the captured query
 * params on the first matching request. LOOPBACK ONLY — binds 127.0.0.1.
 */
export function startRedirectListener(redirectPath: string): Promise<{
  server: Server;
  port: number;
  redirectUri: string;
  waitForCode: Promise<URLSearchParams>;
}> {
  return new Promise((resolve, reject) => {
    let settle: (params: URLSearchParams) => void = () => {};
    let fail: (err: Error) => void = () => {};
    const waitForCode = new Promise<URLSearchParams>((res, rej) => {
      settle = res;
      fail = rej;
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
      if (url.pathname !== redirectPath) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        "<!doctype html><meta charset=utf-8><title>Loqui</title><body style=\"font-family:system-ui;padding:2rem\"><h2>Connected to Loqui</h2><p>You can close this tab and return to the app.</p></body>",
      );
      settle(url.searchParams);
    });

    server.on("error", (err) => {
      fail(err);
      reject(err);
    });

    // Bind LOOPBACK ONLY (host 127.0.0.1), ephemeral port (0).
    server.listen(0, LOOPBACK_HOST, () => {
      const addr = server.address() as AddressInfo;
      const port = addr.port;
      const redirectUri = `http://${LOOPBACK_HOST}:${port}${redirectPath}`;
      resolve({ server, port, redirectUri, waitForCode });
    });
  });
}

/** Build the provider authorize URL with PKCE + state + the loopback redirect. */
export function buildAuthorizeUrl(
  config: OAuthClientConfig,
  redirectUri: string,
  challenge: string,
  state: string,
): string {
  const u = new URL(config.authorizeUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", config.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", config.scope);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  for (const [k, v] of Object.entries(config.extraAuthParams ?? {})) {
    u.searchParams.set(k, v);
  }
  return u.toString();
}

/**
 * Exchange an authorization code for tokens at the provider token endpoint
 * (PKCE: send the code_verifier; include the client secret only if configured).
 * Pure over the injected {@link OAuthHttp} — no real network. Throws on an OAuth
 * error or a non-OK status. Returns normalized {@link CalendarOAuthTokens}.
 */
export async function exchangeCode(args: {
  config: OAuthClientConfig;
  http: OAuthHttp;
  code: string;
  verifier: string;
  redirectUri: string;
  nowMs: number;
}): Promise<CalendarOAuthTokens> {
  const { config, http, code, verifier, redirectUri, nowMs } = args;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    code_verifier: verifier,
  });
  if (config.clientSecret) body.set("client_secret", config.clientSecret);

  const res = await http(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`OAuth token exchange failed (${res.status})`);
  }
  const json = (await res.json()) as RawTokenResponse;
  if (json.error || !json.access_token) {
    throw new Error(`OAuth token exchange error: ${json.error ?? "no access_token"}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: expiresAtFrom(json.expires_in, nowMs),
    scope: json.scope ?? config.scope,
  };
}

/**
 * Refresh an access token from a stored refresh token (PKCE clients omit the
 * secret unless the provider mandates one). Pure over the injected
 * {@link OAuthHttp}. Preserves the existing refresh token when the provider does
 * not rotate it. Throws on error / no new access token.
 */
export async function refreshTokens(args: {
  config: OAuthClientConfig;
  http: OAuthHttp;
  tokens: CalendarOAuthTokens;
  nowMs: number;
}): Promise<CalendarOAuthTokens> {
  const { config, http, tokens, nowMs } = args;
  if (!tokens.refreshToken) {
    throw new Error("cannot refresh: no refresh token stored for this account");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: config.clientId,
  });
  if (config.clientSecret) body.set("client_secret", config.clientSecret);

  const res = await http(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`OAuth token refresh failed (${res.status})`);
  }
  const json = (await res.json()) as RawTokenResponse;
  if (json.error || !json.access_token) {
    throw new Error(`OAuth token refresh error: ${json.error ?? "no access_token"}`);
  }
  return {
    accessToken: json.access_token,
    // Providers often omit a new refresh token on refresh — keep the old one.
    refreshToken: json.refresh_token ?? tokens.refreshToken,
    expiresAt: expiresAtFrom(json.expires_in, nowMs),
    scope: json.scope ?? tokens.scope ?? config.scope,
  };
}

/**
 * Run the full interactive loopback-PKCE flow end to end and return the issued
 * tokens. Opens the consent page, captures the redirect on the one-shot
 * 127.0.0.1 listener, validates `state`, exchanges the code. The listener is
 * always closed (success or failure). NO real network beyond the loopback
 * listener; the token exchange goes through the injected {@link OAuthHttp}.
 */
export async function runPkceFlow(deps: RunPkceFlowDeps): Promise<CalendarOAuthTokens> {
  const { config, http, openExternal } = deps;
  const now = deps.now ?? Date.now;
  const { verifier, challenge } = generatePkce();
  const state = generateState();

  const { server, redirectUri, waitForCode } = await startRedirectListener(config.redirectPath);
  try {
    const authorizeUrl = buildAuthorizeUrl(config, redirectUri, challenge, state);
    await openExternal(authorizeUrl);

    const params = await waitForCode;
    const returnedState = params.get("state");
    if (returnedState !== state) {
      throw new Error("OAuth state mismatch (possible CSRF); aborting connect");
    }
    const err = params.get("error");
    if (err) throw new Error(`OAuth consent failed: ${err}`);
    const code = params.get("code");
    if (!code) throw new Error("OAuth redirect carried no authorization code");

    return await exchangeCode({ config, http, code, verifier, redirectUri, nowMs: now() });
  } finally {
    server.close();
  }
}
