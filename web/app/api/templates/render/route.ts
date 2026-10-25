import type { NextRequest } from "next/server";

import { json, readJson, withApi } from "@/lib/server/api";
import { renderTemplateDraft } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return withApi(request, true, async () => json(renderTemplateDraft(await readJson(request))));
}
