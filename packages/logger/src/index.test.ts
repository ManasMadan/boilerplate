import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { loggerOptions, scrub } from "./index";

describe("scrub", () => {
  it("censors sensitive keys at any depth and keeps everything else", () => {
    expect(
      scrub({
        job: { data: { data: { otp: "123456", purpose: "sign-in" } } },
        user: { Password: "x", name: "Ada" },
      }),
    ).toEqual({
      job: { data: { data: { otp: "[redacted]", purpose: "sign-in" } } },
      user: { Password: "[redacted]", name: "Ada" },
    });
  });
});

describe("logger", () => {
  it("never writes a nested secret to the output", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const log = pino(loggerOptions({ service: "test" }), sink);
    log.info(
      { job: { data: { data: { otp: "987654" } } }, req: { headers: { cookie: "session=abc" } } },
      "sent",
    );
    const line = lines.join("");
    expect(line).not.toContain("987654");
    expect(line).not.toContain("session=abc");
    expect(JSON.parse(line)).toMatchObject({ service: "test", level: "info", msg: "sent" });
  });
});
