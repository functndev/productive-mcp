import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// The Worker config comes from cloudflare.config.ts (cf CLI). Source maps are uploaded by cf deploy.
export default defineConfig({ plugins: [cloudflare()], build: { sourcemap: true } });
