import type { NextRequest } from "next/server";

import { json, withApi } from "@/lib/server/api";
import { docsMcp } from "@/lib/server/mcp-docs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return withApi(request, false, () => json(docsMcp()));
}
