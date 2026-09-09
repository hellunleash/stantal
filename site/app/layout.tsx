import { readFileSync } from "node:fs";
import { join } from "node:path";
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

const TITLE = "Stantal — self-maintaining APIs for AI agents";
const DESCRIPTION =
  "When the caller is a model, the docs are the contract. Stantal finds the change that moved what a model reads, in a package or an HTTP API, proves it with a test, and puts the deleted sentence back. No account, no API key.";

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

/**
 * The version the badge shows, read from the CLI's own manifest at build time.
 *
 * It used to be a literal, and it said `0.5.0` while npm was serving `0.7.0`.
 * A published artifact advertising a version it is not is the exact defect this
 * project exists to catch, so it is read rather than typed. Deliberately
 * unguarded: a build that stops because the file moved is better than a site
 * that quietly goes back to lying.
 */
const CLI_VERSION: string = JSON.parse(
  readFileSync(join(process.cwd(), "..", "package.json"), "utf8"),
).version;

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
        <Nav version={CLI_VERSION} />
        {children}
      </body>
    </html>
  );
}
