import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import partytown from "@astrojs/partytown";

const dataMode = process.env.JURYPRESS_DATA_MODE || 'production';
const siteUrl = process.env.JURYPRESS_SITE_URL;

if (dataMode === 'production' && !siteUrl) {
  throw new Error('JURYPRESS_SITE_URL is required in production.');
}

const site = siteUrl ?? 'http://localhost:4321';
const base = process.env.BASE_PATH ?? '/';

// Validation
if (!site.startsWith("https://") && !site.includes("localhost") && !site.includes("127.0.0.1")) {
  throw new Error(`SITE_URL must start with https:// or be localhost: ${site}`);
}

export default defineConfig({
  site,
  base,
  integrations: [
    sitemap(),
    partytown({
      config: {
        forward: ["dataLayer.push"],
      },
    }),
  ],
});
