import { fireEvent, screen, waitFor } from "@testing-library/react-native";
// Tests live outside src/app: every file there is a route.
import { aSession, fail, fakeApi, openApp, server } from "../../test/app";

const signedIn = () => {
  server.session = aSession();
  return { redirect: false, token: "token-1", user: server.session.user };
};

async function signIn(email = "ada@example.com", password = "correct horse") {
  await fireEvent.changeText(await screen.findByLabelText("Email"), email);
  await fireEvent.changeText(screen.getByLabelText("Password"), password);
  await fireEvent.press(screen.getByText("Sign in"));
}

describe("signing in", () => {
  it("is where a signed-out user starts", async () => {
    fakeApi();
    const app = await openApp("/");
    expect(await screen.findByText("Welcome back")).toBeOnTheScreen();
    expect(app.pathname()).toBe("/sign-in");
  });

  it("checks the form before asking the server", async () => {
    const calls = fakeApi();
    await openApp("/sign-in");
    await signIn("not an email", "");
    expect(await screen.findByText("Enter a valid email address")).toBeOnTheScreen();
    expect(calls.map((call) => call.path)).not.toContain("/api/auth/sign-in/email");
  });

  it("opens the todos once the password is right", async () => {
    const calls = fakeApi({ "/api/auth/sign-in/email": signedIn });
    const app = await openApp("/sign-in");
    await signIn();
    expect(await screen.findByText("Nothing to do. Add your first todo above.")).toBeOnTheScreen();
    expect(app.pathname()).toBe("/");
    expect(calls.find((call) => call.path === "/api/auth/sign-in/email")?.input).toEqual({
      email: "ada@example.com",
      password: "correct horse",
    });
  });

  it("says when the email and password don't match", async () => {
    fakeApi({ "/api/auth/sign-in/email": () => fail(401, "INVALID_EMAIL_OR_PASSWORD") });
    await openApp("/sign-in");
    await signIn();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That email and password don't match.",
    );
  });

  it("falls back to a generic sentence for errors it has no words for", async () => {
    fakeApi({ "/api/auth/sign-in/email": () => fail(500) });
    await openApp("/sign-in");
    await signIn();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Something went wrong. Please try again.",
    );
  });

  it("asks for the emailed code when the address isn't verified yet", async () => {
    fakeApi({ "/api/auth/sign-in/email": () => fail(403, "EMAIL_NOT_VERIFIED") });
    const app = await openApp("/sign-in");
    await signIn();
    expect(await screen.findByText("Check your email")).toBeOnTheScreen();
    expect(app.pathnameWithParams()).toBe("/verify-email?email=ada%40example.com");
  });

  it("continues on the two-step screen when the account has a second factor", async () => {
    fakeApi({ "/api/auth/sign-in/email": () => ({ twoFactorRedirect: true }) });
    const app = await openApp("/sign-in");
    await signIn();
    expect(await screen.findByText("Two-step verification")).toBeOnTheScreen();
    expect(app.pathname()).toBe("/two-factor");
  });

  it("offers Google only when the server has it set up", async () => {
    const calls = fakeApi({
      "/api/auth/sign-in/social": () => ({ redirect: false }),
      "/rpc/system/info": () => ({ features: { google: true }, minimumClientVersion: "0.0.0" }),
    });
    await openApp("/sign-in");
    await fireEvent.press(await screen.findByText("Continue with Google"));
    await waitFor(() =>
      expect(calls.find((call) => call.path === "/api/auth/sign-in/social")?.input).toMatchObject({
        provider: "google",
      }),
    );
  });

  it("links to creating an account", async () => {
    fakeApi();
    const app = await openApp("/sign-in");
    await fireEvent.press(await screen.findByText("Create account"));
    expect(await screen.findByText("Create your account")).toBeOnTheScreen();
    expect(app.pathname()).toBe("/sign-up");
  });
});
