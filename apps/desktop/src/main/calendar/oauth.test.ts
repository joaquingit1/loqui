/**
 * Hermetic tests for the loopback-redirect PKCE OAuth helper (PRD-15).
 *
 * The ONLY real socket permitted anywhere in the calendar test suite is the
 * one-shot 127.0.0.1 redirect listener exercised here — and we explicitly assert
 * it binds LOOPBACK ONLY (127.0.0.1, never 0.0.0.0). All token-endpoint HTTP is
 * driven through an INJECTED OAuthHttp; nothing reaches a real provider.
 */
import { describe, expect, it } from "vitest";
import { request } from "node:http";
import {
  buildAuthorizeUrl,
  exchangeCode,
  expiresAtFrom,
  generatePkce,
  refreshTokens,
  runPkceFlow,
  startRedirectListener,
  type OAuthClientConfig,
  type OAuthHttp,
} from "./oauth.js";

const CONFIG: OAuthClientConfig = {
  authorizeUrl: "https://provider.example/authorize",
  tokenUrl: "https://provider.example/token",
  clientId: "public-client-id",
  scope: "calendar.readonly",
  redirectPath: "/oauth/callback",
};

function tokenHttp(body: Record<string, unknown>, ok = true, status = 200): OAuthHttp {
  return () =>
    Promise.resolve({
      ok,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
}

describe("PKCE primitives", () => {
  it("generates a verifier + S256 challenge (url-safe, no padding)", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier).not.toBe(challenge);
  });

  it("expiresAtFrom subtracts a refresh skew", () => {
    const nowMs = Date.parse("2026-06-24T09:00:00.000Z");
    const iso = expiresAtFrom(3600, nowMs);
    expect(new Date(iso!).getTime()).toBe(nowMs + 3600_000 - 30_000);
    expect(expiresAtFrom(undefined, nowMs)).toBeNull();
  });

  it("buildAuthorizeUrl carries PKCE + state + redirect + extra params", () => {
    const url = new URL(
      buildAuthorizeUrl(
        { ...CONFIG, extraAuthParams: { access_type: "offline" } },
        "http://127.0.0.1:5123/oauth/callback",
        "CHAL",
        "STATE",
      ),
    );
    expect(url.searchParams.get("code_challenge")).toBe("CHAL");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("STATE");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5123/oauth/callback");
    expect(url.searchParams.get("access_type")).toBe("offline");
  });
});

describe("startRedirectListener", () => {
  it("binds LOOPBACK ONLY (127.0.0.1, not 0.0.0.0) and captures the redirect query", async () => {
    const { server, port, redirectUri, waitForCode } = await startRedirectListener("/oauth/callback");
    try {
      const addr = server.address();
      expect(typeof addr === "object" && addr?.address).toBe("127.0.0.1");
      expect(redirectUri).toBe(`http://127.0.0.1:${port}/oauth/callback`);

      // Drive the redirect on the loopback interface.
      await new Promise<void>((resolve, reject) => {
        const req = request(`${redirectUri}?code=THECODE&state=THESTATE`, (res) => {
          res.resume();
          res.on("end", () => resolve());
        });
        req.on("error", reject);
        req.end();
      });

      const params = await waitForCode;
      expect(params.get("code")).toBe("THECODE");
      expect(params.get("state")).toBe("THESTATE");
    } finally {
      server.close();
    }
  });
});

describe("exchangeCode / refreshTokens (injected http, no network)", () => {
  it("exchanges an authorization code for normalized tokens", async () => {
    const tokens = await exchangeCode({
      config: CONFIG,
      http: tokenHttp({ access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "s" }),
      code: "CODE",
      verifier: "VERIFIER",
      redirectUri: "http://127.0.0.1:1/oauth/callback",
      nowMs: 0,
    });
    expect(tokens.accessToken).toBe("AT");
    expect(tokens.refreshToken).toBe("RT");
    expect(tokens.expiresAt).toBe(new Date(3600_000 - 30_000).toISOString());
  });

  it("throws on an OAuth error body", async () => {
    await expect(
      exchangeCode({
        config: CONFIG,
        http: tokenHttp({ error: "invalid_grant" }),
        code: "CODE",
        verifier: "V",
        redirectUri: "http://127.0.0.1:1/cb",
        nowMs: 0,
      }),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("refresh preserves the old refresh token when the provider omits a new one", async () => {
    const next = await refreshTokens({
      config: CONFIG,
      http: tokenHttp({ access_token: "AT2", expires_in: 3600 }),
      tokens: { accessToken: "old", refreshToken: "KEEPME", expiresAt: null, scope: null },
      nowMs: 0,
    });
    expect(next.accessToken).toBe("AT2");
    expect(next.refreshToken).toBe("KEEPME");
  });

  it("refresh throws when there is no stored refresh token", async () => {
    await expect(
      refreshTokens({
        config: CONFIG,
        http: tokenHttp({ access_token: "x" }),
        tokens: { accessToken: "a", refreshToken: null, expiresAt: null, scope: null },
        nowMs: 0,
      }),
    ).rejects.toThrow(/no refresh token/);
  });
});

describe("runPkceFlow (end-to-end over the loopback listener)", () => {
  it("opens consent, captures the loopback redirect, validates state, exchanges the code", async () => {
    const http = tokenHttp({ access_token: "AT", refresh_token: "RT", expires_in: 3600 });
    const openExternal = (url: string): Promise<void> => {
      const u = new URL(url);
      const state = u.searchParams.get("state")!;
      const redirectUri = u.searchParams.get("redirect_uri")!;
      // The authorize redirect_uri MUST be loopback.
      expect(new URL(redirectUri).hostname).toBe("127.0.0.1");
      const req = request(`${redirectUri}?code=AUTHCODE&state=${state}`, (res) => res.resume());
      req.end();
      return Promise.resolve();
    };
    const tokens = await runPkceFlow({ config: CONFIG, http, openExternal });
    expect(tokens.accessToken).toBe("AT");
  });

  it("rejects a state mismatch (CSRF guard)", async () => {
    const http = tokenHttp({ access_token: "AT" });
    const openExternal = (url: string): Promise<void> => {
      const redirectUri = new URL(url).searchParams.get("redirect_uri")!;
      const req = request(`${redirectUri}?code=X&state=WRONG`, (res) => res.resume());
      req.end();
      return Promise.resolve();
    };
    await expect(runPkceFlow({ config: CONFIG, http, openExternal })).rejects.toThrow(/state mismatch/);
  });
});
