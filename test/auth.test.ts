import { describe, expect, it } from "vitest";
import { base64ToBytes, parseServiceAccount, SCOPES, ServiceAccountTokenProvider } from "../src/google/auth";
import { generateServiceAccount } from "./helpers/service-account";

describe("parseServiceAccount", () => {
  const key = { client_email: "a@b.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n" };

  it("accepts raw JSON", () => {
    expect(parseServiceAccount(JSON.stringify(key))).toEqual(key);
  });

  it("accepts base64-encoded JSON, including wrapped lines", () => {
    const encoded = btoa(JSON.stringify(key)).replace(/(.{20})/g, "$1\n");
    expect(parseServiceAccount(encoded)).toEqual(key);
  });

  it("rejects empty, malformed, and incomplete input", () => {
    expect(() => parseServiceAccount("")).toThrow(/empty/);
    expect(() => parseServiceAccount("{not json")).toThrow(/not valid JSON/);
    expect(() => parseServiceAccount(JSON.stringify({ client_email: "x" }))).toThrow(/client_email and private_key/);
  });
});

describe("ServiceAccountTokenProvider", () => {
  it("signs a valid RS256 assertion and caches the resulting token", async () => {
    const { key, publicKey } = await generateServiceAccount();
    const tokenRequests: URLSearchParams[] = [];
    let now = 1_800_000_000_000;

    const fetchImpl = async (input: string, init?: RequestInit) => {
      expect(input).toBe(key.token_uri);
      expect(init?.method).toBe("POST");
      tokenRequests.push(new URLSearchParams(String(init?.body)));
      return Response.json({ access_token: `token-${tokenRequests.length}`, expires_in: 3600, token_type: "Bearer" });
    };

    const provider = new ServiceAccountTokenProvider(key, { fetch: fetchImpl, now: () => now });

    expect(await provider.getAccessToken()).toBe("token-1");
    expect(await provider.getAccessToken()).toBe("token-1");
    expect(tokenRequests).toHaveLength(1);

    const params = tokenRequests[0];
    expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, claims, signature] = params.get("assertion")!.split(".");
    expect(JSON.parse(new TextDecoder().decode(base64ToBytes(header)))).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-123" });
    const payload = JSON.parse(new TextDecoder().decode(base64ToBytes(claims)));
    expect(payload).toEqual({
      iss: key.client_email,
      scope: SCOPES.join(" "),
      aud: key.token_uri,
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      base64ToBytes(signature),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(verified).toBe(true);

    // Advance past the refresh window and expect a new token.
    now += 3600 * 1000;
    expect(await provider.getAccessToken()).toBe("token-2");
    expect(tokenRequests).toHaveLength(2);
  });

  it("coalesces concurrent token requests", async () => {
    const { key } = await generateServiceAccount();
    let requests = 0;
    const provider = new ServiceAccountTokenProvider(key, {
      fetch: async () => {
        requests += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return Response.json({ access_token: "tok", expires_in: 3600 });
      },
    });
    const tokens = await Promise.all([provider.getAccessToken(), provider.getAccessToken(), provider.getAccessToken()]);
    expect(tokens).toEqual(["tok", "tok", "tok"]);
    expect(requests).toBe(1);
  });

  it("reports token endpoint failures", async () => {
    const { key } = await generateServiceAccount();
    const provider = new ServiceAccountTokenProvider(key, {
      fetch: async () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    });
    await expect(provider.getAccessToken()).rejects.toThrow(/Google token request failed \(400\)/);
  });

  it("wraps a private key that is not even valid PEM or base64", async () => {
    const provider = new ServiceAccountTokenProvider(
      { client_email: "x@y", private_key: "not-a-key!" },
      { fetch: async () => Response.json({ access_token: "tok" }) },
    );
    await expect(provider.getAccessToken()).rejects.toThrow(/Could not import service account private key/);
    // and it keeps failing the same way, rather than caching a broken promise
    await expect(provider.getAccessToken()).rejects.toThrow(/Could not import service account private key/);
  });

  it("reports an unusable private key", async () => {
    const provider = new ServiceAccountTokenProvider(
      { client_email: "x@y", private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" },
      { fetch: async () => Response.json({ access_token: "tok" }) },
    );
    await expect(provider.getAccessToken()).rejects.toThrow(/Could not import service account private key/);
  });
});
