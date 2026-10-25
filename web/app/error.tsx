"use client";

import { Button, Callout } from "@/components/ui";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset(): void }) {
  return <section><div className="screen-head"><div><p className="eyebrow">Error de la consola local</p><h1>No se pudo cargar la pantalla</h1><p className="sub">La base puede estar bloqueada, usar un esquema más nuevo o tener un valor de configuración inválido. No se han borrado datos.</p></div></div><Callout tone="danger">{error.message}</Callout><div className="action-row mt-16"><Button variant="primary" onClick={reset}>Reintentar</Button><Button onClick={() => window.location.reload()}>Recargar</Button></div></section>;
}
