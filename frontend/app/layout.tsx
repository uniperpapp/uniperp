import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { Toaster } from "@/components/Toaster";

export const metadata: Metadata = {
  title: "Perp Dex Powered by Hooks",
  description: "Launch a token and trade it with leverage — every launch is a live Uniswap v4 market with a built-in perp engine.",
  icons: {
    icon: "/logo.png",
    apple: "/logo.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          {children}
          <Toaster />
        </Providers>
      </body>
    </html>
  );
}
