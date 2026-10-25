import type { NextRequest } from "next/server";

import { json, withApi } from "@/lib/server/api";
import { getHistoryDetail } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return withApi(request, false, () => json(getHistoryDetail(Number(id))));
}
