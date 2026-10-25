import type { Metadata } from "next";

import { TemplatesScreen } from "@/components/templates-screen";
import { getConfigSnapshot, getTemplate, listTemplates } from "@/lib/server/runtime";

export const metadata: Metadata = { title: "Plantillas" };
export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const templates = listTemplates();
  const first = templates[0];
  const selected = params.new === "1" || !first ? null : getTemplate(first.name);
  const model = getConfigSnapshot().entries.find((entry) => entry.key === "model")?.value;
  return <TemplatesScreen templates={templates} selected={selected} defaultModel={typeof model === "string" ? model : "jev-1.13"} />;
}
