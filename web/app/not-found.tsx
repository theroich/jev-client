import Link from "next/link";

export default function NotFound() {
  return <section><div className="screen-head"><div><p className="eyebrow">404</p><h1>Pantalla no encontrada</h1><p className="sub">La ruta no pertenece a la consola o el recurso ya no existe.</p></div></div><Link href="/" className="btn btn-primary">Volver a Resumen</Link></section>;
}
