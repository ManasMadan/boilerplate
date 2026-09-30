/**
 * A local, stateful stand-in for the parts of Stripe the app uses: customers, Checkout,
 * the billing portal, subscriptions and invoices. It keeps state between calls (unlike
 * stripe-mock), checks the secret key, honours Idempotency-Key, and sends signed webhooks
 * to apps/webhooks exactly like Stripe does, so billing can be tested end to end, in
 * integration tests and in the browser.
 *
 * Hosted pages: `/checkout/<session>` (pay, pay with a declined card, or go back) and
 * `/portal/<session>` (cancel or resume the plan, then return). Test hooks under
 * `/__fake/` make a renewal fail, a subscription lapse, or add an invoice in any status.
 *
 * Only what the app calls is implemented; anything else answers 404 like an unknown
 * Stripe route, so a new Stripe call fails loudly in tests until it's added here.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";

export interface FakeStripeOptions {
  secretKey: string;
  /** Where to send events (apps/webhooks' /webhooks/stripe), and the signing secret. */
  webhookUrl: string;
  webhookSecret: string;
  /** Price ids the app may use: their interval and unit amount (cents). */
  prices: Record<string, { interval: "month" | "year"; unitAmount: number }>;
  port?: number;
}

type Form = Record<string, unknown>;

// The fake's objects hold only what the app reads. Each field it shares with Stripe's own
// types takes its type from them, so a field Stripe renames or retypes in an SDK upgrade
// fails to compile here instead of the fake quietly answering the old shape.
interface Subscription
  extends Pick<
    Stripe.Subscription,
    "id" | "object" | "metadata" | "cancel_at_period_end" | "trial_end" | "canceled_at" | "created"
  > {
  customer: string;
  status: Stripe.Subscription.Status;
  items: { object: "list"; data: SubscriptionItem[] };
}

interface SubscriptionItem
  extends Pick<
    Stripe.SubscriptionItem,
    "id" | "object" | "current_period_start" | "current_period_end"
  > {
  // Optional and nullable in Stripe's types; the fake always sets them.
  quantity: number;
  price: Pick<Stripe.Price, "id" | "object"> & {
    unit_amount: number;
    recurring: Pick<Stripe.Price.Recurring, "interval">;
  };
}

interface Invoice
  extends Pick<
    Stripe.Invoice,
    "id" | "object" | "number" | "amount_due" | "created" | "hosted_invoice_url"
  > {
  customer: string;
  /** Where this API version puts an invoice's subscription. */
  parent: {
    type: Stripe.Invoice.Parent["type"];
    subscription_details: { subscription: string };
  };
  /**
   * A draft has no number or hosted page until it's finalized. Any status: tests set ones
   * Stripe doesn't document, as a newer API version could.
   */
  status: string;
  currency: "usd";
}

const now = () => Math.floor(Date.now() / 1000);
const id = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;

/** Stripe's form encoding (`a[b][0][c]=x`) into nested objects and arrays. */
export function parseForm(body: string): Form {
  const root: Form = {};
  for (const [key, value] of new URLSearchParams(body)) {
    const path = key.replaceAll("]", "").split("[");
    let node: Record<string, unknown> = root;
    path.forEach((part, index) => {
      if (index === path.length - 1) {
        node[part] = value;
        return;
      }
      const next = path[index + 1] as string;
      node[part] ??= /^\d+$/.test(next) ? [] : {};
      node = node[part] as Record<string, unknown>;
    });
  }
  return root;
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font-family:sans-serif;max-width:32rem;margin:3rem auto"><h1>${title}</h1>${body}</body></html>`;

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

export async function startFakeStripe(options: FakeStripeOptions) {
  const customers = new Map<
    string,
    { id: string; object: "customer"; metadata: Record<string, string> }
  >();
  const sessions = new Map<string, Form & { id: string }>();
  const portals = new Map<string, { customer: string; return_url: string }>();
  const subscriptions = new Map<string, Subscription>();
  const invoices: Invoice[] = [];
  const idempotent = new Map<string, { status: number; body: unknown }>();
  const events: { type: string; object: unknown }[] = [];
  let baseUrl = "";

  async function emit(type: string, object: unknown) {
    events.push({ type, object });
    const payload = JSON.stringify({
      id: id("evt"),
      object: "event",
      api_version: Stripe.API_VERSION,
      created: now(),
      livemode: false,
      type,
      data: { object },
    });
    // Async: under Bun the SDK signs with SubtleCrypto, which has no synchronous API.
    const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: options.webhookSecret,
    });
    const response = await fetch(options.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body: payload,
    });
    if (!response.ok) throw new Error(`webhook ${type} was refused: ${response.status}`);
  }

  function invoiceFor(subscription: Subscription, status: string) {
    const item = subscription.items.data[0] as SubscriptionItem;
    const draft = status === "draft";
    const invoice: Invoice = {
      id: id("in"),
      object: "invoice",
      customer: subscription.customer,
      parent: {
        type: "subscription_details",
        subscription_details: { subscription: subscription.id },
      },
      number: draft ? null : `FAKE-${String(invoices.length + 1).padStart(4, "0")}`,
      status,
      amount_due: subscription.status === "trialing" ? 0 : item.price.unit_amount * item.quantity,
      currency: "usd",
      created: now(),
      hosted_invoice_url: draft ? null : `${baseUrl}/invoices/${invoices.length + 1}`,
    };
    invoices.push(invoice);
    return invoice;
  }

  function subscribe(session: Form & { id: string }) {
    const lines = session.line_items as { price: string; quantity: string }[];
    const line = lines[0] as { price: string; quantity: string };
    const price = options.prices[line.price];
    if (!price) throw new Error(`unknown price ${line.price}`);
    const data = (session.subscription_data ?? {}) as {
      metadata?: Record<string, string>;
      trial_period_days?: string;
    };
    const trialDays = Number(data.trial_period_days ?? 0);
    const start = now();
    const end = start + (price.interval === "month" ? 30 : 365) * 86_400;
    const subscription: Subscription = {
      id: id("sub"),
      object: "subscription",
      customer: session.customer as string,
      status: trialDays > 0 ? "trialing" : "active",
      metadata: data.metadata ?? {},
      cancel_at_period_end: false,
      trial_end: trialDays > 0 ? start + trialDays * 86_400 : null,
      canceled_at: null,
      created: start,
      items: {
        object: "list",
        data: [
          {
            id: id("si"),
            object: "subscription_item",
            quantity: Number(line.quantity ?? 1),
            current_period_start: start,
            current_period_end: end,
            price: {
              id: line.price,
              object: "price",
              recurring: { interval: price.interval },
              unit_amount: price.unitAmount,
            },
          },
        ],
      },
    };
    subscriptions.set(subscription.id, subscription);
    return subscription;
  }

  async function api(method: string, path: string, form: Form, query: URLSearchParams) {
    if (method === "POST" && path === "/v1/customers") {
      const customer = {
        id: id("cus"),
        object: "customer" as const,
        metadata: (form.metadata ?? {}) as Record<string, string>,
      };
      customers.set(customer.id, customer);
      return customer;
    }
    if (method === "POST" && path === "/v1/checkout/sessions") {
      if (!customers.has(form.customer as string)) return notFound("customer");
      const session = { ...form, id: id("cs"), object: "checkout.session", status: "open" };
      sessions.set(session.id, session);
      return { ...session, url: `${baseUrl}/checkout/${session.id}` };
    }
    const expire = /^\/v1\/checkout\/sessions\/(cs_\w+)\/expire$/.exec(path);
    if (method === "POST" && expire) {
      const session = sessions.get(expire[1] as string);
      if (!session) return notFound("checkout session");
      if (session.status !== "open") {
        return {
          status: 400,
          body: {
            error: {
              type: "invalid_request_error",
              message: "Only Checkout Sessions with a status of open can be expired.",
            },
          },
        };
      }
      session.status = "expired";
      return session;
    }
    if (method === "POST" && path === "/v1/billing_portal/sessions") {
      if (!customers.has(form.customer as string)) return notFound("customer");
      const portal = id("bps");
      portals.set(portal, {
        customer: form.customer as string,
        return_url: form.return_url as string,
      });
      return { id: portal, object: "billing_portal.session", url: `${baseUrl}/portal/${portal}` };
    }
    const subscriptionPath = /^\/v1\/subscriptions\/(sub_\w+)$/.exec(path);
    if (subscriptionPath) {
      const subscription = subscriptions.get(subscriptionPath[1] as string);
      if (!subscription) return notFound("subscription");
      if (method === "GET") return subscription;
      if (method === "DELETE") {
        subscription.status = "canceled";
        subscription.canceled_at = now();
        await emit("customer.subscription.deleted", subscription);
        return subscription;
      }
      if (method === "POST") {
        const items = (form.items ?? []) as { id: string; quantity?: string }[];
        for (const change of items) {
          const item = subscription.items.data.find((existing) => existing.id === change.id);
          if (!item) return notFound("subscription item");
          if (change.quantity !== undefined) item.quantity = Number(change.quantity);
        }
        if (form.cancel_at_period_end !== undefined)
          subscription.cancel_at_period_end = form.cancel_at_period_end === "true";
        await emit("customer.subscription.updated", subscription);
        return subscription;
      }
    }
    if (method === "GET" && path === "/v1/subscriptions") {
      const data = [...subscriptions.values()].filter((s) => s.customer === query.get("customer"));
      return { object: "list", data, has_more: false };
    }
    if (method === "GET" && path === "/v1/invoices") {
      const data = invoices
        .filter((invoice) => invoice.customer === query.get("customer"))
        .reverse()
        .slice(0, Number(query.get("limit") ?? 10));
      return { object: "list", data, has_more: false };
    }
    return undefined;
  }

  function notFound(what: string) {
    return {
      status: 404,
      body: { error: { type: "invalid_request_error", message: `No such ${what}` } },
    };
  }

  async function hosted(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    form: Form,
  ) {
    const html = (status: number, body: string) => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    };
    const redirect = (to: string) => {
      response.writeHead(303, { location: to });
      response.end();
    };

    const checkout = /^\/checkout\/(cs_\w+)(\/pay)?$/.exec(path);
    if (checkout) {
      const session = sessions.get(checkout[1] as string);
      if (!session) return html(404, page("Not found", ""));
      if (session.status === "expired") {
        return html(410, page("Fake Stripe Checkout", "<p>This checkout session has expired.</p>"));
      }
      if (request.method === "POST" && checkout[2]) {
        if (form.card === "declined") {
          return html(
            402,
            page(
              "Fake Stripe Checkout",
              `<p role="alert">Your card was declined.</p><a href="${escapeHtml(`/checkout/${session.id}`)}">Try again</a>`,
            ),
          );
        }
        if (session.status !== "open") return redirect(session.success_url as string);
        session.status = "complete";
        const subscription = subscribe(session);
        invoiceFor(subscription, "paid");
        await emit("checkout.session.completed", {
          ...session,
          subscription: subscription.id,
        });
        await emit("customer.subscription.created", subscription);
        return redirect(
          (session.success_url as string).replace("{CHECKOUT_SESSION_ID}", session.id),
        );
      }
      const line = (session.line_items as { price: string; quantity: string }[])[0];
      const price = options.prices[line?.price ?? ""];
      return html(
        200,
        page(
          "Fake Stripe Checkout",
          `<p>${line?.quantity ?? 1} × ${((price?.unitAmount ?? 0) / 100).toFixed(2)} USD / ${price?.interval}</p>` +
            `<form method="post" action="/checkout/${session.id}/pay"><button>Pay</button></form>` +
            `<form method="post" action="/checkout/${session.id}/pay"><input type="hidden" name="card" value="declined"><button>Pay with a declined card</button></form>` +
            `<a href="${escapeHtml(session.cancel_url as string)}">Back</a>`,
        ),
      );
    }

    const portal = /^\/portal\/(bps_\w+)(\/cancel|\/resume)?$/.exec(path);
    if (portal) {
      const session = portals.get(portal[1] as string);
      if (!session) return html(404, page("Not found", ""));
      const subscription = [...subscriptions.values()].find(
        (s) => s.customer === session.customer && s.status !== "canceled",
      );
      if (request.method === "POST" && portal[2] && subscription) {
        subscription.cancel_at_period_end = portal[2] === "/cancel";
        await emit("customer.subscription.updated", subscription);
        return redirect(`/portal/${portal[1]}`);
      }
      const state = subscription
        ? `<p>Plan: ${subscription.status}${subscription.cancel_at_period_end ? ", cancels at the end of the period" : ""}</p>` +
          (subscription.cancel_at_period_end
            ? `<form method="post" action="/portal/${portal[1]}/resume"><button>Resume plan</button></form>`
            : `<form method="post" action="/portal/${portal[1]}/cancel"><button>Cancel plan</button></form>`)
        : "<p>No subscription.</p>";
      return html(
        200,
        page(
          "Fake Stripe Billing Portal",
          `${state}<a href="${escapeHtml(session.return_url)}">Return</a>`,
        ),
      );
    }
    return html(404, page("Not found", ""));
  }

  /**
   * Test hooks: things only time or a bank would do, and invoices in any status
   * (`/invoice?status=draft`), as Stripe's dashboard can leave them.
   */
  async function hooks(path: string, query: URLSearchParams) {
    const failed = /^\/__fake\/subscriptions\/(sub_\w+)\/payment-failed$/.exec(path);
    const lapsed = /^\/__fake\/subscriptions\/(sub_\w+)\/lapse$/.exec(path);
    // An invoice in any status (`?status=draft`: the next renewal's, as Stripe drafts it
    // an hour before it's due), without an event, as Stripe's dashboard can leave one.
    const invoice = /^\/__fake\/subscriptions\/(sub_\w+)\/invoice$/.exec(path);
    const subscription = subscriptions.get((failed ?? lapsed ?? invoice)?.[1] ?? "");
    if (!subscription) return undefined;
    if (invoice) return invoiceFor(subscription, String(query.get("status")));
    if (failed) {
      subscription.status = "past_due";
      const invoice = invoiceFor(subscription, "open");
      await emit("invoice.payment_failed", { ...invoice, attempt_count: 1 });
      await emit("customer.subscription.updated", subscription);
    } else {
      subscription.status = "canceled";
      subscription.canceled_at = now();
      await emit("customer.subscription.deleted", subscription);
    }
    return subscription;
  }

  const server = createServer(async (request, response) => {
    // A server's requests always have a URL and a method.
    const url = new URL(request.url as string, "http://fake");
    const chunks: Buffer[] = [];
    for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
    const form = parseForm(Buffer.concat(chunks).toString());
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    try {
      if (url.pathname.startsWith("/v1/")) {
        if (request.headers.authorization !== `Bearer ${options.secretKey}`) {
          return json(401, {
            error: { type: "invalid_request_error", message: "Invalid API Key" },
          });
        }
        const key = request.headers["idempotency-key"];
        const cacheKey =
          typeof key === "string" ? `${request.method} ${url.pathname} ${key}` : null;
        const cached = cacheKey ? idempotent.get(cacheKey) : undefined;
        if (cached) return json(cached.status, cached.body);
        const result = await api(request.method as string, url.pathname, form, url.searchParams);
        const answer =
          result === undefined
            ? {
                status: 404,
                body: {
                  error: { type: "invalid_request_error", message: "Unrecognized request URL" },
                },
              }
            : typeof result === "object" &&
                result !== null &&
                "status" in result &&
                "body" in result
              ? (result as { status: number; body: unknown })
              : { status: 200, body: result };
        if (cacheKey && request.method === "POST") idempotent.set(cacheKey, answer);
        return json(answer.status, answer.body);
      }
      if (url.pathname.startsWith("/__fake/")) {
        const result =
          url.pathname === "/__fake/state"
            ? { subscriptions: [...subscriptions.values()], events }
            : await hooks(url.pathname, url.searchParams);
        return result ? json(200, result) : json(404, { error: "not found" });
      }
      return await hosted(request, response, url.pathname, form);
    } catch (error) {
      json(500, { error: { type: "api_error", message: (error as Error).message } });
    }
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    url: baseUrl,
    port,
    events,
    customers,
    subscriptions,
    /** The subscription an organization has (by the orgId the app puts in metadata). */
    subscriptionFor: (orgId: string) =>
      [...subscriptions.values()].find((s) => s.metadata.orgId === orgId),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
export type FakeStripe = Awaited<ReturnType<typeof startFakeStripe>>;
