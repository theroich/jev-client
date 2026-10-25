import type { NextRequest } from "next/server";

import { json, withApi } from "@/lib/server/api";
import { unsetConfig } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: NextRequest, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
  return withApi(request, true, () => json(unsetConfig(key)));
}
