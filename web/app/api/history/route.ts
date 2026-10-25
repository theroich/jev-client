import type { NextRequest } from "next/server";

import { json, withApi } from "@/lib/server/api";
import { parseHistoryFilters } from "@/lib/server/history";
import { getHistoryPage } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return withApi(request, false, () => json(getHistoryPage(parseHistoryFilters(request.nextUrl.searchParams))));
}
