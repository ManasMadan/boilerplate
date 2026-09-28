import type { MetadataRoute } from "next";

import { env } from "@/env";

const site = env.WEB_URL;

// Signed-in pages and auth flows are useless to crawlers; keep them out of the index.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/dashboard",
        "/settings",
        "/invitations",
        "/sign-",
        "/verify-email",
        "/forgot-password",
        "/reset-password",
        "/two-factor",
      ],
    },
    sitemap: `${site}/sitemap.xml`,
  };
}
