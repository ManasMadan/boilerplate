import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { Screen } from "@/components/screen";
import { Text } from "@/components/ui/text";
import { useAuthErrorMessage } from "@/hooks/use-auth";
import { authClient } from "@/lib/auth-client";

/**
 * boilerplate://invitations/<id> (and the same path of the site's URL, once universal
 * links are set up): joins the workspace and switches to it.
 */
export default function Invitation() {
  const t = useTranslations("mobile.invitation");
  const errorMessage = useAuthErrorMessage();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: session } = authClient.useSession();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    if (!session || !id) return;
    void (async () => {
      const { data, error } = await authClient.organization.acceptInvitation({ invitationId: id });
      if (error) return setFailure(errorMessage(error));
      await authClient.organization.setActive({ organizationId: data.invitation.organizationId });
      router.replace("/");
    })();
  }, [session, id, errorMessage]);

  return (
    <Screen>
      <Text role={failure ? "alert" : "status"}>{failure ?? t("accepting")}</Text>
    </Screen>
  );
}
