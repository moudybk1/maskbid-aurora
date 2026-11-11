// Money is always a bigint in smallest units (6 decimals). Never JS Number. Spec 15 §2.
export const DECIMALS = 6;
export const TOKEN_SYMBOL = "mUSDC";
export const MAX_UINT256 = (1n << 256n) - 1n;
const GRAMMAR = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;

export class InvalidAmount extends Error {
  constructor(message = "Enter a positive amount with at most 6 decimals, e.g. 150.25") {
    super(message);
    this.name = "InvalidAmount";
  }
}

/** "150.25" -> 150250000n. Rejects scientific notation, negatives, thousands separators, >6 decimals. */
export function parseUnits6(input: string): bigint {
  const s = input.trim();
  if (!GRAMMAR.test(s)) throw new InvalidAmount();
  const [whole, frac = ""] = s.split(".");
  const value = BigInt(whole + frac.padEnd(DECIMALS, "0"));
  if (value > MAX_UINT256) throw new InvalidAmount("Amount exceeds the maximum uint256 value");
  return value;
}

/** 150250000n -> "150.25"; 100000000n -> "100". Full precision, no rounding. */
export function formatUnits6(units: bigint): string {
  if (units < 0n) throw new InvalidAmount();
  const s = units.toString().padStart(DECIMALS + 1, "0");
  const whole = s.slice(0, -DECIMALS);
  const frac = s.slice(-DECIMALS).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function formatMoney(units: bigint): string {
  return `${formatUnits6(units)} ${TOKEN_SYMBOL}`;
}

/** Strict decimal-string uint for JSON transport ("0" or digits without leading zero). */
export function parseUintString(s: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(s)) throw new InvalidAmount(`Not a canonical uint string: ${s}`);
  const v = BigInt(s);
  if (v > MAX_UINT256) throw new InvalidAmount("uint256 overflow");
  return v;
}
