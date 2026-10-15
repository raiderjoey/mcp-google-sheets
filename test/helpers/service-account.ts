/** Generates a throwaway RSA key pair formatted like a Google service-account key file. */
import type { ServiceAccountKey } from "../../src/google/auth";

function toPem(der: ArrayBuffer, label: string): string {
  const bytes = new Uint8Array(der);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

export async function generateServiceAccount(): Promise<{ key: ServiceAccountKey; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  return {
    key: {
      type: "service_account",
      client_email: "robot@example-project.iam.gserviceaccount.com",
      private_key: toPem(pkcs8, "PRIVATE KEY"),
      private_key_id: "kid-123",
      token_uri: "https://oauth2.googleapis.com/token",
    },
    publicKey: pair.publicKey,
  };
}
