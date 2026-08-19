import { sites } from "@openai/sites-vite-plugin";
import { defineConfig } from "vite";

export default defineConfig(async () => {
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    plugins: [
      sites(),
      cloudflare({
        config: {
          name: "server",
          main: "./worker/index.js",
          compatibility_date: "2026-05-22",
          assets: {
            binding: "ASSETS",
            directory: "./public",
            run_worker_first: true,
          },
        },
      }),
    ],
  };
});
