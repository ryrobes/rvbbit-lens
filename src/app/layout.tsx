import type { Metadata } from "next"
import "./globals.css"
import { GOOGLE_FONTS_HREF } from "@/lib/desktop/fonts"

export const metadata: Metadata = {
  title: "Data Rabbit",
  description: "Local-first SQL desktop for Postgres + rvbbit",
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="dark" className="dark" suppressHydrationWarning>
      <head>
        {/* Pre-hydration script — applies saved theme before first
            paint (avoids FOUC), and wraps console.error to swallow
            Next.js 16.2.6's spurious "Set objects are not supported"
            warning that originates in framework serialization. Lives
            in /public so React 19 doesn't warn about <script> being
            rendered through the React tree. */}
        <script src="/pre-hydration.js" />
        {/* Preload candidates for the Desktop > Font submenu. Each
            family is small; only the ones a user picks actually render.
            Browser-cache means the cost is paid once per origin. The
            URL lives in lib/desktop/fonts.ts beside the option tables
            so the two never drift. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={GOOGLE_FONTS_HREF} />
      </head>
      <body className="antialiased font-sans">
        {children}
      </body>
    </html>
  )
}
