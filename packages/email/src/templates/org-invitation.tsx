import { Button, Heading, Text } from "@react-email/components";
import { Layout, type LocalizedProps } from "./layout";

export interface OrgInvitationEmailProps extends LocalizedProps {
  organizationName: string;
  inviterName: string;
  acceptUrl: string;
  expiresInDays: number;
}

export const orgInvitationSubject = ({
  t,
  inviterName,
  organizationName,
}: OrgInvitationEmailProps) => t("email.orgInvitation.subject", { inviterName, organizationName });

export default function OrgInvitationEmail({
  locale,
  t,
  organizationName,
  inviterName,
  acceptUrl,
  expiresInDays,
}: OrgInvitationEmailProps) {
  return (
    <Layout
      locale={locale}
      t={t}
      preview={t("email.orgInvitation.subject", { inviterName, organizationName })}
    >
      <Heading as="h1" style={{ fontSize: 22, margin: "0 0 12px" }}>
        {t("email.orgInvitation.heading", { organizationName })}
      </Heading>
      <Text style={{ color: "#444", fontSize: 15 }}>
        {t("email.orgInvitation.body", { inviterName, organizationName })}
      </Text>
      <Button
        href={acceptUrl}
        style={{
          backgroundColor: "#171717",
          borderRadius: 6,
          color: "#fff",
          fontSize: 14,
          padding: "10px 16px",
        }}
      >
        {t("email.orgInvitation.cta")}
      </Button>
      <Text style={{ color: "#8a8a8a", fontSize: 13, marginTop: 24 }}>
        {t("email.orgInvitation.expires", { days: expiresInDays })}
      </Text>
    </Layout>
  );
}
