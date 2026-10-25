import type { NextRequest } from "next/server";

import { json, readJson, withApi } from "@/lib/server/api";
import { getConfigSnapshot, saveConfigChanges } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return withApi(request, false, () => json(getConfigSnapshot()));
}

export function PUT(request: NextRequest) {
  return withApi(request, true, async () => json(saveConfigChanges(await readJson(request))));
}
