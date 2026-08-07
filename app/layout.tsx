import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import Nav from "@/components/Nav";
import AuthGuard from "@/components/AuthGuard";

/**
 * Two typefaces. See the header comment in globals.css.
 *
 * Inter carries the `opsz` axis, so display settings optically tighten on
 * their own rather than needing a second cut. There is deliberately no serif
 * in this product — a different speaker is signalled with weight and measure.
 */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

/** Every number, label, timestamp and status word. */
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
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body>
        <AuthProvider>
          <Nav />
          {/* `.page-shell` already reserves the fixed tab bar plus the home
              indicator, so views that use it need nothing here. This covers
              anything that doesn't. */}
          <AuthGuard>{children}</AuthGuard>
        </AuthProvider>
      </body>
    </html>
  );
}
