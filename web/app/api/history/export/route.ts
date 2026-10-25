import type { NextRequest } from "next/server";

import { withApi } from "@/lib/server/api";
import { parseHistoryFilters } from "@/lib/server/history";
import { getHistoryExport } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return withApi(request, false, () => {
    const parsed = parseHistoryFilters(request.nextUrl.searchParams);
    const filters = { ...parsed.repository };
    if (!request.nextUrl.searchParams.has("limit")) delete filters.limit;
    return new Response(getHistoryExport(filters), {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": "attachment; filename=jev-history.jsonl",
        "Cache-Control": "no-store",
      },
    });
  });
}
