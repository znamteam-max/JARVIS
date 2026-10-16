import { redirect } from "next/navigation";

// The site root is the app itself; the API lives under /api (health: /api/health).
export default function HomePage() {
  redirect("/app");
}
