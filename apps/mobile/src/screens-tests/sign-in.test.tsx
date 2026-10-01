import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import * as WebBrowser from "expo-web-browser";
// Tests live outside src/app: every file there is a route.
import { aSession, fail, fakeApi, openApp, server } from "../../test/app";

// The sign-in page opens in the system's browser sheet, which tests don't have: each test
// says how the person left it.
jest.mock("expo-web-browser", () => ({
  openAuthSessionAsync: jest.fn(),
  WebBrowserResultType: { CANCEL: "cancel" },
}));
const browser = jest.mocked(WebBrowser.openAuthSessionAsync);

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

  describe("with Google", () => {
    const withGoogle = (overrides: Parameters<typeof fakeApi>[0] = {}) =>
      fakeApi({
        "/rpc/system/info": () => ({ features: { google: true }, minimumClientVersion: "0.0.0" }),
        "/api/auth/mobile/sign-in/start": () => ({ id: "handoff-1", secret: "secret-1" }),
        "/api/auth/sign-in/social": () => ({
          url: "https://accounts.google.com/o/oauth2/v2/auth?state=state-1",
          redirect: false,
        }),
        "/api/auth/mobile/sign-in/finish": () => {
          server.session = aSession();
          return new Response(JSON.stringify({ status: true }), {
            headers: {
              "content-type": "application/json",
              "set-cookie": "better-auth.session_token=token-1; Path=/; HttpOnly",
            },
          });
        },
        ...overrides,
      });
    const continueWithGoogle = async () =>
      fireEvent.press(await screen.findByText("Continue with Google"));

    it("isn't offered unless the server has it set up", async () => {
      fakeApi();
      await openApp("/sign-in");
      expect(await screen.findByText("Welcome back")).toBeOnTheScreen();
      expect(screen.queryByText("Continue with Google")).toBeNull();
    });

    it("signs in without the session ever being in the link back to the app", async () => {
      const calls = withGoogle();
      browser.mockResolvedValue({ type: "success", url: "boilerplate:///?handoff=handoff-1" });
      const app = await openApp("/sign-in");
      await continueWithGoogle();
      expect(
        await screen.findByText("Nothing to do. Add your first todo above."),
      ).toBeOnTheScreen();
      expect(app.pathname()).toBe("/");
      const social = calls.find((call) => call.path === "/api/auth/sign-in/social")?.input;
      expect(social).toMatchObject({ provider: "google", disableRedirect: true });
      expect(new URL(String(social?.callbackURL)).searchParams.get("handoff")).toBe("handoff-1");
      // The provider's page, through the API's proxy, coming back to the same link.
      const [page, back] = browser.mock.calls[0] ?? [];
      expect(new URL(String(page)).searchParams.get("authorizationURL")).toBe(
        "https://accounts.google.com/o/oauth2/v2/auth?state=state-1",
      );
      expect(back).toBe(social?.callbackURL);
      // The secret goes only to the API, which answers with the session.
      expect(calls.find((call) => call.path === "/api/auth/mobile/sign-in/finish")?.input).toEqual({
        id: "handoff-1",
        secret: "secret-1",
      });
      const later = calls.filter((call) => call.path === "/api/auth/get-session").at(-1);
      expect(later?.headers.get("cookie")).toContain("better-auth.session_token=token-1");
    });

    it("stays on sign-in, without a word, when the person closes Google's page", async () => {
      const calls = withGoogle();
      browser.mockResolvedValue({ type: WebBrowser.WebBrowserResultType.CANCEL });
      const app = await openApp("/sign-in");
      await continueWithGoogle();
      await waitFor(() => expect(browser).toHaveBeenCalled());
      expect(calls.map((call) => call.path)).not.toContain("/api/auth/mobile/sign-in/finish");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(app.pathname()).toBe("/sign-in");
    });

    it("says so when the session can't be handed over", async () => {
      withGoogle({
        "/api/auth/mobile/sign-in/finish": () => fail(401, "SIGN_IN_INCOMPLETE"),
      });
      browser.mockResolvedValue({ type: "success", url: "boilerplate:///?handoff=handoff-1" });
      await openApp("/sign-in");
      await continueWithGoogle();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "The sign-in didn't finish. Please try again.",
      );
    });

    it.each(["/api/auth/mobile/sign-in/start", "/api/auth/sign-in/social"])(
      "says so when the sign-in can't start (%s fails)",
      async (failing) => {
        withGoogle({ [failing]: () => fail(500) });
        await openApp("/sign-in");
        await continueWithGoogle();
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "Something went wrong. Please try again.",
        );
      },
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
