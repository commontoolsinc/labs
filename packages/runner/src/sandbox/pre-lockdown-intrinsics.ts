/**
 * Captures original intrinsics before SES lockdown tames them.
 *
 * SES lockdown replaces Date and Math with tamed versions:
 * - `new Date()` (no args) throws in safe mode
 * - `Math.random()` returns NaN in safe mode
 *
 * We capture the originals here at module evaluation time (before lockdown)
 * and pass them as compartment globals so patterns can use them freely.
 *
 * IMPORTANT: This module must be imported before lockdown() is called.
 */

export const OriginalDate = Date;
export const OriginalMath = Math;
