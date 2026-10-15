/**
 * Service-account authentication for Google APIs using only WebCrypto and
 * fetch, so it runs inside Cloudflare Workers.
 */

export const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
];

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const JWT_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const TOKEN_LIFETIME_SECONDS = 3600;
/** Refresh this long before the cached token actually expires. */
const REFRESH_SKEW_MS = 60_000;

export interface ServiceAccountKey {
  type?: string;
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TokenProviderOptions {
  fetch?: FetchLike;
  scopes?: string[];
  now?: () => number;
}

/** Accepts the key file contents either as raw JSON or base64-encoded JSON. */
export function parseServiceAccount(raw: string): ServiceAccountKey {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Service account credentials are empty");
  }
  let text = trimmed;
  if (!trimmed.startsWith("{")) {
    try {
      text = new TextDecoder().decode(base64ToBytes(trimmed));
    } catch {
      throw new Error("Service account credentials are neither JSON nor valid base64");
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Service account credentials are not valid JSON (raw or base64-encoded)");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).client_email !== "string" ||
    typeof (parsed as Record<string, unknown>).private_key !== "string"
  ) {
    throw new Error("Service account JSON must include client_email and private_key");
  }
  return parsed as ServiceAccountKey;
}

export function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bytes = base64ToBytes(body);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Mints and caches OAuth2 access tokens for a service account by signing a
 * JWT assertion with the account's RSA private key.
 */
export class ServiceAccountTokenProvider {
  private cached?: { token: string; expiresAt: number };
  private inflight?: Promise<string>;
  private keyPromise?: Promise<CryptoKey>;

  constructor(
    private readonly key: ServiceAccountKey,
    private readonly options: TokenProviderOptions = {},
  ) {}

  get clientEmail(): string {
    return this.key.client_email;
  }

  async getAccessToken(): Promise<string> {
    const now = this.now();
    if (this.cached && this.cached.expiresAt - REFRESH_SKEW_MS > now) {
      return this.cached.token;
    }
    if (!this.inflight) {
      this.inflight = this.fetchToken().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  /** Build the signed JWT assertion sent to the token endpoint. */
  async createAssertion(): Promise<string> {
    const iat = Math.floor(this.now() / 1000);
    const header: Record<string, string> = { alg: "RS256", typ: "JWT" };
    if (this.key.private_key_id) header.kid = this.key.private_key_id;
    const claims = {
      iss: this.key.client_email,
      scope: (this.options.scopes ?? SCOPES).join(" "),
      aud: this.tokenUri,
      iat,
      exp: iat + TOKEN_LIFETIME_SECONDS,
    };
    const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      await this.importKey(),
      new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
  }

  private get tokenUri(): string {
    return this.key.token_uri || DEFAULT_TOKEN_URI;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private importKey(): Promise<CryptoKey> {
    if (!this.keyPromise) {
      this.keyPromise = crypto.subtle
        .importKey(
          "pkcs8",
          pemToDer(this.key.private_key),
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["sign"],
        )
        .catch((error: unknown) => {
          this.keyPromise = undefined;
          throw new Error(`Could not import service account private key: ${errorMessage(error)}`);
        });
    }
    return this.keyPromise;
  }

  private async fetchToken(): Promise<string> {
    const assertion = await this.createAssertion();
    const body = new URLSearchParams({ grant_type: JWT_GRANT, assertion });
    const fetchImpl = this.options.fetch ?? ((input, init) => fetch(input, init));
    const response = await fetchImpl(this.tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Google token request failed (${response.status}): ${text}`);
    }
    let payload: { access_token?: string; expires_in?: number };
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch {
      throw new Error("Google token response was not JSON");
    }
    if (!payload.access_token) {
      throw new Error("Google token response did not include an access_token");
    }
    const lifetimeMs = (payload.expires_in ?? TOKEN_LIFETIME_SECONDS) * 1000;
    this.cached = { token: payload.access_token, expiresAt: this.now() + lifetimeMs };
    return payload.access_token;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
