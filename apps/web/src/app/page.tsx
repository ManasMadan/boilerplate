import { cookies } from "next/headers";
import { hasSessionCookie } from "@/lib/session-cookie";
import { HomePage } from "@/modules/marketing";

export default async function Page() {
  return <HomePage signedIn={hasSessionCookie(await cookies())} />;
}
