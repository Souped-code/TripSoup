import type { ReactNode } from "react";
import { Gochi_Hand, Nunito_Sans } from "next/font/google";
import "./globals.css";

// D1.4: journal design system type pair (design.md §4), loaded additively.
// These only publish CSS custom properties (--font-display / --font-body) via
// next/font's `variable` option — they do NOT touch globals.css's existing
// `body { font-family: system-ui, ... }` rule, so the current production UI
// (/, /trip/[id], /share/[id]) keeps rendering with its existing font stack
// pixel-identical to before. Only new src/ui/journal/* components reference
// var(--font-display) / var(--font-body) explicitly.
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
