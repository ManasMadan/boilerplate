"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { errorCode } from "@repo/client";
import { useMeQuery } from "@repo/client/api/user/me";
import {
  useRemovePhoneMutation,
  useSendPhoneCodeMutation,
  useVerifyPhoneMutation,
} from "@repo/client/api/user/phone";
import { phoneNumberSchema } from "@repo/contracts/auth";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { FieldGroup } from "@repo/ui/components/field";
import { Skeleton } from "@repo/ui/components/skeleton";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { OtpField, TextField } from "@/components/form-fields";
import { useApiErrorMessage } from "@/lib/use-api-error";
import { useAuthSchemas } from "@/modules/auth";
import { ReauthPrompt } from "./reauth-prompt";

type Step = { name: "view" } | { name: "number" } | { name: "code"; phoneNumber: string };

/**
 * The account's phone number, for security texts. Adding or changing it texts a code to
 * the new number first; the API alerts the account (and the previous number) afterwards.
 */
export function PhoneCard() {
  const t = useTranslations("settings.security.phone");
  const errorMessage = useApiErrorMessage();
  const me = useMeQuery();
  const remove = useRemovePhoneMutation();
  const [step, setStep] = useState<Step>({ name: "view" });
  const [stale, setStale] = useState(false);

  const handle = (error: unknown) => {
    if (errorCode(error) === "FRESH_SESSION_REQUIRED") setStale(true);
    else toast.error(errorMessage(error));
  };

  const phoneNumber = me.data?.phoneNumber ?? null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {stale ? (
          <ReauthPrompt />
        ) : !me.data ? (
          <Skeleton className="h-9 w-48" />
        ) : step.name === "view" ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm">
              {phoneNumber ? (
                <span className="font-medium">{phoneNumber}</span>
              ) : (
                <span className="text-muted-foreground">{t("none")}</span>
              )}
            </p>
            <Button variant="outline" size="sm" onClick={() => setStep({ name: "number" })}>
              {phoneNumber ? t("change") : t("add")}
            </Button>
            {phoneNumber ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(undefined, {
                    onSuccess: () => toast.success(t("removed")),
                    onError: handle,
                  })
                }
              >
                {t("remove")}
              </Button>
            ) : null}
          </div>
        ) : step.name === "number" ? (
          <NumberStep
            onSent={(number) => setStep({ name: "code", phoneNumber: number })}
            onCancel={() => setStep({ name: "view" })}
            onError={handle}
          />
        ) : (
          <CodeStep
            phoneNumber={step.phoneNumber}
            onDone={() => {
              toast.success(t("verified"));
              setStep({ name: "view" });
            }}
            onBack={() => setStep({ name: "number" })}
            onError={handle}
          />
        )}
      </CardContent>
    </Card>
  );
}

interface StepProps {
  onError: (error: unknown) => void;
}

function NumberStep({
  onSent,
  onCancel,
  onError,
}: StepProps & { onSent: (phoneNumber: string) => void; onCancel: () => void }) {
  const t = useTranslations("settings.security.phone");
  const send = useSendPhoneCodeMutation();
  const schema = z.object({ phoneNumber: useAuthSchemas().phone });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { phoneNumber: "" } });

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(async ({ phoneNumber }) => {
        // The number as the API will store it, so the next step shows (and sends) that.
        const normalized = phoneNumberSchema.parse(phoneNumber);
        try {
          await send.mutateAsync({ phoneNumber: normalized });
          onSent(normalized);
        } catch (error) {
          onError(error);
        }
      })}
    >
      <FieldGroup>
        <TextField
          control={form.control}
          name="phoneNumber"
          label={t("number")}
          type="tel"
          autoComplete="tel"
          placeholder="+14155550123"
        />
        <div className="flex gap-2">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {t("sendCode")}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("cancel")}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

function CodeStep({
  phoneNumber,
  onDone,
  onBack,
  onError,
}: StepProps & { phoneNumber: string; onDone: () => void; onBack: () => void }) {
  const t = useTranslations("settings.security.phone");
  const errorMessage = useApiErrorMessage();
  const verify = useVerifyPhoneMutation();
  const resend = useSendPhoneCodeMutation();
  const schema = z.object({ code: useAuthSchemas().otp });
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { code: "" } });

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit(async ({ code }) => {
        try {
          await verify.mutateAsync({ phoneNumber, code });
          onDone();
        } catch (error) {
          if (errorCode(error) === "FRESH_SESSION_REQUIRED") return onError(error);
          form.setValue("code", "");
          form.setError("code", { message: errorMessage(error) });
        }
      })}
    >
      <FieldGroup>
        <p className="text-sm text-muted-foreground">{t("codeSent", { phoneNumber })}</p>
        <OtpField control={form.control} name="code" label={t("code")} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {t("verify")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={resend.isPending}
            onClick={() =>
              resend.mutate(
                { phoneNumber },
                {
                  onSuccess: () => toast.success(t("codeSent", { phoneNumber })),
                  onError,
                },
              )
            }
          >
            {t("resend")}
          </Button>
          <Button type="button" variant="ghost" onClick={onBack}>
            {t("cancel")}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
