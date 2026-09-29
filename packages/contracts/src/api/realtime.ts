import { eventIterator } from "@orpc/contract";
import { realtimeMessage } from "../realtime";
import { base } from "./base";

export const realtimeContract = {
  /**
   * A stream of change notifications for the signed-in user and their active workspace.
   * It ends after a while (the client reconnects, re-checking the session), and when the
   * workspace is switched the client opens a new one.
   */
  subscribe: base
    .route({
      method: "GET",
      path: "/realtime",
      tags: ["Realtime"],
      summary: "Live change notifications (SSE)",
    })
    .output(eventIterator(realtimeMessage)),
};
