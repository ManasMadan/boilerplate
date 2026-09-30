import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as Notifications from "expo-notifications";
import { Suspense } from "react";
import Settings from "@/app/(app)/settings";
import { ApiProvider } from "@/lib/api";
import { I18nProvider } from "@/lib/i18n";
// Tests live outside src/app: every file there is a route.
import { aSession, fail, fakeApi, loadSession, openApp, server } from "../../test/app";

// Push is native: whether this is a real device, and what the user answers.
let mockIsDevice = true;
jest.mock("expo-device", () => ({
  get isDevice() {
    return mockIsDevice;
  },
}));
jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getDevicePushTokenAsync: jest.fn(async () => ({ type: "ios", data: "apns-1" })),
}));
const notifications = jest.mocked(Notifications);
const permission = (status: string) => ({ status }) as never;

const workspaces = [
  { id: "org-1", name: "Acme", slug: "acme" },
  { id: "org-2", name: "Globex", slug: "globex" },
];

function signedIn(handlers: Parameters<typeof fakeApi>[0] = {}) {
  const calls = fakeApi({ "/api/auth/organization/list": () => workspaces, ...handlers });
  server.session = aSession({ locale: "en" });
  return calls;
}
const callsTo = (calls: ReturnType<typeof fakeApi>, path: string) =>
  calls.filter((call) => call.path === path);

beforeEach(() => {
  mockIsDevice = true;
  notifications.getPermissionsAsync.mockResolvedValue(permission("undetermined"));
});

describe("settings", () => {
  it("shows who is signed in and signs them out", async () => {
    signedIn({
      "/api/auth/sign-out": () => {
        server.session = null;
        return { success: true };
      },
    });
    server.session = aSession({ email: "ada@example.com" });
    const app = await openApp("/settings");
    expect(await screen.findByText("Signed in as ada@example.com")).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("Sign out"));
    expect(await screen.findByText("Welcome back")).toBeOnTheScreen();
    expect(app.pathname()).toBe("/sign-in");
  });
});

describe("settings without a session", () => {
  // The app shows them only to signed-in users, but for a moment while a session ends
  // they can still be on screen.
  it("show no address", async () => {
    fakeApi({ "/api/auth/organization/list": () => [] });
    await loadSession();
    await render(
      <Suspense fallback={null}>
        <I18nProvider locale="en">
          <ApiProvider locale="en">
            <Settings />
          </ApiProvider>
        </I18nProvider>
      </Suspense>,
    );
    expect(await screen.findByText("Signed in as")).toBeOnTheScreen();
  });
});

describe("switching workspace", () => {
  it("marks the active one and switches to another", async () => {
    const calls = signedIn({
      "/api/auth/organization/set-active": (input) => {
        server.session = aSession({ locale: "en" }, String(input.organizationId));
        return workspaces[1];
      },
    });
    await openApp("/settings");
    expect(await screen.findByRole("radio", { name: "Acme" })).toBeChecked();
    // The active workspace stays as it is.
    await fireEvent.press(screen.getByRole("radio", { name: "Acme" }));
    expect(callsTo(calls, "/api/auth/organization/set-active")).toHaveLength(0);

    await fireEvent.press(screen.getByRole("radio", { name: "Globex" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Globex" })).toBeChecked());
    expect(callsTo(calls, "/api/auth/organization/set-active")[0]?.input).toEqual({
      organizationId: "org-2",
    });
  });

  it("says why it couldn't switch", async () => {
    signedIn({ "/api/auth/organization/set-active": () => fail(403, "FORBIDDEN") });
    await openApp("/settings");
    await fireEvent.press(await screen.findByRole("radio", { name: "Globex" }));
    expect(await screen.findByRole("alert")).toBeOnTheScreen();
    expect(screen.getByRole("radio", { name: "Acme" })).toBeChecked();
  });

  it("lists no workspaces when they can't be loaded", async () => {
    signedIn({ "/api/auth/organization/list": () => fail(500) });
    await openApp("/settings");
    expect(await screen.findByText("Workspace", { exact: true })).toBeOnTheScreen();
    await waitFor(() => expect(screen.queryByRole("radio", { name: "Acme" })).toBeNull());
  });
});

describe("the language", () => {
  it("is saved to the account and used straight away", async () => {
    const calls = signedIn({
      "/api/auth/update-user": (input) => {
        server.session = aSession({ locale: String(input.locale) });
        return { status: true };
      },
    });
    await openApp("/settings");
    expect(await screen.findByRole("radio", { name: "English" })).toBeChecked();
    await fireEvent.press(screen.getByRole("radio", { name: "Español" }));
    expect(await screen.findByText("Cerrar sesión")).toBeOnTheScreen();
    expect(callsTo(calls, "/api/auth/update-user")[0]?.input).toEqual({ locale: "es" });
  });

  it("stays when saving fails", async () => {
    signedIn({ "/api/auth/update-user": () => fail(500) });
    await openApp("/settings");
    await fireEvent.press(await screen.findByRole("radio", { name: "Español" }));
    expect(await screen.findByRole("alert")).toBeOnTheScreen();
    expect(screen.getByRole("radio", { name: "English" })).toBeChecked();
  });
});

describe("push notifications", () => {
  it("need a real device", async () => {
    mockIsDevice = false;
    signedIn();
    await openApp("/settings");
    expect(
      await screen.findByText("Notifications need a real device, not a simulator or the web."),
    ).toBeOnTheScreen();
  });

  it("say when the user has turned them off", async () => {
    notifications.getPermissionsAsync.mockResolvedValue(permission("denied"));
    signedIn();
    await openApp("/settings");
    expect(
      await screen.findByText(
        "Notifications are turned off for this app in your device's settings.",
      ),
    ).toBeOnTheScreen();
  });

  it("register this device once the user allows them", async () => {
    notifications.requestPermissionsAsync.mockImplementation(async () => {
      notifications.getPermissionsAsync.mockResolvedValue(permission("granted"));
      return permission("granted");
    });
    const calls = signedIn({ "/rpc/notifications/registerDevice": () => ({ id: "device-1" }) });
    await openApp("/settings");
    await fireEvent.press(await screen.findByText("Get notifications on this device"));
    expect(await screen.findByText("Notifications are on for this device.")).toBeOnTheScreen();
    expect(callsTo(calls, "/rpc/notifications/registerDevice")[0]?.input).toEqual({
      device: { platform: "ios", token: "apns-1" },
      appVersion: expect.any(String),
    });
  });

  it("stay off when the user declines", async () => {
    notifications.requestPermissionsAsync.mockImplementation(async () => {
      notifications.getPermissionsAsync.mockResolvedValue(permission("denied"));
      return permission("denied");
    });
    const calls = signedIn();
    await openApp("/settings");
    await fireEvent.press(await screen.findByText("Get notifications on this device"));
    expect(
      await screen.findByText(
        "Notifications are turned off for this app in your device's settings.",
      ),
    ).toBeOnTheScreen();
    expect(callsTo(calls, "/rpc/notifications/registerDevice")).toHaveLength(0);
  });

  it("say why the device couldn't be registered", async () => {
    notifications.requestPermissionsAsync.mockImplementation(async () => {
      notifications.getPermissionsAsync.mockResolvedValue(permission("granted"));
      return permission("granted");
    });
    signedIn({ "/rpc/notifications/registerDevice": () => fail(503, "SERVICE_UNAVAILABLE") });
    await openApp("/settings");
    await fireEvent.press(await screen.findByText("Get notifications on this device"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We can't reach the server. Check your connection and try again.",
    );
    expect(screen.getByText("Get notifications on this device")).toBeOnTheScreen();
  });
});
