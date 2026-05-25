import { ImageResponse } from "next/og"

// Tiny dynamic favicon. The browser hits /icon (with /favicon.ico
// fallback) when no <link rel="icon"> is set. Returning a real image
// here silences the dev-server 404 noise and ships an actual brand
// mark instead of the generic globe.

export const size = { width: 32, height: 32 }
export const contentType = "image/png"

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#13182a",
          color: "#2dd4cf",
          fontSize: 22,
          fontWeight: 700,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          letterSpacing: -1,
          borderRadius: 6,
        }}
      >
        æ
      </div>
    ),
    { ...size },
  )
}
