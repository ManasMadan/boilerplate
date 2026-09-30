import { describe, expect, it, vi } from "vitest";
import { TransportsLifecycle } from "./push.module";
import type { PushTransport } from "./push-transport";

describe("push transports at shutdown", () => {
  it("closes every transport that holds something open, and skips those that don't", async () => {
    const send: PushTransport["send"] = async () => ({ ok: true });
    const ios = { send, close: vi.fn() };
    const web = { send, close: vi.fn(async () => undefined) };
    const lifecycle = new TransportsLifecycle({ ios, web, android: { send } });
    await lifecycle.onApplicationShutdown();
    expect(ios.close).toHaveBeenCalledOnce();
    expect(web.close).toHaveBeenCalledOnce();
  });
});
