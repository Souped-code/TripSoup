import type { ReactNode } from "react";
import { Gochi_Hand, Nunito_Sans } from "next/font/google";
import "./globals.css";

// D1.4 (comment refreshed at D2.3 T9): journal design system type pair
// (design.md §4). These publish CSS custom properties (--font-display /
// --font-body) via next/font's `variable` option; globals.css's `body {
// font-family: system-ui, ... }` rule remains only as the load-time fallback.
// The journal surfaces — the greeting `/`, the reveal `/trip/[id]`, and
// src/ui/journal|reveal/* — reference the variables explicitly; the legacy
// board (/debug/trip/[id]) and /share still render on the body fallback
// until their own design pass.
const gochiHand = Gochi_Hand({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const nunitoSans = Nunito_Sans({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

export const metadata = { title: "Itinerary Optimiser" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${gochiHand.variable} ${nunitoSans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
