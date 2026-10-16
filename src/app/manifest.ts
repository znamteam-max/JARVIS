import type { MetadataRoute } from "next";

// Lets the browser install /app as a standalone home-screen app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "JARVIS",
    short_name: "JARVIS",
    description: "Калории, расписание и тренировки",
    lang: "ru",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    background_color: "#0F1218",
    theme_color: "#0F1218",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
