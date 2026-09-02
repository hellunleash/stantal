import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Nav } from "@/components/nav";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const TITLE = "Stantal — self-maintaining dependencies for AI agents";
const DESCRIPTION =
  "When the caller is a model, the docs are the contract. Stantal finds the release that changed what a model reads, proves it with a test, and puts the deleted sentence back. No account, no API key.";

/**
 * Where this site is served from.
 *
 * Only used to turn the relative URLs in link previews into absolute ones, so
 * getting it wrong breaks nothing that a person clicking around would see. It
 * is an env var rather than a literal because the domain is a deployment
 * decision, and a deployment decision that lives in a source file means moving
 * host is a code change, a review and a release.
 *
 * Read at build time. This site is a static export, so there is no request-time
 * anything to read it later.
 */
const SITE_URL = process.env.STANTAL_SITE_URL ?? "https://stantal.cloud";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  metadataBase: new URL(SITE_URL),
  alternates: { canonical: "/" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    siteName: "Stantal",
    // Relative on purpose. `metadataBase` makes it absolute, which is the one
    // thing that variable is for.
    url: "/",
  },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* Every interactive element sits below the nav, so a keyboard user
            would otherwise tab through it on the way to the page. */}
        <a
          href="#top"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-zinc-900 focus:px-4 focus:py-2 focus:text-sm focus:text-white"
        >
          Skip to content
        </a>
        <Nav />
        {children}
      </body>
    </html>
  );
}
