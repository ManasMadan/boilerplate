import { timeoutManager } from "@tanstack/react-query";

// Native modules that have no JavaScript fallback in tests.
jest.mock("expo-secure-store", () => ({
  getItem: jest.fn(),
  getItemAsync: jest.fn(async () => null),
  setItem: jest.fn(),
  setItemAsync: jest.fn(async () => undefined),
}));

// React Query keeps each unused query for five minutes (gcTime) on a timer. In a test
// process nothing needs them after the last test, so its timers don't keep Jest alive.
// (Jest runs on Node, whose timers can be unref'd; the app's types are React Native's.)
const unref = <T>(timer: T): T => {
  (timer as { unref?: () => void }).unref?.();
  return timer;
};
timeoutManager.setTimeoutProvider({
  setTimeout: (callback, delay) => unref(setTimeout(callback, delay)),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (callback, delay) => unref(setInterval(callback, delay)),
  clearInterval: (id) => clearInterval(id),
});
