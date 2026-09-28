"use client";

import { ApiProvider } from "@repo/client";
import type { Locale } from "@repo/i18n";
import { Toaster } from "@repo/ui/components/sonner";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { useRouter } from "next/navigation";
import { type AbstractIntlMessages, NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";

interface ProvidersProps {
  locale: Locale;
  timeZone: string;
  messages: AbstractIntlMessages;
  appVersion: string;
  nonce: string | undefined;
  children: ReactNode;
}

/** Every client-side context, mounted once by the root layout. */
export function Providers({
  locale,
  timeZone,
  messages,
  appVersion,
  nonce,
  children,
}: ProvidersProps) {
  const router = useRouter();
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...(nonce && { nonce })}
    >
      <NextIntlClientProvider locale={locale} timeZone={timeZone} messages={messages}>
        <ApiProvider
          options={{ appVersion, getLocale: () => locale }}
          // The session ended (signed out elsewhere, expired, revoked): back to sign-in.
          onUnauthenticated={() => router.replace("/sign-in")}
          onOutdated={() => window.location.reload()}
        >
          {children}
          <Toaster richColors closeButton />
          <ReactQueryDevtools buttonPosition="bottom-left" />
        </ApiProvider>
      </NextIntlClientProvider>
    </ThemeProvider>
  );
}
