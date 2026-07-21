import { redirect } from "next/navigation"

// The hand-out link (docs/HUB_PLAN.md): rvbbit.example/hub is the Hub's
// public face — a path someone can say out loud. It lands on the SPA's
// /?hub entry (optionally carrying a ?sel= artifact focus), and the shell
// keeps the param in the address bar while the wall is open, so refresh
// and copy-address both stay in the Hub.
export default async function HubEntry({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const sel = typeof sp.sel === "string" ? sp.sel : ""
  redirect(sel ? `/?hub&sel=${encodeURIComponent(sel)}` : "/?hub")
}
