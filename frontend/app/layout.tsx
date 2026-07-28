import type { Metadata } from "next";
import { Space_Grotesk, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { SITE } from "@/lib/site";
import { ApolloClientProvider } from "@/app/apollo-provider";

const fontHeading = Space_Grotesk({ variable: "--font-heading", subsets: ["latin"], display: "swap" });
const fontSans = Inter({ variable: "--font-sans", subsets: ["latin"], display: "swap" });
const fontMono = JetBrains_Mono({ variable: "--font-mono", subsets: ["latin"], display: "swap" });

const HOME_TITLE = `${SITE.name} — ${SITE.tagline}`;

export const metadata: Metadata = {
  // Required: without it Next emits relative og:image/og:url, which every
  // social crawler rejects.
  metadataBase: new URL(SITE.url),
  title: { default: HOME_TITLE, template: `%s · ${SITE.name}` },
  description: SITE.description,
  applicationName: SITE.name,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: SITE.name,
    locale: "en_US",
    url: "/",
    title: HOME_TITLE,
    description: SITE.description,
  },
  twitter: {
    card: "summary_large_image",
    title: HOME_TITLE,
    description: SITE.description,
  },
  robots: { index: true, follow: true },
};
// og:image / twitter:image are injected automatically from app/opengraph-image.tsx
// and app/twitter-image.tsx; icons likewise from app/icon.svg, favicon.ico and
// apple-icon.png. Declaring them here would override the hashed, cache-busted URLs.

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${fontHeading.variable} ${fontSans.variable} ${fontMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans">
        <ApolloClientProvider>
          <AuthProvider>{children}</AuthProvider>
        </ApolloClientProvider>
      </body>
    </html>
  );
}
