import type { Metadata } from "next";

import { BatchScreen } from "@/components/batch-screen";
import { listTemplates } from "@/lib/server/runtime";

export const metadata: Metadata = { title: "Lotes" };
export const dynamic = "force-dynamic";

export default function Page() {
  return <BatchScreen templates={listTemplates()} />;
}
