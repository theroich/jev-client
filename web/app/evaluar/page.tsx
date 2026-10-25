import type { Metadata } from "next";

import { EvaluateScreen } from "@/components/evaluate-screen";
import { getConfigSnapshot } from "@/lib/server/runtime";

export const metadata: Metadata = { title: "Evaluar" };
export const dynamic = "force-dynamic";

export default function Page() {
  const config = getConfigSnapshot();
  const model = config.entries.find((entry) => entry.key === "model")?.value;
  return <EvaluateScreen defaultModel={typeof model === "string" ? model : "jev-1.13"} />;
}
