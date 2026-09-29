/**
 * Live updates: one realtime stream per signed-in tab, reconnecting on its own.
 *
 *   useLiveUpdates(activeOrganizationId);   // once, near the app root (web and mobile)
 *
 * Messages only say what changed, so each maps to a refetch of the affected queries.
 * After any reconnect everything live is refetched too, since messages may have been
 * missed while disconnected.
 */
import type { RealtimeMessage } from "@repo/contracts/realtime";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { errorCode } from "./errors";
import { useApi } from "./provider";

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** Calls `onMessage` for every realtime message while mounted; `key` changes reopen the stream. */
export function useRealtime(
  onMessage: (message: RealtimeMessage) => void,
  onReconnect: () => void,
  key: unknown,
) {
  const { client } = useApi();
  // The latest handlers, without reopening the stream when they change.
  const handlers = useRef({ onMessage, onReconnect });
  useEffect(() => {
    handlers.current = { onMessage, onReconnect };
  });

  useEffect(() => {
    if (key === null || key === undefined) return;
    const controller = new AbortController();
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      });

    void (async () => {
      let delay = RETRY_MIN_MS;
      let first = true;
      while (!controller.signal.aborted) {
        try {
          const stream = await client.realtime.subscribe(undefined, { signal: controller.signal });
          if (!first) handlers.current.onReconnect();
          first = false;
          delay = RETRY_MIN_MS;
          for await (const message of stream) handlers.current.onMessage(message);
        } catch (error) {
          if (controller.signal.aborted) return;
          // Signed out or no workspace: the app handles those; don't hammer the API.
          const code = errorCode(error);
          if (code === "UNAUTHENTICATED" || code === "NO_ACTIVE_ORGANIZATION") return;
        }
        await sleep(delay);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      }
    })();
    return () => controller.abort();
  }, [client, key]);
}

/** Keeps live screens fresh: refetches the queries each message affects. */
export function useLiveUpdates(activeOrganizationId: string | null | undefined) {
  const { api } = useApi();
  const queryClient = useQueryClient();
  const refetch = {
    "todos.changed": () => queryClient.invalidateQueries({ queryKey: api.todo.list.key() }),
    "notifications.changed": () =>
      queryClient.invalidateQueries({ queryKey: api.notifications.key() }),
    "files.changed": () => queryClient.invalidateQueries({ queryKey: api.files.key() }),
  } satisfies Record<RealtimeMessage["type"], () => Promise<void>>;

  useRealtime(
    (message) => void refetch[message.type](),
    () => {
      for (const run of Object.values(refetch)) void run();
    },
    activeOrganizationId,
  );
}
