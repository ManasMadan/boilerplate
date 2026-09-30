/**
 * The whole app in a test: its real routes, opened at a URL, talking to the fake API
 * (fake-api.ts).
 *
 *   const calls = fakeApi();
 *   const app = await openApp("/");
 *   expect(app.pathname()).toBe("/sign-in");
 */
import { act } from "@testing-library/react-native";
import { renderRouter } from "expo-router/testing-library";
import { authClient } from "../src/lib/auth-client";

export * from "./fake-api";

/**
 * The auth client keeps the session between renders, as it does in the app: this starts a
 * test from what the fake server says, not what the previous test left. (Through `value`:
 * `get()` on a store nothing listens to leaves a timer running.)
 */
export const loadSession = () => act(() => authClient.$store.atoms.session?.value?.refetch());

// The first render of a file loads the whole app, which takes a few seconds on a busy machine.
jest.setTimeout(30_000);

/** Opens the app at `url`, as a link or a cold start would. */
export async function openApp(url = "/") {
  await loadSession();
  // Relative to the working directory: Jest runs in apps/mobile.
  const app = renderRouter("src/app", { initialUrl: url });
  // renderRouter loads the routes under fake timers; the clients need real ones.
  jest.useRealTimers();
  await app;
  // Not the render result itself, which is a promise (awaiting it would drop these).
  return {
    pathname: () => app.getPathname(),
    pathnameWithParams: () => app.getPathnameWithParams(),
  };
}
