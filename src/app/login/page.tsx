// The DataRabbit login (BURROW_PLAN §5 P4). Served by lens on the unified
// origin (the ingress routes GET /login here); the form POSTs to /login,
// which the ingress routes to the warehouse AS — it owns sessions, the
// OAuth txn continuation, rate-limiting, and (in Burrow mode) verifying
// credentials against Postgres itself. Pixels here, plumbing there.
// Failures PRG back as /login?err=1 with the flow params preserved.

const wrap: React.CSSProperties = {
  minHeight: "100dvh",
  display: "grid",
  placeItems: "center",
  background: "radial-gradient(1200px 800px at 30% -10%, #241c14 0%, #171310 45%, #100d0b 100%)",
  color: "#e8ddcc",
  fontFamily: "var(--font-mono, ui-monospace, 'JetBrains Mono', monospace)",
}

const card: React.CSSProperties = {
  width: "min(400px, 92vw)",
  padding: "34px 34px 28px",
  borderRadius: 16,
  border: "1px solid rgba(245, 180, 70, 0.16)",
  background: "rgba(24, 19, 15, 0.88)",
  boxShadow: "0 24px 80px rgba(0,0,0,0.55)",
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  marginTop: 6,
  borderRadius: 9,
  border: "1px solid rgba(232, 221, 204, 0.18)",
  background: "rgba(232, 221, 204, 0.05)",
  color: "#e8ddcc",
  fontSize: 14,
  fontFamily: "inherit",
  outline: "none",
}

const labelStyle: React.CSSProperties = {
  display: "block",
  marginTop: 16,
  fontSize: 10,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "rgba(232, 221, 204, 0.55)",
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const txn = typeof sp.txn === "string" ? sp.txn : ""
  const next = typeof sp.next === "string" ? sp.next : "/"
  const err = sp.err != null
  const oauth = txn !== ""
  return (
    <div style={wrap}>
      <form method="post" action="/login" style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span aria-hidden style={{ fontSize: 26, color: "#f5b446" }}>✦</span>
          <div>
            <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-0.01em" }}>DataRabbit</div>
            <div style={{ fontSize: 11, color: "rgba(232,221,204,0.55)" }}>
              {oauth ? "Authorize Claude to use your warehouse" : "Sign in to your data"}
            </div>
          </div>
        </div>

        {txn ? <input type="hidden" name="txn" value={txn} /> : <input type="hidden" name="next" value={next} />}

        <label style={labelStyle}>
          Username
          <input name="email" autoComplete="username" autoFocus required style={inputStyle} />
        </label>
        <label style={labelStyle}>
          Password
          <input name="password" type="password" autoComplete="current-password" required style={inputStyle} />
        </label>

        {err ? (
          <div style={{ marginTop: 14, fontSize: 12, color: "#e06c5e" }}>
            That didn&apos;t work — check your username and password.
          </div>
        ) : null}

        <button
          type="submit"
          style={{
            width: "100%", marginTop: 22, padding: "11px 0", borderRadius: 10,
            border: "1px solid rgba(245,180,70,0.55)", background: "rgba(245,180,70,0.14)",
            color: "#f5b446", fontSize: 14, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
          }}
        >
          {oauth ? "Authorize" : "Sign in"}
        </button>

        <div style={{ marginTop: 18, fontSize: 10, textAlign: "center", color: "rgba(232,221,204,0.35)" }}>
          Your database account is your login.
        </div>
      </form>
    </div>
  )
}
