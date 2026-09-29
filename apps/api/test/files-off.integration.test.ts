/**
 * Files are off without S3_BUCKET: the procedures say so and clients hide the feature.
 * (A separate file: it needs a server started without storage configured.)
 */
import { ORPCError } from "@orpc/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, type Harness, newEmail, newPassword, startApi, takeOtp } from "./harness";

let harness: Harness;
beforeAll(async () => {
  delete process.env.S3_BUCKET;
  harness = await startApi({ S3_BUCKET: "" });
});
afterAll(() => harness?.close());

describe("files off", () => {
  it("answers FEATURE_DISABLED and reports the feature off", async () => {
    const session = createSession(harness);
    const email = newEmail();
    await session.auth("/sign-up/email", { email, password: newPassword(), name: "Off" });
    const { otp } = await takeOtp(harness, email);
    await session.auth("/email-otp/verify-email", { email, otp });

    expect((await session.rpc.system.info()).features.files).toBe(false);
    const error = await session.rpc.files
      .createUpload({ purpose: "avatar", filename: "x.png", contentType: "image/png", size: 10 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, { params?: unknown }>).code).toBe("FEATURE_DISABLED");
  });
});
