import type { Metadata, Viewport } from "next";
import { Golos_Text, Unbounded } from "next/font/google";

import { MiniApp } from "./MiniApp";

const body = Golos_Text({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
});
const display = Unbounded({
  subsets: ["latin", "cyrillic"],
  weight: ["500", "700"],
  variable: "--font-display",
});

export const metadata: Metadata = {
  title: "JARVIS",
  description: "Калории, расписание и тренировки",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#0F1218",
};

export default function MiniAppPage() {
  return (
    <div className={`${body.variable} ${display.variable}`}>
      <MiniApp />
    </div>
  );
}
