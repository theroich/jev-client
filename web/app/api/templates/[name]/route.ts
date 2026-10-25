import type { NextRequest } from "next/server";

import { json, readJson, withApi } from "@/lib/server/api";
import { deleteTemplate, getTemplate, renameTemplate, updateTemplate } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params;
  return withApi(request, false, () => json(getTemplate(name)));
}

export async function PUT(request: NextRequest, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params;
  return withApi(request, true, async () => json(updateTemplate(name, await readJson(request))));
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params;
  return withApi(request, true, async () => json(renameTemplate(name, await readJson(request))));
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params;
  return withApi(request, true, () => {
    deleteTemplate(name);
    return json({ ok: true });
  });
}
