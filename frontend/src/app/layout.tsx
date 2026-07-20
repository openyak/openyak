import type { Metadata } from "next";
import { JetBrains_Mono, Noto_Sans_SC } from "next/font/google";
import { AppProviders } from "@/components/providers/app-providers";
import "./globals.css";

// UI text intentionally uses the system font stack (see globals.css @layer
// base) — Inter previously rode in via the `font-sans` utility and overrode
// it, which also broke the --font-cjk fallback for Chinese text. JetBrains
// Mono stays available as an opt-in code font via appearance settings.
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

const notoSansSC = Noto_Sans_SC({
  weight: ["400", "500", "700"],
  subsets: ["latin"],
  variable: "--font-cjk",
});

export const metadata: Metadata = {
  title: "OpenYak",
  description: "Local-first AI agent for desktop files, tools, and long-running work",
  icons: {
    icon: "/favicon.svg",
  },
  manifest: "/manifest.json",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${jetbrainsMono.variable} ${notoSansSC.variable} antialiased`}>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
