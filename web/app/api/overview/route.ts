import type { NextRequest } from "next/server";

import { json, withApi } from "@/lib/server/api";
import { getOverview } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return withApi(request, false, () => json(getOverview(Number(request.nextUrl.searchParams.get("window") ?? "30"))));
}
