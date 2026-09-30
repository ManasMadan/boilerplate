/**
 * Refuses endpoint URLs that could make our servers call internal systems (SSRF): the
 * host must resolve only to public addresses, and production requires https. This check
 * gives the admin an immediate answer; apps/webhooks checks again on every delivery,
 * since DNS can change after this.
 */
import { lookup } from "node:dns/promises";
import { AppError, isPublicAddress } from "@repo/nest-common";
import { env } from "../../env";

export async function assertDeliverableUrl(raw: string) {
  const url = new URL(raw);
  if (env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new AppError("WEBHOOK_URL_NOT_ALLOWED");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(host, { all: true, verbatim: true }).catch((error: unknown) => {
    // No such host is the admin's to fix; DNS failing is ours, and worth a retry.
    const code = (error as { code?: string })?.code;
    if (code === "ENOTFOUND" || code === "ENODATA") return [];
    throw new AppError("UPSTREAM_UNAVAILABLE", { params: { service: "dns" }, cause: error });
  });
  const allowed = (address: string) =>
    isPublicAddress(address) || env.WEBHOOK_ALLOWED_PRIVATE_ADDRESSES.includes(address);
  if (addresses.length === 0 || !addresses.every(({ address }) => allowed(address))) {
    throw new AppError("WEBHOOK_URL_NOT_ALLOWED");
  }
}
