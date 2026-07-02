import type { ReactNode } from "react";

export const metadata = { title: "Itinerary Optimiser" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
