import type { NextRequest } from "next/server";

import { ConsoleError, readJson, withApi } from "@/lib/server/api";
import { getConsoleRuntime, getTemplate } from "@/lib/server/runtime";
import { MAX_CONCURRENCY, type BatchEvent, type BatchSummary } from "../../../../dist/src/service.js";

type StreamEvent =
  | Exclude<BatchEvent, { type: "batch.finish" }>
  | { type: "batch.finish"; batchId: string; summary: BatchSummary }
  | { type: "batch.error"; error: { code: string; message: string } };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return withApi(request, true, async () => {
    const body = await readJson(request, 5_000_000);
    const templateName = body.templateName;
    if (typeof templateName !== "string" || !templateName.trim()) {
      throw new ConsoleError(400, "invalid_template", "Selecciona una plantilla");
    }
    getTemplate(templateName);
    if (!Array.isArray(body.contexts)) {
      throw new ConsoleError(400, "invalid_contexts", "contexts debe ser un array de mapas de contexto");
    }
    if (body.contexts.length > 1000) {
      throw new ConsoleError(400, "too_many_contexts", "El máximo es 1.000 contextos por lote");
    }
    const contexts = body.contexts;
    const concurrency = body.concurrency === undefined ? 1 : Number(body.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
      throw new ConsoleError(400, "invalid_concurrency", `concurrency debe ser un entero entre 1 y ${MAX_CONCURRENCY}`);
    }
    const failFast = body.failFast === true;
    const save = body.save !== false;
    const runtime = getConsoleRuntime();
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException("Lote cancelado por el cliente", "AbortError"));
    if (request.signal.aborted) abort();
    else request.signal.addEventListener("abort", abort, { once: true });

    let currentBatchId = "";
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(output) {
        const encoder = new TextEncoder();
        const send = (event: StreamEvent) => {
          if (closed) return;
          try {
            output.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            closed = true;
            controller.abort(new DOMException("Lote cancelado por el cliente", "AbortError"));
          }
        };
        try {
          await runtime.service.batch(templateName, contexts, {
            concurrency,
            failFast,
            save,
            signal: controller.signal,
            onEvent: (event) => {
              if (event.type === "batch.start") currentBatchId = event.batchId;
              if (event.type === "batch.finish") send({ ...event, batchId: currentBatchId });
              else send(event);
            },
          });
        } catch (error) {
          send({ type: "batch.error", error: { code: "batch_error", message: error instanceof Error ? error.message : String(error) } });
        } finally {
          request.signal.removeEventListener("abort", abort);
          if (!closed) {
            closed = true;
            output.close();
          }
        }
      },
      cancel() {
        closed = true;
        controller.abort(new DOMException("Lote cancelado por el cliente", "AbortError"));
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  });
}
