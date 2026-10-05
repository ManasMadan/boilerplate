/**
 * Runs once when the server starts (never during the build): a deployed site that would
 * answer the mobile app's association files with 404 stops here instead
 * (src/lib/app-links.ts).
 */
import { requireMobileApp } from "@/lib/app-links";

export function register() {
  requireMobileApp();
}
