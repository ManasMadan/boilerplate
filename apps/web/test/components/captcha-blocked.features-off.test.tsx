/** Turnstile's script can't load (an extension blocks it, or the network is down). */
import { expect, it } from "vitest";
import { commands } from "vitest/browser";
import { SignUpPage } from "@/modules/auth";
import { cleanup, renderPage } from "../render";

const FAILED = "The security check couldn't load.";

it("says so instead of leaving the form stuck, and tries again next time", async () => {
  await commands.turnstile("blocked");
  // Left before the script failed: nothing is shown for it.
  await renderPage(<SignUpPage />, { url: "/sign-up" });
  cleanup();
  const page = await renderPage(<SignUpPage />, { url: "/sign-up" });
  await expect.element(page.getByText(FAILED, { exact: false })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Create account" })).toBeDisabled();

  cleanup();
  await commands.turnstile("fake");
  const again = await renderPage(<SignUpPage />, { url: "/sign-up" });
  await expect.element(again.getByRole("button", { name: "Create account" })).toBeEnabled();
  expect(again.getByText(FAILED, { exact: false }).query()).toBeNull();
});
