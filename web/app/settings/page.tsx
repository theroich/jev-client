import type { Metadata } from "next";

import { ConfigScreen } from "@/components/config-screen";
import { getConfigSnapshot } from "@/lib/server/runtime";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default function Page() {
  return <ConfigScreen initialSnapshot={getConfigSnapshot()} />;
}
