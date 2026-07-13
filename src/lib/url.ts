/**
 * UTM link builder for outbound brand links.
 *
 * Why fail-fast (no try/catch): an invalid URL means a broken link that
 * should surface as a build error, not a silent runtime fallback.
 */
export function withUtm(baseUrl: string, content: string): string {
  const url = new URL(baseUrl); // throws on invalid URL → fail-fast at build
  url.searchParams.set("utm_source", "jurypress");
  url.searchParams.set("utm_medium", "referral");
  url.searchParams.set("utm_campaign", "product_ecosystem");
  url.searchParams.set("utm_content", content);
  return url.toString();
}
