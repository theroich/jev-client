import type { NextRequest } from "next/server";

import { json, withApi } from "@/lib/server/api";
import { docsTool } from "@/lib/server/mcp-docs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params;
  return withApi(request, false, () => json(docsTool(name)));
}
