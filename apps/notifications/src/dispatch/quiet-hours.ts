/**
 * Quiet hours: a window in the user's time zone (it may cross midnight, e.g. 22:00 to
 * 07:00) when push and SMS wait. Returns how long to wait, or 0 outside the window.
 */
export function quietDelayMs(
  window: { start: number; end: number } | null,
  timeZone: string,
  now = new Date(),
): number {
  if (!window || window.start === window.end) return 0;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const minute = get("hour") * 60 + get("minute");
  const crossesMidnight = window.start > window.end;
  const inside = crossesMidnight
    ? minute >= window.start || minute < window.end
    : minute >= window.start && minute < window.end;
  if (!inside) return 0;
  const minutesLeft = (window.end - minute + 1440) % 1440;
  return (minutesLeft * 60 - get("second")) * 1000;
}
