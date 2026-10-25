import type { NextRequest } from "next/server";

import { json, readJson, withApi } from "@/lib/server/api";
import { executeDemo } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return withApi(request, true, async () => json(await executeDemo(await readJson(request))));
}
