import { useMeQuery } from "@repo/client/api/user/me";
import { render, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import { Text } from "react-native";
import { ApiProvider } from "./api";
import { authClient } from "./auth-client";

jest.mock("expo-router", () => ({ router: { replace: jest.fn(), push: jest.fn() } }));
jest.mock("./config", () => ({ apiUrl: "https://app.test", appVersion: "1.2.3" }));
jest.mock("./auth-client", () => ({
  authClient: {
    getCookie: jest.fn(async () => "boilerplate.session_token=abc"),
    signOut: jest.fn(async () => undefined),
    organization: { list: jest.fn(), setActive: jest.fn() },
  },
}));

/** Answers every API call with this error, as the API would. */
function apiFails(code: string, status: number) {
  const calls: Request[] = [];
  jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    calls.push(input as Request);
    return new Response(
      JSON.stringify({ json: { defined: true, code, status, message: "", data: {} } }),
      { status, headers: { "content-type": "application/json" } },
    );
  });
  return calls;
}

function Me() {
  const me = useMeQuery();
  return <Text>{me.status}</Text>;
}

afterEach(() => jest.restoreAllMocks());

describe("the app's API client", () => {
  it("sends the session cookie from secure storage and the app version", async () => {
    const calls = apiFails("CLIENT_OUTDATED", 426);
    await render(
      <ApiProvider locale="es">
        <Me />
      </ApiProvider>,
    );
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const headers = calls[0]?.headers ?? new Headers();
    expect(headers.get("cookie")).toBe("boilerplate.session_token=abc");
    expect(headers.get("x-app-version")).toBe("1.2.3");
    expect(headers.get("x-locale")).toBe("es");
  });

  it("shows the update screen when the API no longer supports this build", async () => {
    apiFails("CLIENT_OUTDATED", 426);
    await render(
      <ApiProvider locale="en">
        <Me />
      </ApiProvider>,
    );
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/update-required"));
  });

  it("signs out and goes to sign-in when the session is gone", async () => {
    apiFails("UNAUTHENTICATED", 401);
    await render(
      <ApiProvider locale="en">
        <Me />
      </ApiProvider>,
    );
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/sign-in"));
    expect(authClient.signOut).toHaveBeenCalled();
  });
});

describe("losing the active workspace", () => {
  it("switches to the user's next workspace", async () => {
    apiFails("NO_ACTIVE_ORGANIZATION", 403);
    jest.mocked(authClient.organization.list).mockResolvedValue({
      data: [{ id: "org-2" }],
      error: null,
    } as never);
    await render(
      <ApiProvider locale="en">
        <Me />
      </ApiProvider>,
    );
    await waitFor(() =>
      expect(authClient.organization.setActive).toHaveBeenCalledWith({ organizationId: "org-2" }),
    );
  });
});
