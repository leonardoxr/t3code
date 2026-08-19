/**
 * Fractional index keys: base-26 strings ordered by plain string comparison, so
 * inserting or moving one item writes ONE key to ONE row and never renumbers its
 * neighbors. Used for user-arranged pinned threads (where neighbors may live on
 * other servers entirely) and for a thread's queued follow-ups.
 *
 * @module orderKey
 */
const ORDER_KEY_DIGITS = "abcdefghijklmnopqrstuvwxyz";

export function isValidOrderKey(key: string): boolean {
  if (key.length === 0) return false;
  for (const char of key) {
    if (!ORDER_KEY_DIGITS.includes(char)) return false;
  }
  // A trailing minimum digit would leave no room to sort a key immediately
  // before this one; generators never produce it, so treat it as corrupt.
  return key.at(-1) !== ORDER_KEY_DIGITS[0];
}

/** Midpoint of two digit strings interpreted as fractions in (0, 1).
    "" stands for the open bound on either side. Requires a < b. */
function orderKeyMidpoint(a: string, b: string): string {
  if (b !== "" && a >= b) throw new Error("orderKeyMidpoint: bounds out of order");
  if (b !== "") {
    // Recurse past the longest common prefix ("a" pads the shorter side).
    let n = 0;
    while ((a.charAt(n) || ORDER_KEY_DIGITS[0]) === b.charAt(n)) n += 1;
    if (n > 0) return b.slice(0, n) + orderKeyMidpoint(a.slice(n), b.slice(n));
  }
  const digitA = a === "" ? 0 : ORDER_KEY_DIGITS.indexOf(a.charAt(0));
  const digitB = b === "" ? ORDER_KEY_DIGITS.length : ORDER_KEY_DIGITS.indexOf(b.charAt(0));
  if (digitB - digitA > 1) {
    return ORDER_KEY_DIGITS.charAt(Math.round((digitA + digitB) / 2));
  }
  // Consecutive leading digits: either b has spare digits to shorten into,
  // or we extend a (never producing a trailing minimum digit — the base
  // case midpoint("", "") is the middle of the alphabet).
  if (b.length > 1) return b.charAt(0);
  return ORDER_KEY_DIGITS.charAt(digitA) + orderKeyMidpoint(a.slice(1), "");
}

/** Key that sorts strictly between two neighbors; null bounds mean "before
    everything" / "after everything". Returns null instead of throwing when the
    existing keys are corrupt or out of order — callers fall back to rewriting
    the whole run. */
export function orderKeyBetween(before: string | null, after: string | null): string | null {
  const a = before ?? "";
  const b = after ?? "";
  if (a !== "" && !isValidOrderKey(a)) return null;
  if (b !== "" && !isValidOrderKey(b)) return null;
  if (b !== "" && a >= b) return null;
  return orderKeyMidpoint(a, b);
}

/** Evenly spaced keys for rewriting a whole run (used when an insertion point
    sits next to keyless rows, so single-key insertion has nothing to anchor
    on). Two base-26 digits give 675 slots — far beyond any real run — with
    monotonicity enforced as a belt-and-braces. */
export function generateSpreadOrderKeys(count: number): string[] {
  const space = ORDER_KEY_DIGITS.length * ORDER_KEY_DIGITS.length;
  const step = space / (count + 1);
  const keys: string[] = [];
  let previous = 0;
  for (let i = 0; i < count; i += 1) {
    let value = Math.max(Math.round(step * (i + 1)), previous + 1);
    // Skip values whose low digit is the minimum (a trailing "a" key).
    if (value % ORDER_KEY_DIGITS.length === 0) value += 1;
    value = Math.min(value, space - 1);
    previous = value;
    keys.push(
      ORDER_KEY_DIGITS.charAt(Math.floor(value / ORDER_KEY_DIGITS.length)) +
        ORDER_KEY_DIGITS.charAt(value % ORDER_KEY_DIGITS.length),
    );
  }
  return keys;
}
