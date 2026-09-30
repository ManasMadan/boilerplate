import { ORPCError } from "@orpc/client";
import { useQueryClient } from "@tanstack/react-query";
import { Component, type ReactNode } from "react";
import { create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { id, renderHook, standIn } from "../test/stand-in";
import { useMeQuery } from "./api/user/me";
import { useApi } from "./provider";

const me = {
  id: id(1),
  name: "Ada",
  email: "ada@example.com",
  image: null,
  locale: "en",
  timezone: "UTC",
  activeOrganizationId: id(2),
  phoneNumber: null,
};

/** An API whose `me` fails with `code` every time. */
const failing = (code: string) =>
  standIn((os) => ({
    user: {
      me: os.user.me.handler(() => {
        throw new ORPCError(code);
      }),
      removePhone: os.user.removePhone.handler(() => {
        throw new ORPCError(code);
      }),
    },
  }));

afterEach(() => {
  vi.useRealTimers();
});

describe("ApiProvider", () => {
  it("clears every cached query and signs out when the session is gone", async () => {
    let signedIn = true;
    const api = standIn((os) => ({
      user: {
        me: os.user.me.handler(() => {
          if (!signedIn) throw new ORPCError("UNAUTHENTICATED");
          return me;
        }),
      },
    }));
    const onUnauthenticated = vi.fn();
    const { result, unmount } = renderHook(
      () => ({ me: useMeQuery(), queryClient: useQueryClient() }),
      api,
      { onUnauthenticated },
    );
    await vi.waitFor(() => expect(result.current.me.data).toEqual(me));

    signedIn = false;
    void result.current.me.refetch();
    await vi.waitFor(() => expect(onUnauthenticated).toHaveBeenCalled());
    // Cleared, then refetched by the still-mounted query: the app navigates away here.
    unmount();
    const cached = result.current.queryClient.getQueriesData({ queryKey: [] });
    expect(cached.map(([, data]) => data)).not.toContainEqual(me);
  });

  it("asks for an update when the API no longer supports this version", async () => {
    const onOutdated = vi.fn();
    renderHook(() => useMeQuery(), failing("CLIENT_OUTDATED"), { onOutdated });
    await vi.waitFor(() => expect(onOutdated).toHaveBeenCalledOnce());
  });

  it("reports a lost workspace, from a mutation as well as a query", async () => {
    const onNoOrganization = vi.fn();
    const { result } = renderHook(
      () => ({ me: useMeQuery(), api: useApi() }),
      failing("NO_ACTIVE_ORGANIZATION"),
      { onNoOrganization },
    );
    await vi.waitFor(() => expect(onNoOrganization).toHaveBeenCalledOnce());
    const { client } = result.current.api;
    await expect(client.user.removePhone()).rejects.toThrow();
    // A call made outside react-query isn't the provider's to handle.
    expect(onNoOrganization).toHaveBeenCalledOnce();
  });

  it("handles these errors without callbacks, and ignores other errors", async () => {
    for (const code of ["CLIENT_OUTDATED", "NO_ACTIVE_ORGANIZATION", "FORBIDDEN"]) {
      const { result } = renderHook(() => useMeQuery(), failing(code));
      await vi.waitFor(() => expect(result.current.error).toBeInstanceOf(ORPCError));
    }
    const signedOut = failing("UNAUTHENTICATED");
    const { unmount } = renderHook(() => useMeQuery(), signedOut);
    await vi.waitFor(() => expect(signedOut.calls.length).toBeGreaterThan(1));
    unmount();
  });

  it("retries a failure that can pass on retry, twice, and never a refusal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const down = failing("SERVICE_UNAVAILABLE");
    const { result } = renderHook(() => useMeQuery(), down);
    await vi.waitFor(() => expect(down.calls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(result.current.isError).toBe(true));
    expect(down.calls).toHaveLength(3);

    const refused = failing("FORBIDDEN");
    const second = renderHook(() => useMeQuery(), refused);
    await vi.waitFor(() => expect(second.result.current.isError).toBe(true));
    expect(refused.calls).toHaveLength(1);
  });
});

describe("useApi", () => {
  it("fails loudly outside an ApiProvider", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let caught: unknown;
    class Catch extends Component<{ children: ReactNode }, { failed: boolean }> {
      override state = { failed: false };
      static getDerivedStateFromError(error: unknown) {
        caught = error;
        return { failed: true };
      }
      override render() {
        return this.state.failed ? null : this.props.children;
      }
    }
    function Probe() {
      useApi();
      return null;
    }
    create(
      <Catch>
        <Probe />
      </Catch>,
    );
    await vi.waitFor(() =>
      expect(caught).toEqual(new Error("useApi must be used inside <ApiProvider>")),
    );
  });
});
