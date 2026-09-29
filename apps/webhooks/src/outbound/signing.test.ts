import { Webhook } from "standardwebhooks";
import { describe, expect, it } from "vitest";
import { generateSecret, signatureHeaders, verify } from "./signing";

describe("Standard Webhooks signing", () => {
  it("produces signatures the reference library accepts", () => {
    const secret = generateSecret();
    const body = JSON.stringify({ type: "todo.created.v1", data: { title: "Hi" } });
    const headers = signatureHeaders([secret], "01a0ea00-0000-7000-8000-000000000000", body);
    const payload = new Webhook(secret).verify(body, headers);
    expect(payload).toEqual(JSON.parse(body));
  });

  it("fails on a changed body, another secret or an old timestamp", () => {
    const secret = generateSecret();
    const body = '{"a":1}';
    const headers = signatureHeaders([secret], "msg", body);
    expect(() => new Webhook(secret).verify('{"a":2}', headers)).toThrow();
    expect(() => new Webhook(generateSecret()).verify(body, headers)).toThrow();
    const old = signatureHeaders([secret], "msg", body, Date.now() - 60 * 60 * 1000);
    expect(() => new Webhook(secret).verify(body, old)).toThrow();
  });

  it("signs with both secrets during a rotation, and receivers holding either accept it", () => {
    const [next, previous] = [generateSecret(), generateSecret()];
    const body = '{"a":1}';
    const headers = signatureHeaders([next, previous], "msg", body);
    expect(headers["webhook-signature"].split(" ")).toHaveLength(2);
    expect(new Webhook(next).verify(body, headers)).toEqual({ a: 1 });
    expect(new Webhook(previous).verify(body, headers)).toEqual({ a: 1 });
    expect(() => new Webhook(generateSecret()).verify(body, headers)).toThrow();
    const timestamp = Number(headers["webhook-timestamp"]);
    expect(verify(previous, "msg", timestamp, body, headers["webhook-signature"])).toBe(true);
  });

  it("verifies its own signatures in constant time", () => {
    const secret = generateSecret();
    const headers = signatureHeaders([secret], "msg", "{}", 1_700_000_000_000);
    expect(verify(secret, "msg", 1_700_000_000, "{}", headers["webhook-signature"])).toBe(true);
    expect(verify(secret, "msg", 1_700_000_001, "{}", headers["webhook-signature"])).toBe(false);
  });
});
