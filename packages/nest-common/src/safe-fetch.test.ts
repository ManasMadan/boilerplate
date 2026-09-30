import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "./errors";
import { isPublicAddress, safeFetch } from "./safe-fetch";

describe("isPublicAddress", () => {
  it.each([
    ["8.8.8.8", true],
    ["2606:4700:4700::1111", true],
    ["127.0.0.1", false],
    ["10.1.2.3", false],
    ["172.16.0.1", false],
    ["192.168.1.1", false],
    ["169.254.169.254", false],
    ["100.64.0.1", false],
    ["0.0.0.0", false],
    ["::1", false],
    ["fd00::1", false],
    ["fe80::1", false],
    ["::ffff:127.0.0.1", false],
    ["::ffff:8.8.8.8", true],
    ["not-an-ip", false],
  ])("%s → %s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});

describe("safeFetch", () => {
  let server: Server;
  let base: string;
  let hitElsewhere = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/redirect-internal") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
      } else if (req.url === "/redirect-home") {
        res.writeHead(307, { location: "/elsewhere" }).end();
      } else if (req.url === "/elsewhere") {
        hitElsewhere++;
        res.end("followed");
      } else if (req.url === "/big") {
        res.end("x".repeat(2_000));
      } else {
        res.end("ok");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("refuses loopback and metadata destinations", async () => {
    await expect(safeFetch(`${base}/`, { allowHttp: true })).rejects.toBeInstanceOf(AppError);
    await expect(safeFetch("http://169.254.169.254/", { allowHttp: true })).rejects.toBeInstanceOf(
      AppError,
    );
    await expect(safeFetch("http://localhost:1/", { allowHttp: true })).rejects.toThrow();
  });

  it("requires https unless http is explicitly allowed", async () => {
    await expect(safeFetch("http://example.com/")).rejects.toMatchObject({
      code: "DESTINATION_NOT_ALLOWED",
    });
  });

  it("answers with the redirect itself when told not to follow it", async () => {
    const local = { allowHttp: true, allowedPrivateAddresses: ["127.0.0.1"] };
    const stopped = await safeFetch(`${base}/redirect-home`, {
      ...local,
      method: "POST",
      body: "signed",
      followRedirects: false,
    });
    expect(stopped.status).toBe(307);
    expect(hitElsewhere).toBe(0);
    expect((await safeFetch(`${base}/redirect-home`, local)).body).toBe("followed");
  });

  it("re-checks every redirect hop", async () => {
    // The first hop (the local test server) is explicitly allowed; the redirect target,
    // the cloud metadata address, is not.
    await expect(
      safeFetch(`${base}/redirect-internal`, {
        allowHttp: true,
        allowedPrivateAddresses: ["127.0.0.1"],
      }),
    ).rejects.toMatchObject({
      code: "DESTINATION_NOT_ALLOWED",
      params: { hostname: "169.254.169.254" },
    });
  });

  it("caps the response size", async () => {
    await expect(
      safeFetch(`${base}/big`, {
        allowHttp: true,
        allowedPrivateAddresses: ["127.0.0.1"],
        maxResponseBytes: 1_000,
      }),
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    await expect(
      safeFetch(`${base}/`, { allowHttp: true, allowedPrivateAddresses: ["127.0.0.1"] }),
    ).resolves.toMatchObject({
      status: 200,
      body: "ok",
    });
  });
});
