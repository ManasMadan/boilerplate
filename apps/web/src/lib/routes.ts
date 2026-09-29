/**
 * Route groups the proxy and the client both need to agree on.
 * APP_PATHS need a session; GUEST_PATHS are pointless with one.
 */
export const APP_PATHS = [
  "/dashboard",
  "/settings",
  "/invitations",
  "/notifications",
  "/assistant",
];
export const GUEST_PATHS = [
  "/sign-in",
  "/sign-up",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
];

export const matchesPath = (pathname: string, prefixes: string[]) =>
  prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
