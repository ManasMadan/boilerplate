"use client";

import { cn } from "@repo/ui/lib/utils";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

const TABS = [
  { href: "/settings", key: "profile" },
  { href: "/settings/security", key: "security" },
] as const satisfies readonly { href: Route; key: string }[];

export function SettingsLayout({ children }: { children: ReactNode }) {
  const t = useTranslations("settings");
  const pathname = usePathname();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <nav className="flex gap-4 border-b" aria-label={t("title")}>
        {TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={pathname === tab.href ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 pb-2 text-sm",
              pathname === tab.href
                ? "border-foreground font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`${tab.key}.title`)}
          </Link>
        ))}
      </nav>
      <div className="flex max-w-2xl flex-col gap-6">{children}</div>
    </div>
  );
}
