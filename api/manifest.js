/* GET /api/manifest  —  "Add to Home Screen" settings for THIS school (name, colors, icon).
   Built from the same Vercel settings the site uses, so every school gets its own app icon name. */
export default function handler(req, res) {
  const name = process.env.VITE_SCHOOL_NAME || "YonaLearn";
  const short = (process.env.VITE_SCHOOL_SHORT || name).slice(0, 12);
  const ink = process.env.VITE_BRAND_INK || "#15213d";
  const paper = process.env.VITE_BRAND_PAPER || "#f6f1e7";
  const icons = [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  ];
  if (process.env.VITE_APP_ICON_URL) icons.unshift({ src: process.env.VITE_APP_ICON_URL, sizes: "512x512", type: "image/png", purpose: "any" });
  res.setHeader("Content-Type", "application/manifest+json");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.status(200).send(JSON.stringify({
    name, short_name: short, description: `${name} student portal`,
    start_url: "/", scope: "/", display: "standalone", orientation: "portrait",
    background_color: paper, theme_color: ink, icons,
  }));
}
