import Link from "next/link";

export default function NotFound() {
  return <section><div className="screen-head"><div><p className="eyebrow">404</p><h1>Screen not found</h1><p className="sub">The route does not belong to the console or the resource no longer exists.</p></div></div><Link href="/" className="btn btn-primary">Back to Overview</Link></section>;
}
