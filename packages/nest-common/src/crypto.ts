/**
 * Encryption for secrets stored in our database (webhook signing secrets, third-party
 * tokens). AES-256-GCM with a key id on every ciphertext, so keys rotate without a
 * big-bang re-encryption:
 *
 *   ENCRYPTION_KEYS="2026-09:base64key,2026-01:base64oldkey"   (first = active)
 *   const box = new SecretBox(keysFromEnv(env.ENCRYPTION_KEYS));
 *   const stored = box.encrypt("whsec_...");    // "v1.2026-09.<iv>.<ciphertext>"
 *   box.decrypt(stored);                        // any listed key id still decrypts
 *
 * Rotation: prepend a new key, deploy, re-encrypt in the background (decrypt + encrypt
 * with the active key), then drop the old key.
 *
 * Seam: keys come from a `KeyProvider`. Today it reads them from the environment (in a
 * cluster, the service's Secret, decrypted from SOPS by Argo CD). To use a KMS, implement
 * `KeyProvider` to unwrap data keys with the KMS; ciphertext format and callers stay the same.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface KeyProvider {
  /** The key new ciphertexts are written with. */
  active(): { id: string; key: Buffer };
  /** Any key that may still appear in stored ciphertexts. */
  get(id: string): Buffer | undefined;
}

/** Parses `id:base64key,id:base64key` (first is active). Keys must be 32 bytes. */
export function keysFromEnv(value: string): KeyProvider {
  const keys = value.split(",").map((entry) => {
    const [id, encoded] = entry.trim().split(":");
    if (!id || !encoded || !/^[\w-]+$/.test(id))
      throw new Error("ENCRYPTION_KEYS entries must look like `id:base64key`");
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32)
      throw new Error(`Encryption key "${id}" must be 32 bytes (openssl rand -base64 32)`);
    return { id, key };
  });
  // split() always yields an entry, and each one was checked above.
  const first = keys[0] as { id: string; key: Buffer };
  const byId = new Map(keys.map(({ id, key }) => [id, key]));
  return { active: () => first, get: (id) => byId.get(id) };
}

const VERSION = "v1";

export class SecretBox {
  constructor(private readonly keys: KeyProvider) {}

  encrypt(plaintext: string): string {
    const { id, key } = this.keys.active();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return [VERSION, id, iv.toString("base64url"), body.toString("base64url")].join(".");
  }

  decrypt(stored: string): string {
    const [version, id, iv, body] = stored.split(".");
    if (version !== VERSION || !id || !iv || !body)
      throw new Error("Unrecognised ciphertext format");
    const key = this.keys.get(id);
    if (!key)
      throw new Error(
        `Unknown encryption key "${id}"; it may have been removed before re-encryption finished`,
      );
    const data = Buffer.from(body, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([
      decipher.update(data.subarray(0, data.length - 16)),
      decipher.final(),
    ]).toString("utf8");
  }

  /** Whether a stored value was written with an older key and should be re-encrypted. */
  needsRotation(stored: string): boolean {
    return stored.split(".")[1] !== this.keys.active().id;
  }
}

/**
 * A new webhook signing secret in the Standard Webhooks format (standardwebhooks.com):
 * `whsec_` and the base64 of 24 random bytes, which its libraries read as the key.
 */
export const newWebhookSecret = () => `whsec_${randomBytes(24).toString("base64")}`;
