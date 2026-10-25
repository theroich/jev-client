import type { NextRequest } from "next/server";

import { json, withApi } from "@/lib/server/api";
import { resetConfig } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return withApi(request, true, () => json(resetConfig()));
}
