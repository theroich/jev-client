import type { NextRequest } from "next/server";

import { json, readJson, withApi } from "@/lib/server/api";
import { createTemplate, listTemplates } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return withApi(request, false, () => json({ items: listTemplates() }));
}

export function POST(request: NextRequest) {
  return withApi(request, true, async () => json(createTemplate(await readJson(request)), 201));
}
