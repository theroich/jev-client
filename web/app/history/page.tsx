import type { Metadata } from "next";

import { HistoryScreen } from "@/components/history-screen";
import { parseHistoryFilters } from "@/lib/server/history";
import { getHistoryDetail, getHistoryPage } from "@/lib/server/runtime";

export const metadata: Metadata = { title: "History" };
export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
  }
  const parsed = parseHistoryFilters(params);
  const id = Number(params.get("id"));
  const detail = Number.isInteger(id) && id > 0 ? getHistoryDetail(id) : null;
  const page = getHistoryPage(parsed);
  return <HistoryScreen initialPage={page} initialFilters={parsed.values} initialDetail={detail} />;
}
