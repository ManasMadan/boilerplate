/**
 * better-auth's session cookie names (the __Secure- variant is used over HTTPS). Only
 * their presence is checked here, to pick which page to render; the API decides whether
 * a session is actually valid.
 */
export const SESSION_COOKIES = ["better-auth.session_token", "__Secure-better-auth.session_token"];

export const hasSessionCookie = (cookies: { has(name: string): boolean }) =>
  SESSION_COOKIES.some((name) => cookies.has(name));
