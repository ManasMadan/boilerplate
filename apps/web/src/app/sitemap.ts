import type { MetadataRoute } from "next";

import { env } from "@/env";

const site = env.WEB_URL;

// Public pages only. Add new marketing pages here.
export default function sitemap(): MetadataRoute.Sitemap {
  return ["/", "/terms", "/privacy"].map((path) => ({ url: new URL(path, site).toString() }));
}
