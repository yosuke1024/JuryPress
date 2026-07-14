import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import partytown from "@astrojs/partytown";

const target = process.env.DEPLOY_TARGET ?? "local";

const targets = {
  local: {
    site: "http://localhost:4321",
    base: "/",
  },
  "github-pages": {
    site: "https://yosuke1024.github.io",
    base: "/JuryPress",
  },
  cloudflare: {
    site: "https://pixapps.ai",
    base: "/jurypress",
  },
};

if (!(target in targets)) {
  throw new Error(`Unknown DEPLOY_TARGET: ${target}`);
}

const resolved = targets[target];

const site = process.env.SITE_URL ?? resolved.site;
const base = process.env.BASE_PATH ?? resolved.base;

// Validation
if (!site.startsWith("https://") && !site.includes("localhost") && !site.includes("127.0.0.1")) {
  throw new Error(`SITE_URL must start with https:// or be localhost: ${site}`);
}

if (target === "cloudflare") {
  if (site !== "https://pixapps.ai") {
    throw new Error(`Production (cloudflare) SITE_URL must be https://pixapps.ai, got ${site}`);
  }
  if (base !== "/jurypress") {
    throw new Error(`Production (cloudflare) BASE_PATH must be /jurypress, got ${base}`);
  }
}

if (base !== "/" && base.endsWith("/")) {
  throw new Error(`BASE_PATH must not have a trailing slash: ${base}`);
}

if (/[A-Z]/.test(base)) {
  throw new Error(`BASE_PATH must not contain uppercase letters: ${base}`);
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
