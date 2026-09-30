import { fireEvent, screen } from "@testing-library/react-native";
// Tests live outside src/app: every file there is a route.
import { fail, fakeApi, openApp } from "../../test/app";

async function signUp(name: string, email: string, password: string) {
  await fireEvent.changeText(await screen.findByLabelText("Full name"), name);
  await fireEvent.changeText(screen.getByLabelText("Email"), email);
  await fireEvent.changeText(screen.getByLabelText("Password"), password);
  await fireEvent.press(screen.getByText("Create account"));
}

describe("creating an account", () => {
  it("checks the form before asking the server", async () => {
    const calls = fakeApi();
    await openApp("/sign-up");
    await signUp("", "ada@example.com", "short");
    expect(await screen.findByText("Enter your name")).toBeOnTheScreen();
    expect(screen.getByText("Use at least 8 characters")).toBeOnTheScreen();
    expect(calls.map((call) => call.path)).not.toContain("/api/auth/sign-up/email");
  });

  it("sends the device's language and time zone, then asks for the emailed code", async () => {
    const calls = fakeApi({ "/api/auth/sign-up/email": () => ({ token: null }) });
    const app = await openApp("/sign-up");
    await signUp("Ada", "ada@example.com", "correct horse");
    expect(await screen.findByText("Check your email")).toBeOnTheScreen();
    expect(app.pathnameWithParams()).toBe("/verify-email?email=ada%40example.com");
    expect(calls.find((call) => call.path === "/api/auth/sign-up/email")?.input).toEqual({
      name: "Ada",
      email: "ada@example.com",
      password: "correct horse",
      locale: "en",
      timezone: expect.any(String),
    });
  });

  it("says when the email already has an account", async () => {
    fakeApi({
      "/api/auth/sign-up/email": () => fail(422, "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"),
    });
    await openApp("/sign-up");
    await signUp("Ada", "ada@example.com", "correct horse");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "An account with this email already exists.",
    );
  });

  it("links back to signing in", async () => {
    fakeApi();
    const app = await openApp("/sign-up");
    await fireEvent.press(await screen.findByText("Sign in"));
    expect(await screen.findByText("Welcome back")).toBeOnTheScreen();
    expect(app.pathname()).toBe("/sign-in");
  });
});
