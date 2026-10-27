"use client";

import "./globals.css";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset(): void }) {
  return (
    <html lang="en">
      <body>
        <main className="content" style={{ maxWidth: 760, paddingTop: 64 }}>
          <p className="eyebrow">jev · startup error</p>
          <h1>The console could not be opened</h1>
          <p className="sub">Check the SQLite path and permissions, whether another process keeps the database locked, or whether PRAGMA user_version is newer than this release. No data has been migrated or deleted.</p>
          <div className="callout danger mt-16" role="alert">{error.message}</div>
          <div className="action-row mt-16"><button type="button" className="btn btn-primary" onClick={reset}>Retry</button><button type="button" className="btn btn-outline" onClick={() => window.location.reload()}>Reload</button></div>
          <p className="hint mt-16">You can also pick another database with <code>jev web-console --db /path/jev.db</code>.</p>
        </main>
      </body>
    </html>
  );
}
