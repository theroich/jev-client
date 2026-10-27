"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  HistoryDetail,
  HistoryFilterValues,
  HistoryPage,
} from "@/lib/types";
import {
  buildHistoryCommand,
  filtersFromSearchParams,
  filtersToSearchParams,
  formatCost,
  formatDate,
  formatTokens,
} from "@/lib/utils";
import { describeApiError, useConsole } from "./console-context";
import {
  Button,
  Callout,
  CliBar,
  EmptyState,
  Icon,
  JsonBlock,
  KvList,
  Loading,
  Panel,
  ScreenHead,
  StatusPill,
  Tabs,
} from "./ui";

export function HistoryScreen({
  initialPage,
  initialFilters,
  initialDetail,
}: {
  initialPage: HistoryPage;
  initialFilters: HistoryFilterValues;
  initialDetail?: HistoryDetail | null;
}) {
  const [page, setPage] = useState(initialPage);
  const [filters, setFilters] = useState(initialFilters);
  const [detail, setDetail] = useState<HistoryDetail | null>(initialDetail ?? null);
  const [selected, setSelected] = useState<number | null>(initialDetail?.id ?? null);
  const [tab, setTab] = useState("request");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const first = useRef(true);
  const exportHandled = useRef(false);
  const { request, copy, notify, ready } = useConsole();

  const load = useCallback(async (nextFilters = filters) => {
    setLoading(true);
    try {
      const query = filtersToSearchParams(nextFilters, true);
      const [nextPage, nextDetail] = await Promise.all([
        request<HistoryPage>(`/api/history?${query}`),
        selected ? request<HistoryDetail>(`/api/history/${selected}`) : Promise.resolve(null),
      ]);
      setPage(nextPage);
      if (nextDetail) setDetail(nextDetail);
      setError(null);
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setLoading(false);
    }
  }, [filters, request, selected]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void load(filters);
    // load runs when the filters change; refresh/focus call load directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  useEffect(() => {
    const focus = () => void load();
    const popstate = () => {
      const params = new URLSearchParams(window.location.search);
      setFilters(filtersFromSearchParams(params));
      const id = Number(params.get("id"));
      if (Number.isInteger(id) && id > 0) void select(id, false);
    };
    window.addEventListener("focus", focus);
    window.addEventListener("popstate", popstate);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("popstate", popstate);
    };
  }, [load]);

  const updateFilters = (update: Partial<HistoryFilterValues>) => {
    const next = { ...filters, ...update };
    setFilters(next);
    const params = filtersToSearchParams(next);
    window.history.pushState(window.history.state, "", `${window.location.pathname}?${params}`);
  };

  const select = async (id: number, updateUrl = true) => {
    setSelected(id);
    setTab("request");
    if (updateUrl) {
      const params = new URLSearchParams(window.location.search);
      params.set("id", String(id));
      window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params}`);
    }
    try {
      setDetail(await request<HistoryDetail>(`/api/history/${id}`));
      setError(null);
    } catch (caught) {
      setError(describeApiError(caught));
    }
  };

  const exportUrl = () => `/api/history/export?${filtersToSearchParams(filters, true)}`;
  const download = () => {
    const anchor = document.createElement("a");
    anchor.href = exportUrl();
    anchor.download = "jev-history.jsonl";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    notify("JSONL export requested with the active filters");
  };

  useEffect(() => {
    if (!ready || exportHandled.current || new URLSearchParams(window.location.search).get("export") !== "1") return;
    exportHandled.current = true;
    const params = new URLSearchParams(window.location.search);
    params.delete("export");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
    download();
    // Only processes the initial palette action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return (
    <section>
      <ScreenHead
        eyebrow="Library · jev history"
        title="History"
        description={<>One real row per <code>ask</code>, <code>demo</code> run or per request in a <code>batch</code>. No headers or API key are stored.</>}
        actions={<><Button onClick={() => void load()} disabled={loading}><Icon name="refresh" />Refresh</Button><Button onClick={download}><Icon name="download" />Export JSONL</Button></>}
      />
      {error ? <div className="mt-12"><Callout tone="danger">{error.message}{error.hint ? <><br /><strong>hint:</strong> {error.hint}</> : null}</Callout></div> : null}
      <Panel tight className="history-filters">
        <div className="panel-body" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field" style={{ flex: "1 1 150px" }}><label htmlFor="history-since">Since · local day</label><input id="history-since" className="input mono" type="date" value={filters.since} onChange={(event) => updateFilters({ since: event.target.value })} /></div>
          <div className="field" style={{ flex: "1 1 110px" }}><label htmlFor="history-status">Status</label><select id="history-status" className="select mono" value={filters.status} onChange={(event) => updateFilters({ status: event.target.value })}><option value="">all</option>{page.facets.statuses.map((status) => <option value={status} key={status}>{status}</option>)}</select></div>
          <div className="field" style={{ flex: "1 1 140px" }}><label htmlFor="history-model">Model</label><select id="history-model" className="select mono" value={filters.model} onChange={(event) => updateFilters({ model: event.target.value })}><option value="">all</option>{page.facets.models.map((model) => <option value={model} key={model}>{model}</option>)}</select></div>
          <div className="field" style={{ flex: "1 1 140px" }}><label htmlFor="history-template">Template</label><select id="history-template" className="select mono" value={filters.template} onChange={(event) => updateFilters({ template: event.target.value })}><option value="">all</option>{page.facets.templates.map((template) => <option value={template} key={template}>{template}</option>)}</select></div>
          <div className="field" style={{ flex: "0 1 92px" }}><label htmlFor="history-limit">Limit</label><input id="history-limit" className="input mono" type="number" min={1} max={200} value={filters.limit} onChange={(event) => updateFilters({ limit: Math.max(1, Math.min(200, Number(event.target.value) || 50)) })} /></div>
          {filters.batch ? <span className="chip" title="Batch filter">batch: {filters.batch}<button type="button" className="link" aria-label="Remove batch filter" onClick={() => updateFilters({ batch: "" })}>×</button></span> : null}
          <Button variant="ghost" size="sm" onClick={() => updateFilters({ since: "", status: "", model: "", template: "", batch: "", limit: 50 })}>Clear</Button>
        </div>
      </Panel>

      {loading ? <div className="mt-12"><Loading label="Refreshing from requests…" /></div> : null}
      <div className="grid grid-hist mt-12">
        <Panel tight>
          {page.items.length === 0 ? <EmptyState title="No request matches the filters" action={<Button size="sm" onClick={() => updateFilters({ since: "", status: "", model: "", template: "", batch: "", limit: 50 })}>Clear filters</Button>}>Try other filters or run a saved evaluation.</EmptyState> : <div className="table-wrap"><table className="dt" aria-label="Request history">
            <thead><tr><th>Date</th><th>Status</th><th>Model</th><th>Template</th><th>Source</th><th className="num">Tokens</th><th className="num">Cost</th><th className="num">ms</th></tr></thead>
            <tbody>{page.items.map((record) => <tr key={record.id} className="clickable" tabIndex={0} aria-selected={selected === record.id} aria-label={`Open request ${record.id}`} onClick={() => void select(record.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void select(record.id); } }}>
              <td className="mono cell-muted" suppressHydrationWarning>{formatDate(record.createdAt)}</td><td><StatusPill status={record.statusCode} ok={record.ok} /></td><td className="mono">{record.model ?? "—"}</td><td>{record.templateName ?? "—"}</td><td className="mono">{record.batchId ? <span title={record.batchId}>batch · {record.batchId.slice(0, 8)}</span> : "ask"}</td><td className="num">{formatTokens(record.inputTokens, record.outputTokens)}</td><td className="num">{formatCost(record.cost)}</td><td className="num">{record.durationMs ?? "—"}</td>
            </tr>)}</tbody>
          </table></div>}
          <div className="panel-foot"><span>{page.items.length} requests · limit {filters.limit}</span><span className="mono" style={{ fontSize: 10.5 }}>requests</span></div>
        </Panel>

        {!detail ? <Panel><EmptyState title="Select a request">The table can be navigated with Tab and opened with Enter or Space.</EmptyState></Panel> : <Panel tight>
          <div className="panel-body history-detail-stack" style={{ borderBottom: "1px solid var(--border)" }}>
            <div className="row-between"><div className="row"><StatusPill status={detail.statusCode} ok={detail.ok} /><strong>Request #{detail.id}</strong></div><div className="action-row"><Button size="sm" variant="ghost" onClick={() => void copy(JSON.stringify(detail.exportRecord, null, 2))}>Copy JSON</Button><Button size="sm" variant="ghost" onClick={() => void copy(`${JSON.stringify(detail.exportRecord)}\n`)}>Copy JSONL</Button></div></div>
            <KvList items={[
              ["created_at", detail.createdAt], ["model", detail.model ?? "—"], ["template", detail.templateName ?? "—"], ["batch_id", <span className="code-value" key="batch">{detail.batchId ?? "—"}</span>], ["tokens", formatTokens(detail.inputTokens, detail.outputTokens)], ["cost", formatCost(detail.cost)], ["duration", detail.durationMs === null ? "—" : `${detail.durationMs} ms`],
            ]} />
          </div>
          <Tabs label="Request detail" value={tab} onChange={setTab} items={[{ id: "request", label: "Request" }, { id: "response", label: "Response" }, { id: "error", label: "Error" }]} />
          <div className="panel-body">
            {tab === "request" ? <JsonBlock value={detail.request} /> : null}
            {tab === "response" ? <JsonBlock value={detail.response} /> : null}
            {tab === "error" ? detail.errorCode || detail.errorMessage ? <div className="stack"><Callout tone="danger"><strong>{detail.errorCode ?? "error"}</strong><br />{detail.errorMessage ?? "No message"}</Callout><JsonBlock value={detail.response} /></div> : <EmptyState title="No error">This request has no error_code or error_message.</EmptyState> : null}
          </div>
        </Panel>}
      </div>
      <CliBar command={buildHistoryCommand(filters)} />
    </section>
  );
}
