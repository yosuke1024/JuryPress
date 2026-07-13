/**
 * Brand configuration — single source of truth for external brand URLs.
 *
 * Why: JuryPress links to two external brands (Judgie-AI and PixApps).
 * URL validation is centralised here to fail-fast at build time rather
 * than silently rendering broken links.
 *
 * Public URLs with safe, checked-in fallbacks — these are NOT secrets.
 */

function parsePublicUrl(value: string | undefined, fallback: string): string {
  const candidate = value?.trim() || fallback;

  // Reject obviously invalid placeholder values
  if (candidate === "undefined" || candidate === "null") {
    throw new Error(`Public brand URL must not be "${candidate}"`);
  }

  const url = new URL(candidate); // throws on malformed URL (fail-fast)

  if (url.protocol !== "https:") {
    throw new Error(`Public brand URL must use HTTPS: ${candidate}`);
  }

  if (url.hostname === "example.com" || url.hostname.endsWith(".example.com")) {
    throw new Error(`Public brand URL must not use example.com: ${candidate}`);
  }

  return url.toString();
}

export const brands = {
  judgie: {
    name: "Judgie-AI",
    url: parsePublicUrl(
      import.meta.env.PUBLIC_JUDGIE_URL,
      "https://github.com/yosuke1024/Judgie-AI"
    ),
  },
  pixapps: {
    name: "PixApps",
    url: parsePublicUrl(
      import.meta.env.PUBLIC_PIXAPPS_URL,
      "https://pixapps.ai/"
    ),
  },
} as const;

/**
 * Re-export parsePublicUrl for unit testing only.
 * @internal
 */
export { parsePublicUrl as _parsePublicUrl };
