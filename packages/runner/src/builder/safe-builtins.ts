/**
 * Transitional SES exceptions for legacy nondeterministic built-ins.
 *
 * These helpers intentionally expose ambient time/randomness in a narrow,
 * explicit form so existing patterns can keep running while the long-term
 * design moves toward stronger time/entropy services.
 */

export function nonPrivateRandom(): number {
  return Math.random();
}

export function safeDateNow(): number {
  return Date.now();
}
