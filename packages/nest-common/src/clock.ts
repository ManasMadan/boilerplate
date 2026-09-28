/**
 * Time as a dependency. Code that depends on "now" (expiry, quiet hours, retention,
 * scheduling) takes a Clock instead of calling `new Date()`, so tests can move time
 * deterministically instead of sleeping.
 */
import { Global, Module } from "@nestjs/common";

export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now() {
    return new Date();
  }
}

/** For tests: starts at a fixed instant and only moves when told to. */
export class FakeClock extends Clock {
  constructor(private current: Date = new Date("2026-01-01T00:00:00.000Z")) {
    super();
  }
  now() {
    return new Date(this.current);
  }
  set(date: Date) {
    this.current = new Date(date);
  }
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}

@Global()
@Module({ providers: [{ provide: Clock, useClass: SystemClock }], exports: [Clock] })
export class ClockModule {}
