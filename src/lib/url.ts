export function withUtm(baseUrl: string, slug: string): string {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("utm_source", "jurypress");
    url.searchParams.set("utm_medium", "owned_media");
    url.searchParams.set("utm_campaign", "season_1");
    url.searchParams.set("utm_content", slug);
    return url.toString();
  } catch (e) {
    return baseUrl;
  }
}
