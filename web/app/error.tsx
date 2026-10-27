"use client";

import { Button, Callout } from "@/components/ui";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset(): void }) {
  return <section><div className="screen-head"><div><p className="eyebrow">Local console error</p><h1>The screen could not be loaded</h1><p className="sub">The database may be locked, use a newer schema, or hold an invalid configuration value. No data has been deleted.</p></div></div><Callout tone="danger">{error.message}</Callout><div className="action-row mt-16"><Button variant="primary" onClick={reset}>Retry</Button><Button onClick={() => window.location.reload()}>Reload</Button></div></section>;
}
