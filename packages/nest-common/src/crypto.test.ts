import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { keysFromEnv, SecretBox } from "./crypto";

const key = () => randomBytes(32).toString("base64");

describe("SecretBox", () => {
  it("round-trips and tags ciphertexts with the active key id", () => {
    const box = new SecretBox(keysFromEnv(`k2:${key()}`));
    const stored = box.encrypt("whsec_123");
    expect(stored.startsWith("v1.k2.")).toBe(true);
    expect(box.decrypt(stored)).toBe("whsec_123");
  });

  it("decrypts values written with a previous key after rotation", () => {
    const oldKey = key();
    const before = new SecretBox(keysFromEnv(`k1:${oldKey}`)).encrypt("secret");
    const after = new SecretBox(keysFromEnv(`k2:${key()},k1:${oldKey}`));
    expect(after.decrypt(before)).toBe("secret");
    expect(after.needsRotation(before)).toBe(true);
    expect(after.needsRotation(after.encrypt("secret"))).toBe(false);
  });

  it("rejects tampered ciphertexts and unknown keys", () => {
    const box = new SecretBox(keysFromEnv(`k1:${key()}`));
    const stored = box.encrypt("secret");
    // Flip one bit of the encrypted body (editing base64 text can land on padding bits
    // that decode to the same bytes, which would make this test pass by luck).
    const [version, id, iv, body] = stored.split(".");
    const bytes = Buffer.from(body ?? "", "base64url");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    const tampered = [version, id, iv, bytes.toString("base64url")].join(".");
    expect(() => box.decrypt(tampered)).toThrow();
    expect(() => new SecretBox(keysFromEnv(`k9:${key()}`)).decrypt(stored)).toThrow(
      /Unknown encryption key/,
    );
  });

  it("refuses keys of the wrong length", () => {
    expect(() => keysFromEnv(`k1:${randomBytes(16).toString("base64")}`)).toThrow(/32 bytes/);
  });
});
