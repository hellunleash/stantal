import type { NextConfig } from "next";

/**
 * Static export.
 *
 * The landing page has no server behaviour: no sessions, no forms, no data
 * fetched at request time. Exporting it to plain files means it is served by
 * the same process that already serves verdicts, with no second deployment and
 * no runtime that can fail independently of it.
 */
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: false,
};

export default nextConfig;
