import type { NextRequest } from "next/server";

import { currentSession, exchangeSession } from "@/lib/server/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  return currentSession(request);
}

export function POST(request: NextRequest) {
  return exchangeSession(request);
}
