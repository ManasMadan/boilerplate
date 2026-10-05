import { zodResolver } from "@hookform/resolvers/zod";
import { useSystemInfoQuery } from "@repo/client/api/system/info";
import { Link, router } from "expo-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { View } from "react-native";
import { useTranslations } from "use-intl";
import * as z from "zod";
import { FormField } from "@/components/form-field";
import { Screen } from "@/components/screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useAuthErrorMessage, useAuthSchemas } from "@/hooks/use-auth";
import { authClient, signInWithGoogle } from "@/lib/auth-client";

export default function SignIn() {
  const t = useTranslations();
  const errorMessage = useAuthErrorMessage();
  const schemas = useAuthSchemas();
  const { data: system } = useSystemInfoQuery();
  const [failure, setFailure] = useState<string>();
  const schema = z.object({ email: schemas.email, password: schemas.password });
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });

  const submit = form.handleSubmit(async (values) => {
    setFailure(undefined);
    const { data, error } = await authClient.signIn.email(values);
    if (error) {
      // The server has already emailed a fresh code (sendOnSignIn).
      if (error.code === "EMAIL_NOT_VERIFIED") {
        router.push({ pathname: "/verify-email", params: { email: values.email } });
      } else {
        setFailure(errorMessage(error));
      }
      return;
    }
    // With two-step verification on, the auth client continues on /two-factor instead.
    if (!(data && "twoFactorRedirect" in data && data.twoFactorRedirect)) {
      router.replace("/");
    }
  });

  const google = async () => {
    setFailure(undefined);
    const { signedIn, error } = await signInWithGoogle();
    if (error) {
      setFailure(errorMessage(error));
    }
    if (signedIn) {
      router.replace("/");
    }
  };

  return (
    <Screen title={t("auth.signInTitle")} description={t("auth.signInDescription")}>
      <FormField
        control={form.control}
        name="email"
        label={t("common.email")}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="username"
      />
      <FormField
        control={form.control}
        name="password"
        label={t("common.password")}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        onSubmitEditing={submit}
      />
      {failure ? (
        <Text role="alert" className="text-destructive">
          {failure}
        </Text>
      ) : null}
      <Button onPress={submit} disabled={form.formState.isSubmitting}>
        <Text>{t("common.signIn")}</Text>
      </Button>
      {system?.features.google ? (
        <Button variant="outline" onPress={google}>
          <Text>{t("auth.google")}</Text>
        </Button>
      ) : null}
      <View className="flex-row justify-center gap-1">
        <Text className="text-muted-foreground">{t("auth.noAccount")}</Text>
        <Link href="/sign-up">
          <Text className="underline">{t("common.signUp")}</Text>
        </Link>
      </View>
    </Screen>
  );
}
