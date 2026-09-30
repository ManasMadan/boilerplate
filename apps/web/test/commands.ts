/**
 * What a browser test asks Node to do (`commands.<name>()` from `vitest/browser`), for
 * the few things a page can't: read the codes the API queued for the notification
 * service, set data up in the database, drive the browser itself (cookies, client IP,
 * a virtual passkey authenticator) and catch full-page navigations.
 */
import { randomInt } from "node:crypto";
import type { NotificationPayload } from "@repo/jobs";
import { totp as totpCode } from "@repo/testing/totp";
import { Queue } from "bullmq";
import pg from "pg";
import type { CDPSession, Page } from "playwright";
import type { BrowserCommand } from "vitest/node";
import { REDIS_URL, services } from "./services";

/** Full-page navigations each page tried since its test started, in order. */
const navigations = new WeakMap<Page, string[]>();

/**
 * A stand-in for Cloudflare Turnstile's script (the widget itself needs Cloudflare): it
 * renders a widget that passes at once with Cloudflare's test token, which the API with
 * captcha on accepts (its secret is Cloudflare's always-pass test key). Tests make a
 * widget's token expire or fail with `turnstile.expire()` and `turnstile.fail()`.
 */
const FAKE_TURNSTILE = `window.turnstile = (() => {
  const widgets = new Map();
  let last = 0;
  const pass = (id) => setTimeout(() => widgets.get(id)?.callback("XXXX.DUMMY.TOKEN.XXXX"));
  return {
    render(element, options) {
      const id = String(++last);
      widgets.set(id, options);
      element.dataset.widget = id;
      pass(id);
      return id;
    },
    reset: pass,
    remove: (id) => widgets.delete(id),
    expire: () => widgets.forEach((options) => options["expired-callback"]()),
    fail: () => widgets.forEach((options) => options["error-callback"]()),
  };
})();`;

/** How the Turnstile script answers on each page: the stand-in, blocked, or broken. */
const turnstileModes = new WeakMap<Page, "fake" | "blocked" | "empty">();

/**
 * Every test starts signed out, from a client IP of its own (the API rate-limits auth
 * per IP and trusts X-Forwarded-For from loopback), with full-page navigations caught:
 * the test page would otherwise leave for the sign-in page or Stripe's checkout. They
 * are answered 204 No Content, which browsers treat as "stay where you are".
 */
const startTest: BrowserCommand<[]> = async ({ page, context }) => {
  await context.clearCookies();
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `10.${randomInt(250)}.${randomInt(250)}.${randomInt(1, 250)}`,
  });
  turnstileModes.set(page, "fake");
  if (!navigations.has(page)) {
    await page.route("https://challenges.cloudflare.com/turnstile/**", (route) => {
      const mode = turnstileModes.get(page);
      if (mode === "blocked") return route.abort();
      return route.fulfill({
        contentType: "text/javascript",
        body: mode === "empty" ? "" : FAKE_TURNSTILE,
      });
    });
    await page.route(
      (url) => !url.pathname.startsWith("/__vitest") && !url.pathname.startsWith("/@"),
      (route) => {
        const request = route.request();
        if (!request.isNavigationRequest() || request.frame() === page.mainFrame())
          return route.fallback();
        navigations.get(page)?.push(request.url());
        return route.fulfill({ status: 204 });
      },
    );
  }
  navigations.set(page, []);
};

/** The full-page navigations the page tried since the test started. */
const hardNavigations: BrowserCommand<[]> = ({ page }) => navigations.get(page) ?? [];

async function sqlRows<T>(query: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: (await services()).databaseUrl });
  await client.connect();
  try {
    return (await client.query(query, params)).rows as T[];
  } finally {
    await client.end();
  }
}

/** Notification requests (outbox rows) already handed to a test. */
const takenRequests = new Set<string>();

/**
 * The data of the notification the API queued for `address` (an email or a phone
 * number): a one-time code, an invitation, a security alert. Waits up to five seconds.
 */
const takeNotification: BrowserCommand<[template: string, address: string]> = async (
  _context,
  template,
  address,
) => {
  const matches = (payload: NotificationPayload) => {
    const to = payload.to as { email?: string; phone?: string };
    return payload.template === template && (to.email === address || to.phone === address);
  };
  // The prefix @repo/jobs gives every queue (queuePrefix).
  const critical = new Queue("notifications-critical", {
    connection: { url: REDIS_URL },
    prefix: "{notifications-critical}",
  });
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      const jobs = await critical.getJobs(["waiting", "delayed", "prioritized"]);
      for (const job of jobs.reverse()) {
        const { payload } = job.data as { payload: NotificationPayload };
        if (matches(payload)) {
          await job.remove();
          return payload.data;
        }
      }
      // Security alerts leave through the outbox instead, which no relay drains here.
      const rows = await sqlRows<{ id: string; payload: { notification: NotificationPayload } }>(
        "SELECT id::text, payload FROM app.outbox_event WHERE name = 'notification.requested.v1' ORDER BY id DESC",
      );
      const request = rows.find(
        (row) => !takenRequests.has(row.id) && matches(row.payload.notification),
      );
      if (request) {
        takenRequests.add(request.id);
        return request.payload.notification.data;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`no ${template} queued for ${address}`);
  } finally {
    await critical.close();
  }
};

/** Runs SQL on the tests' database as its owner: data the UI can't create, or time passing. */
const sql: BrowserCommand<[query: string, params?: unknown[]]> = (_context, query, params) =>
  sqlRows(query, params);

/**
 * A virtual platform authenticator (Chrome DevTools Protocol) standing in for Touch ID
 * or Windows Hello. `present: false` makes it refuse, as when the user closes the
 * browser's passkey prompt.
 */
const authenticators = new WeakMap<Page, { cdp: CDPSession; id: string }>();
const virtualAuthenticator: BrowserCommand<[options?: { verified?: boolean }]> = async (
  { page, context },
  options = {},
) => {
  const existing = authenticators.get(page);
  if (existing) {
    await existing.cdp.send("WebAuthn.removeVirtualAuthenticator", {
      authenticatorId: existing.id,
    });
  }
  const cdp = existing?.cdp ?? (await context.newCDPSession(page));
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: options.verified ?? true,
      automaticPresenceSimulation: true,
    },
  });
  authenticators.set(page, { cdp, id: authenticatorId });
};

/**
 * How Turnstile's script loads for the rest of the test: the stand-in (the default),
 * blocked (an extension, or offline), or loading without defining the widget.
 */
const turnstile: BrowserCommand<[mode: "fake" | "blocked" | "empty"]> = ({ page }, mode) => {
  turnstileModes.set(page, mode);
};

/** Grants (or clears) a browser permission such as notifications for the test page. */
const grantPermissions: BrowserCommand<[permissions: string[]]> = async (
  { context },
  permissions,
) => {
  await context.clearPermissions();
  if (permissions.length) await context.grantPermissions(permissions);
};

/** The code an authenticator app shows for `secret` now. */
const totp: BrowserCommand<[secret: string]> = (_context, secret) => totpCode(secret);

export const commands = {
  totp,
  startTest,
  hardNavigations,
  takeNotification,
  sql,
  virtualAuthenticator,
  turnstile,
  grantPermissions,
};

declare module "vitest/browser" {
  interface BrowserCommands {
    startTest(): Promise<void>;
    totp(secret: string): Promise<string>;
    hardNavigations(): Promise<string[]>;
    takeNotification<T = Record<string, unknown>>(template: string, address: string): Promise<T>;
    sql<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
    virtualAuthenticator(options?: { verified?: boolean }): Promise<void>;
    turnstile(mode: "fake" | "blocked" | "empty"): Promise<void>;
    grantPermissions(permissions: string[]): Promise<void>;
  }
}
