import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Serves the frozen bytes verbatim so any client can recompute the on-chain SHA-256. */
export async function GET(_req: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  if (!/^[0-9a-f]{64}$/.test(hash)) return new Response("not found", { status: 404 });
  try {
    const bytes = readFileSync(join(process.cwd(), "data", "metadata", `${hash}.json`));
    return new Response(bytes, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=31536000, immutable", "access-control-allow-origin": "*" } }); // public, content-addressed: any origin may verify it
  } catch {
    return new Response("not found", { status: 404 });
  }
}
