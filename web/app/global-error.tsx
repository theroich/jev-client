"use client";

import "./globals.css";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset(): void }) {
  return (
    <html lang="es">
      <body>
        <main className="content" style={{ maxWidth: 760, paddingTop: 64 }}>
          <p className="eyebrow">jev · error de arranque</p>
          <h1>No se pudo abrir la consola</h1>
          <p className="sub">Comprueba la ruta y los permisos de SQLite, si otra proceso mantiene la base bloqueada o si PRAGMA user_version es más reciente que esta versión. No se ha migrado ni borrado ningún dato.</p>
          <div className="callout danger mt-16" role="alert">{error.message}</div>
          <div className="action-row mt-16"><button type="button" className="btn btn-primary" onClick={reset}>Reintentar</button><button type="button" className="btn btn-outline" onClick={() => window.location.reload()}>Recargar</button></div>
          <p className="hint mt-16">También puedes elegir otra base con <code>jev web-console --db /ruta/jev.db</code>.</p>
        </main>
      </body>
    </html>
  );
}
