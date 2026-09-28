import { z } from "zod";
import { base } from "./base";

export const meSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.email(),
  image: z.string().nullable(),
  locale: z.string(),
  timezone: z.string(),
  activeOrganizationId: z.uuid().nullable(),
});

export const userContract = {
  me: base
    .route({ method: "GET", path: "/me", tags: ["Account"], summary: "The signed-in user" })
    .output(meSchema),
};
