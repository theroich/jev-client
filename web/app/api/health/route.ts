import { errorResponse, json } from "@/lib/server/api";
import { getHealth } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  try {
    return json(getHealth());
  } catch (error) {
    return errorResponse(error);
  }
}
