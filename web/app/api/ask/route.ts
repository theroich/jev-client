import type { NextRequest } from "next/server";

import { json, readJson, withApi } from "@/lib/server/api";
import { executeAsk } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Headroom for a request with base64 images (16 MiB + 33% of base64 + JSON). */
const MAX_ASK_BODY_BYTES = 36 * 1024 * 1024;

export function POST(request: NextRequest) {
  return withApi(request, true, async () => json(await executeAsk(await readJson(request, MAX_ASK_BODY_BYTES))));
}
