import { describe, expect, it } from "vitest";
import { maxHeapBytes } from "./bootstrap";

describe("the heap a service sheds load at", () => {
  it("is 90% of the container's memory limit, or of 2 GB without one", () => {
    expect(maxHeapBytes(1000)).toBe(900);
    expect(maxHeapBytes(0)).toBe(0.9 * 2 * 1024 ** 3);
    expect(maxHeapBytes(undefined)).toBe(0.9 * 2 * 1024 ** 3);
    // Whatever this machine reports, a number the shedding can compare against.
    expect(maxHeapBytes()).toBeGreaterThan(0);
  });
});
