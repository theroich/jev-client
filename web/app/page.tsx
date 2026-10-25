import { OverviewScreen } from "@/components/overview-screen";
import { getOverview } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const raw = typeof params.window === "string" ? Number(params.window) : 30;
  const window = Number.isInteger(raw) && raw >= 1 && raw <= 200 ? raw : 30;
  return <OverviewScreen initialData={getOverview(window)} />;
}
