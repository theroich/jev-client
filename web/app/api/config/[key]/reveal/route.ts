import type { NextRequest } from "next/server";

import { ConsoleError, json, withApi } from "@/lib/server/api";
import { revealApiKey } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
  return withApi(request, true, () => {
    if (key !== "api_key") throw new ConsoleError(400, "invalid_reveal", "Solo api_key admite revelado explícito");
    return json(revealApiKey());
  });
}
