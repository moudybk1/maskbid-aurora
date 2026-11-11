import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";

const CATEGORIES = new Set(["watch", "art", "digital_collectible", "other"]);
const DIR = join(process.cwd(), "data", "metadata");
const problem = (status: number, code: string, detail: string) => NextResponse.json({ type: `urn:maskbid:error:${code.toLowerCase().replace(/_/g, "-")}`, title: detail, status, code, detail }, { status });

/** Freeze public metadata v1 (spec 15 §13): canonical UTF-8 JSON, NFC text, SHA-256 of raw bytes, content-addressed. */
export async function POST(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > 262144) return problem(413, "BODY_TOO_LARGE", "Body exceeds 256 KiB");
  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return problem(400, "INVALID_JSON", "Body must be JSON"); }
  const nfc = (v: unknown) => (typeof v === "string" ? v.normalize("NFC").trim() : "");
  const title = nfc(b.title), description = nfc(b.description), category = nfc(b.category), condition = nfc(b.condition), issuerWallet = nfc(b.issuerWallet).toLowerCase();
  const images = Array.isArray(b.images) ? b.images.map(nfc).filter(Boolean) : [];
  if (title.length < 3 || title.length > 120) return problem(422, "INVALID_METADATA", "Title must be 3–120 characters");
  if (description.length < 1 || description.length > 5000) return problem(422, "INVALID_METADATA", "Description must be 1–5000 characters");
  if (!CATEGORIES.has(category)) return problem(422, "INVALID_METADATA", "Unknown category");
  if (condition.length < 1 || condition.length > 80) return problem(422, "INVALID_METADATA", "Condition must be 1–80 characters");
  if (!/^0x[0-9a-f]{40}$/.test(issuerWallet)) return problem(422, "INVALID_METADATA", "issuerWallet must be an address");
  if (images.length > 4 || images.some((u) => !/^https?:\/\/[^\s]+$/.test(u) || u.length > 512)) return problem(422, "INVALID_METADATA", "Up to 4 http(s) image URLs");

  // Fixed field order; raw bytes are what gets hashed and served back verbatim.
  const canonical = JSON.stringify({ schemaVersion: 1, title, description, category, condition, isDemo: Boolean(b.isDemo), issuerWallet, images });
  const bytes = Buffer.from(canonical, "utf8");
  const hash = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, `${hash}.json`), bytes);
  const origin = process.env.APP_ORIGIN ?? new URL(req.url).origin;
  return NextResponse.json({ uri: `${origin}/api/metadata/${hash}`, metadataHash: `0x${hash}` });
}
