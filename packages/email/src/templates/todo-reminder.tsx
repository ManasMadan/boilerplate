import { Heading, Text } from "@react-email/components";
import { Layout, type LocalizedProps } from "./layout";

export interface TodoReminderEmailProps extends LocalizedProps {
  name: string;
  title: string;
}

export const todoReminderSubject = ({ t, title }: TodoReminderEmailProps) =>
  t("email.todoReminder.subject", { title });

export default function TodoReminderEmail({ locale, t, name, title }: TodoReminderEmailProps) {
  return (
    <Layout locale={locale} t={t} preview={t("email.todoReminder.subject", { title })}>
      <Heading as="h1" style={{ fontSize: 22, margin: "0 0 12px" }}>
        {t("email.todoReminder.greeting", { name })}
      </Heading>
      <Text style={{ color: "#444", fontSize: 15 }}>{t("email.todoReminder.body", { title })}</Text>
    </Layout>
  );
}
