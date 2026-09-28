/**
 * The browser/mobile side of better-auth (server: apps/api/src/auth/auth.ts). Client
 * plugins mirror the server's plugins so their methods exist and are typed:
 * `authClient.emailOtp.*`, `authClient.twoFactor.*`, `authClient.passkey.*`,
 * `authClient.organization.*`, `authClient.admin.*`, `authClient.apiKey.*`.
 *
 * Web uses `createAppAuthClient()`. Mobile builds its client from `authClientPlugins`
 * plus the Expo plugin (secure session storage), so both expose the same methods.
 */
import { apiKeyClient } from "@better-auth/api-key/client";
import { passkeyClient } from "@better-auth/passkey/client";
import {
  adminClient,
  emailOTPClient,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClientPlugins = (options: { onTwoFactorRequired?: () => void } = {}) => [
  emailOTPClient(),
  twoFactorClient({
    ...(options.onTwoFactorRequired && { onTwoFactorRedirect: options.onTwoFactorRequired }),
  }),
  passkeyClient(),
  organizationClient(),
  adminClient(),
  apiKeyClient(),
];

export interface AuthClientOptions {
  /** Origin serving /api/auth; omit for same origin (web). */
  baseUrl?: string;
  /** Called when a sign-in needs a second factor (TOTP or backup code). */
  onTwoFactorRequired?: () => void;
}

export function createAppAuthClient({ baseUrl, onTwoFactorRequired }: AuthClientOptions = {}) {
  return createAuthClient({
    ...(baseUrl !== undefined && { baseURL: baseUrl }),
    plugins: authClientPlugins({ ...(onTwoFactorRequired && { onTwoFactorRequired }) }),
  });
}

export type AuthClient = ReturnType<typeof createAppAuthClient>;
export type AuthSession = AuthClient["$Infer"]["Session"];
