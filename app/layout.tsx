import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import Nav from "@/components/Nav";
import AuthGuard from "@/components/AuthGuard";

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
  themeColor: "#4f46e5",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <Nav />
          {/* Bottom padding clears the mobile tab bar. */}
          <div className="pb-20 sm:pb-0">
            <AuthGuard>{children}</AuthGuard>
          </div>
        </AuthProvider>
      </body>
    </html>
  );
}
