/**
 * Fetch for URLs we don't control (customer webhook endpoints, links an AI tool follows).
 * A plain `fetch(url)` there is a server-side request forgery hole: a user registers
 * `http://169.254.169.254/...` or `http://postgres:5432` and makes our servers call
 * internal systems. This wrapper:
 *
 * - resolves the hostname itself and refuses anything that is not a public unicast
 *   address (loopback, private, link-local, cloud metadata, CGNAT, multicast; IPv4 and
 *   IPv6, including IPv4-mapped IPv6), then connects to exactly the address it checked,
 *   so a DNS answer cannot change between check and connect;
 * - follows redirects itself (at most 3), re-checking each hop, or not at all with
 *   `followRedirects: false` (webhook delivery: a redirect would carry the body and its
 *   signature somewhere else, and Standard Webhooks senders don't follow them);
 * - requires https unless `allowHttp` is set, and caps time and response size.
 *
 * The network layer adds a second wall: the services' egress NetworkPolicies allow DNS,
 * their own namespace, the mail and observability namespaces, and the internet outside
 * private ranges, so another namespace, a node and a metadata address stay unreachable
 * even if a check here were wrong.
 */
import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";
import { AppError } from "./errors";

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  allowHttp?: boolean;
  /** When false, a redirect is the answer (its status), not followed. Default true. */
  followRedirects?: boolean;
  /**
   * Exact private addresses to permit, for tests and local development only (e.g.
   * `["127.0.0.1"]` for a local receiver). Everything else private stays blocked.
   */
  allowedPrivateAddresses?: readonly string[];
}

export interface SafeFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** True only for addresses on the public internet. */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return parsed.range() === "unicast";
}

const permitted = (address: string, allowlist: readonly string[]) =>
  isPublicAddress(address) || allowlist.includes(address);

/** A DNS lookup that answers only with an address `permitted` allows (exported for tests). */
export function guardedLookup(allowlist: readonly string[]): LookupFunction {
  return (hostname, options, callback) => {
    lookup(hostname, { all: true })
      .then((addresses) => {
        const allowed = addresses.filter((entry) => permitted(entry.address, allowlist));
        const chosen = allowed[0];
        if (!chosen) {
          callback(new AppError("DESTINATION_NOT_ALLOWED", { params: { hostname } }), "", 4);
          return;
        }
        if (options.all) callback(null, [{ address: chosen.address, family: chosen.family }]);
        else callback(null, chosen.address, chosen.family);
      })
      .catch((error: unknown) => callback(error as NodeJS.ErrnoException, "", 4));
  };
}

export async function safeFetch(
  url: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResponse> {
  const {
    timeoutMs = 10_000,
    maxResponseBytes = 1_000_000,
    allowHttp = false,
    followRedirects = true,
    allowedPrivateAddresses = [],
  } = options;
  const dispatcher = new Agent({ connect: { lookup: guardedLookup(allowedPrivateAddresses) } });
  const deadline = AbortSignal.timeout(timeoutMs);

  try {
    let current = new URL(url);
    for (let hop = 0; hop <= 3; hop++) {
      if (current.protocol !== "https:" && !(allowHttp && current.protocol === "http:")) {
        throw new AppError("DESTINATION_NOT_ALLOWED", {
          params: { reason: "https-required" },
        });
      }
      // Literal IPs never go through DNS, so check them here.
      const host = current.hostname.replace(/^\[|\]$/g, "");
      if (ipaddr.isValid(host) && !permitted(host, allowedPrivateAddresses)) {
        throw new AppError("DESTINATION_NOT_ALLOWED", { params: { hostname: host } });
      }

      const response = await undiciFetch(current, {
        method: options.method ?? "GET",
        ...(options.headers && { headers: options.headers }),
        ...(options.body !== undefined && { body: options.body }),
        redirect: "manual",
        dispatcher,
        signal: deadline,
      }).catch((error: unknown) => {
        // A lookup refused above reaches here as undici's "fetch failed", with the
        // refusal as its cause: that's the answer, not a failure to connect.
        throw (error as Error).cause instanceof AppError ? (error as Error).cause : error;
      });

      const location = response.headers.get("location");
      if (followRedirects && response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        current = new URL(location, current);
        continue;
      }

      const reader: ReadableStreamDefaultReader<Uint8Array> | undefined =
        response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxResponseBytes) {
          await reader.cancel();
          throw new AppError("RESPONSE_TOO_LARGE", { params: { maxResponseBytes } });
        }
        chunks.push(value);
      }
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.concat(chunks).toString("utf8"),
      };
    }
    throw new AppError("TOO_MANY_REDIRECTS");
  } finally {
    await dispatcher.close();
  }
}
