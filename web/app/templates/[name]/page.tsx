import type { Metadata } from "next";

import { TemplatesScreen } from "@/components/templates-screen";
import { getConfigSnapshot, getConsoleRuntime, getTemplate, listTemplates } from "@/lib/server/runtime";

export const metadata: Metadata = { title: "Templates" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const exists = getConsoleRuntime().templates.get(name);
  const selected = exists ? getTemplate(name) : null;
  const model = getConfigSnapshot().entries.find((entry) => entry.key === "model")?.value;
  return <TemplatesScreen key={selected?.name ?? `missing-${name}`} templates={listTemplates()} selected={selected} missingName={selected ? undefined : name} defaultModel={typeof model === "string" ? model : "jev-1.13"} />;
}
