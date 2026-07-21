import { redirect } from "next/navigation"

// Deep link for ANY plate layout wall: rvbbit.example/wall/<layout_id>.
// Same contract as /hub — redirects into the SPA's /?wall= entry, which
// stays in the address bar while the wall is open.
export default async function WallEntry({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  redirect(`/?wall=${encodeURIComponent(id)}`)
}
