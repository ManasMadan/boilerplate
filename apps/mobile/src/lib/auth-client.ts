/**
 * The app's better-auth client: the same plugins as the web app (packages/client), plus
 * Expo's, which keeps the session cookie in the device's secure storage (Keychain,
 * Keystore) and sends it with every auth request. The oRPC client reads it from here too
 * (lib/api.ts). On the web the browser keeps the cookie, as for apps/web.
 */
import { expoClient } from "@better-auth/expo/client";
import { authClientPlugins } from "@repo/client/auth";
import { createAuthClient } from "better-auth/react";
import { router } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { apiUrl } from "./config";

export const authClient = createAuthClient({
  baseURL: apiUrl,
  plugins: [
    expoClient({ scheme: "boilerplate", storagePrefix: "boilerplate", storage: SecureStore }),
    // A sign-in that needs a second factor continues on the two-step screen.
    ...authClientPlugins({ onTwoFactorRequired: () => router.push("/two-factor") }),
  ],
});

export type Session = typeof authClient.$Infer.Session;
