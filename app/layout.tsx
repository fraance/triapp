import type { Metadata, Viewport } from "next";
import { Archivo, JetBrains_Mono, Newsreader } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import Nav from "@/components/Nav";
import AuthGuard from "@/components/AuthGuard";

/**
 * Three typefaces, three jobs. See the header comment in globals.css.
 *
 * Archivo carries the `wdth` axis, which is the whole point of choosing it:
 * display headings run at ~115-118% width for the heavy, extended, editorial
 * look, while the same file serves normal-width UI text. One download, two
 * registers.
 */
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
  variable: "--font-archivo",
});

/** The coach's speaking voice, and only that. */
const newsreader = Newsreader({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-newsreader",
});

/** Measurements: TSS, durations, dates, confidence, source counts. */
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "TriApp",
  description: "Your AI-powered triathlon training companion",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "TriApp",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

/**
 * Without `width: device-width` a phone renders the page at ~980px and scales
 * it down, so everything looks tiny. `viewportFit: cover` lets the page use the
 * full screen on notched iPhones.
 *
 * `maximumScale` is deliberately left alone — pinch-zoom stays available, which
 * matters for accessibility.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f3f0ea",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${newsreader.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        <AuthProvider>
          <Nav />
          {/* Bottom padding clears the floating mobile tab bar. */}
          <div className="pb-28 sm:pb-0">
            <AuthGuard>{children}</AuthGuard>
          </div>
        </AuthProvider>
      </body>
    </html>
  );
}
