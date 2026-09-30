import { describe, expect, it } from "vitest";
import { FakeClock, SystemClock } from "./clock";

describe("clocks", () => {
  it("the system clock tells the real time", () => {
    const before = Date.now();
    const now = new SystemClock().now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("a fake clock stands still until it's set or moved", () => {
    const clock = new FakeClock();
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    clock.advance(90_000);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:01:30.000Z");
    clock.set(new Date("2026-06-01T12:00:00Z"));
    expect(clock.now().toISOString()).toBe("2026-06-01T12:00:00.000Z");
    expect(new FakeClock(new Date("2027-01-01T00:00:00Z")).now().getUTCFullYear()).toBe(2027);
  });

  it("can't be moved through a date it was given or handed out", () => {
    const start = new Date("2026-03-01T00:00:00Z");
    const clock = new FakeClock(start);
    start.setUTCFullYear(2030);
    clock.now().setUTCFullYear(2030);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});
