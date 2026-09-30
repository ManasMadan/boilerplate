import { Prisma } from "@repo/db";
import { AppError } from "@repo/nest-common";
import { describe, expect, it, vi } from "vitest";
import { toContractError } from "./procedures";

describe("errors from procedures", () => {
  it("logs an AppError of 500 or more, with its cause: it's our fault", () => {
    const log = vi.fn();
    const cause = new TypeError("the AI service answered something else");
    const mapped = toContractError(new AppError("UPSTREAM_UNAVAILABLE", { cause }), log);
    expect(mapped.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ cause }), "error");
  });

  it("logs a client error only at debug, and only when it has a cause", () => {
    const log = vi.fn();
    toContractError(new AppError("TODO_NOT_FOUND"), log);
    expect(log).not.toHaveBeenCalled();
    toContractError(new AppError("TODO_NOT_FOUND", { cause: new Error("row gone") }), log);
    expect(log).toHaveBeenCalledWith(expect.any(AppError), "debug");
  });

  it("logs anything else as an error and hides it behind INTERNAL", () => {
    const log = vi.fn();
    const mapped = toContractError(new Error("boom"), log);
    expect(mapped.code).toBe("INTERNAL");
    expect(log).toHaveBeenCalledWith(expect.any(Error), "error");
  });

  it("turns a Prisma error a client can act on into its catalog code", () => {
    const log = vi.fn();
    const unique = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
    expect(toContractError(unique, log).code).toBe("CONFLICT");
    expect(log).not.toHaveBeenCalledWith(expect.anything(), "error");
  });
});
