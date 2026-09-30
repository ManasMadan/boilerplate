import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import { Suspense } from "react";
// Tests live outside src/app: every file there is a route.
import Invitation from "@/app/invitations/[id]";
import { I18nProvider } from "@/lib/i18n";

jest.mock("expo-router", () => ({
  router: { replace: jest.fn() },
  useLocalSearchParams: () => ({ id: "inv-1" }),
}));
const mockOrganization = {
  getInvitation: jest.fn(async () => ({ data: { organizationName: "Acme" } })),
  acceptInvitation: jest.fn(async () => ({ data: { invitation: { organizationId: "org-1" } } })),
  rejectInvitation: jest.fn(async () => ({})),
  setActive: jest.fn(async () => ({})),
};
jest.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: { user: {} } }),
    // A getter: jest.mock runs before mockOrganization is defined.
    get organization() {
      return mockOrganization;
    },
  },
}));

async function open() {
  await render(
    <Suspense fallback={null}>
      <I18nProvider locale="en">
        <Invitation />
      </I18nProvider>
    </Suspense>,
  );
  return screen.findByText("Join Acme to start collaborating.");
}

afterEach(() => jest.clearAllMocks());

describe("an invitation link", () => {
  it("shows the invitation and joins nothing until Accept is tapped", async () => {
    await open();
    expect(mockOrganization.acceptInvitation).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText("Accept invitation"));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(mockOrganization.acceptInvitation).toHaveBeenCalledWith({ invitationId: "inv-1" });
    expect(mockOrganization.setActive).toHaveBeenCalledWith({ organizationId: "org-1" });
  });

  it("can be declined", async () => {
    await open();
    await fireEvent.press(screen.getByText("Decline"));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(mockOrganization.rejectInvitation).toHaveBeenCalledWith({ invitationId: "inv-1" });
    expect(mockOrganization.acceptInvitation).not.toHaveBeenCalled();
  });
});
