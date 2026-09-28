/**
 * Runs before every page render (Next.js "proxy", formerly middleware). It only shapes
 * the response; it never touches data:
 *
 * 1. A per-request nonce for the Content-Security-Policy, so the policy can forbid
 *    inline scripts except Next's own (which receive the nonce).
 * 2. Early redirects based on whether a session cookie is present: signed-out visitors
 *    to app pages go to sign-in, signed-in visitors to auth pages go to the dashboard.
 *    A present cookie can still be expired or revoked; the API rejects it and the client
 *    then signs out (packages/client). This check is only about not flashing the wrong page.
 */
import { type NextRequest, NextResponse } from "next/server";
import { hasSessionCookie } from "@/lib/session-cookie";

const APP_PATHS = ["/dashboard", "/settings", "/invitations"];
const GUEST_PATHS = [
  "/sign-in",
  "/sign-up",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
];

const matches = (pathname: string, prefixes: string[]) =>
  prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const signedIn = hasSessionCookie(request.cookies);

  if (!signedIn && matches(pathname, APP_PATHS)) {
    const url = new URL("/sign-in", request.url);
    url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }
  if (signedIn && matches(pathname, GUEST_PATHS)) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const development = process.env.NODE_ENV === "development";
  const csp = [
    "default-src 'self'",
    // 'strict-dynamic' lets Next's nonce'd bootstrap load its chunks; dev needs eval for HMR.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    // The API is on this origin; Turnstile (captcha) needs its origin when enabled.
    "connect-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  // Everything except static assets and the API paths the gateway (or dev rewrites) forwards.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|rpc|api|docs|healthz|.*\\.(?:png|svg|jpg|ico|webmanifest|txt)$).*)",
  ],
};
