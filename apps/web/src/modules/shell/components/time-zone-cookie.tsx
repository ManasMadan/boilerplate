"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { setPreferenceCookie } from "@/lib/cookies";

/**
 * Records the browser's time zone once so server-rendered dates use it. Renders nothing.
 */
export function TimeZoneCookie({ current }: { current: string }) {
  const router = useRouter();
  useEffect(() => {
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (browser && browser !== current) {
      setPreferenceCookie("tz", browser);
      router.refresh();
    }
  }, [current, router]);
  return null;
}
