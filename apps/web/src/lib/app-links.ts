/**
 * The files iOS and Android read from this site before they let the mobile app open its
 * https links (universal links, App Links) and use its passkeys: built from the app's
 * identifiers in the environment, so each deployment names the build that talks to it.
 * Without them both answer 404, never a file with made-up ids; an https site refuses to
 * start without them (src/instrumentation.ts).
 *
 * The paths the app opens match `intentFilters` in apps/mobile/app.config.ts: a link to
 * any other page stays in the browser.
 */
import { env } from "@/env";

const APP_PATHS = ["/invitations/*"];

type AppEnv = Pick<
  typeof env,
  "APPLE_TEAM_ID" | "IOS_BUNDLE_ID" | "ANDROID_PACKAGE" | "ANDROID_CERT_FINGERPRINTS"
>;

/** The mobile app's identifiers, or undefined unless every one of them is set. */
export function mobileApp(config: AppEnv = env) {
  const { APPLE_TEAM_ID, IOS_BUNDLE_ID, ANDROID_PACKAGE, ANDROID_CERT_FINGERPRINTS } = config;
  if (!(APPLE_TEAM_ID && IOS_BUNDLE_ID && ANDROID_PACKAGE && ANDROID_CERT_FINGERPRINTS)) {
    return undefined;
  }
  return {
    appId: `${APPLE_TEAM_ID}.${IOS_BUNDLE_ID}`,
    androidPackage: ANDROID_PACKAGE,
    fingerprints: ANDROID_CERT_FINGERPRINTS,
  };
}

/** `/.well-known/apple-app-site-association`: links (applinks) and passkeys (webcredentials). */
export function appleAppSiteAssociation(config?: AppEnv) {
  const app = mobileApp(config);
  if (!app) {
    return new Response(null, { status: 404 });
  }
  // Response.json sets the application/json type Apple requires for this extensionless file.
  return Response.json({
    applinks: {
      details: [{ appIDs: [app.appId], components: APP_PATHS.map((path) => ({ "/": path })) }],
    },
    webcredentials: { apps: [app.appId] },
  });
}

/** `/.well-known/assetlinks.json`: links (handle_all_urls) and passkeys (get_login_creds). */
export function assetLinks(config?: AppEnv) {
  const app = mobileApp(config);
  if (!app) {
    return new Response(null, { status: 404 });
  }
  return Response.json([
    {
      relation: [
        "delegate_permission/common.handle_all_urls",
        "delegate_permission/common.get_login_creds",
      ],
      target: {
        namespace: "android_app",
        package_name: app.androidPackage,
        sha256_cert_fingerprints: app.fingerprints,
      },
    },
  ]);
}

/** Stops an https site (any deployment) that would serve no association files. */
export function requireMobileApp(config: AppEnv & { WEB_URL: string } = env) {
  if (new URL(config.WEB_URL).protocol === "https:" && !mobileApp(config)) {
    throw new Error(
      "APPLE_TEAM_ID, IOS_BUNDLE_ID, ANDROID_PACKAGE and ANDROID_CERT_FINGERPRINTS are required " +
        'on an https site (docs/web-and-mobile.md, "Universal links and App Links").',
    );
  }
}
