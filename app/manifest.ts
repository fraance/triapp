import type { MetadataRoute } from "next";

/**
 * Lets the app be installed to a phone home screen and opened without
 * browser chrome. See app/layout.tsx for the iOS-specific tags.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TriApp — AI triathlon coach",
    short_name: "TriApp",
    description: "Your adaptive triathlon training plan.",
    start_url: "/today",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
