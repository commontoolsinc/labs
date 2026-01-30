/**
 * Ambient type declarations for the Temporal API.
 *
 * Temporal is available at runtime via the temporal-polyfill package and is
 * injected into the SES sandbox by the runner.  TypeScript's bundled lib declarations do not yet
 * include Temporal, so we declare the subset used by patterns here.
 */

declare namespace Temporal {
  interface Instant {
    readonly epochMilliseconds: number;
    toString(): string;
  }

  interface PlainDate {
    readonly year: number;
    readonly month: number;
    readonly day: number;
    toString(): string;
    subtract(duration: { years?: number; months?: number; days?: number }): PlainDate;
  }

  interface Now {
    instant(): Instant;
    plainDateISO(): PlainDate;
  }

  const Now: Now;

  const PlainDate: {
    from(item: { year: number; month: number; day: number } | string): PlainDate;
    compare(a: PlainDate, b: PlainDate): number;
  };
}
