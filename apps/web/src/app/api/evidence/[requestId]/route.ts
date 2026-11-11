import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NextResponse } from "next/server";

/** Execution evidence written by the adapter. Absence is "not_available", never an error about the outcome. */
export async function GET(_req: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  if (!/^0x[0-9a-f]{64}$/.test(requestId)) return NextResponse.json({ status: "not_available" }, { status: 404 });
  const dir = resolve(process.cwd(), process.env.SOLVER_EVIDENCE_DIR ?? "../solver/evidence");
  try {
    const raw = JSON.parse(readFileSync(join(dir, `${requestId}.json`), "utf8"));
    const { request, manifest, rawOutput, ...safe } = raw; // omit bulky fields; nothing in them is secret but the UI shows hashes
    void request; void manifest; void rawOutput;
    return NextResponse.json(safe, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ status: "not_available" }, { status: 404, headers: { "cache-control": "no-store" } });
  }
}
