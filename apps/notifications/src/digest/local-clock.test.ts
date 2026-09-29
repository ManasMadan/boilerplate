import { describe, expect, it } from "vitest";
import { localClock } from "./local-clock";

describe("localClock", () => {
  const at = new Date("2026-03-01T23:30:00Z");

  it("gives the hour and date in the zone, across the date line", () => {
    expect(localClock("UTC", at)).toEqual({ hour: 23, date: "2026-03-01" });
    expect(localClock("Asia/Tokyo", at)).toEqual({ hour: 8, date: "2026-03-02" });
    expect(localClock("America/Los_Angeles", at)).toEqual({ hour: 15, date: "2026-03-01" });
    expect(localClock("Asia/Kolkata", at)).toEqual({ hour: 5, date: "2026-03-02" });
  });

  it("falls back to UTC for a zone it doesn't know", () => {
    expect(localClock("Mars/Olympus", at)).toEqual({ hour: 23, date: "2026-03-01" });
  });
});
