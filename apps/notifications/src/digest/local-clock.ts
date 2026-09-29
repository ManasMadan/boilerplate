/** The hour and calendar date it is now in a time zone (UTC when the zone is unknown). */
export function localClock(timeZone: string, now = new Date()) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    return localClock("UTC", now);
  }
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { hour: Number(get("hour")), date: `${get("year")}-${get("month")}-${get("day")}` };
}
