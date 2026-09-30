/** What the app does when any API call says the session, the app or the workspace is gone. */
import { describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import { AssistantPage } from "@/modules/assistant";
import { DashboardPage } from "@/modules/dashboard";
import { currentUrl, renderPage } from "../render";
import { auth, signOut, signUp } from "../users";

describe("the app's providers", () => {
  it("send a signed-out user to sign in, and back to this page afterwards", async () => {
    await signUp();
    await signOut();
    await renderPage(<DashboardPage />, { url: "/dashboard?tab=1" });
    await expect.poll(currentUrl).toBe("/sign-in?next=%2Fdashboard%3Ftab%3D1");
  });

  it("stay on an auth page when the session ends there", async () => {
    await signUp();
    await signOut();
    const page = await renderPage(<DashboardPage />, { url: "/sign-in" });
    await expect.element(page.getByText("Todos")).toBeVisible();
    // The failed call cleared the cache and signed out; nothing moved.
    await expect.poll(() => page.getByRole("heading", { name: /^Hi / }).query()).toBeNull();
    expect(currentUrl()).toBe("/sign-in");
  });

  it("reload the page when the API asks for a newer app", async () => {
    await signUp();
    await commands.requestHeaders({ "x-app-version": "0.0.1" });
    await renderPage(<DashboardPage />, { url: "/dashboard" });
    // Each call that was refused reloads; the first is what the user sees.
    await expect
      .poll(async () => new Set(await commands.hardNavigations()))
      .toEqual(new Set([`${window.location.origin}/dashboard`]));
  });

  it("move to another workspace when the active one is gone", async () => {
    await signUp();
    await auth("/organization/set-active", { organizationId: null });
    // Two calls fail together; the app switches once.
    await renderPage(
      <>
        <DashboardPage />
        <AssistantPage />
      </>,
      { url: "/settings" },
    );
    await expect.poll(commands.hardNavigations).toEqual([`${window.location.origin}/dashboard`]);
    const session = await fetch("/api/auth/get-session").then((r) => r.json());
    expect(session.session.activeOrganizationId).toEqual(expect.any(String));
  });
});
