import { fireEvent, screen } from "@testing-library/react-native";
// Tests live outside src/app: every file there is a route.
import { aSession, fail, fakeApi, openApp, server } from "../../test/app";

const url = "/verify-email?email=ada%40example.com";

async function enter(code: string) {
  await fireEvent.changeText(await screen.findByLabelText("Verification code"), code);
  await fireEvent.press(screen.getByText("Continue"));
}

describe("verifying an email address", () => {
  it.each(["/verify-email", "/verify-email?email=nonsense"])(
    "goes back to sign-in without a valid address (%s)",
    async (link) => {
      fakeApi();
      const app = await openApp(link);
      expect(await screen.findByText("Welcome back")).toBeOnTheScreen();
      expect(app.pathname()).toBe("/sign-in");
    },
  );

  it("names the address the code went to and checks the code's shape", async () => {
    const calls = fakeApi();
    await openApp(url);
    expect(
      await screen.findByText("Enter the 6-digit code we sent to ada@example.com."),
    ).toBeOnTheScreen();
    await enter("12");
    expect(await screen.findByText("Enter the 6-digit code")).toBeOnTheScreen();
    expect(calls.map((call) => call.path)).not.toContain("/api/auth/email-otp/verify-email");
  });

  it("clears a wrong code and says why", async () => {
    fakeApi({ "/api/auth/email-otp/verify-email": () => fail(400, "INVALID_OTP") });
    await openApp(url);
    await enter("123456");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That code is wrong or has expired.",
    );
    expect(screen.getByLabelText("Verification code")).toHaveDisplayValue("");
  });

  it("signs the user in with the right code", async () => {
    const calls = fakeApi({
      "/api/auth/email-otp/verify-email": () => {
        server.session = aSession();
        return { status: true };
      },
    });
    const app = await openApp(url);
    await enter("123456");
    expect(await screen.findByText("Nothing to do. Add your first todo above.")).toBeOnTheScreen();
    expect(app.pathname()).toBe("/");
    expect(calls.find((call) => call.path === "/api/auth/email-otp/verify-email")?.input).toEqual({
      email: "ada@example.com",
      otp: "123456",
    });
  });

  it("sends a new code when asked", async () => {
    const calls = fakeApi({
      "/api/auth/email-otp/send-verification-otp": () => ({ success: true }),
    });
    await openApp(url);
    await fireEvent.press(await screen.findByText("Resend code"));
    expect(await screen.findByRole("status")).toHaveTextContent("A new code is on its way.");
    expect(
      calls.find((call) => call.path === "/api/auth/email-otp/send-verification-otp")?.input,
    ).toEqual({ email: "ada@example.com", type: "email-verification" });
  });

  it("says when a new code can't be sent yet", async () => {
    fakeApi({ "/api/auth/email-otp/send-verification-otp": () => fail(429) });
    await openApp(url);
    await fireEvent.press(await screen.findByText("Resend code"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many attempts. Wait a minute and try again.",
    );
  });
});
