import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function resolveBasePath(): string {
  const explicitBase = process.env.VITE_BASE_PATH;
  if (explicitBase) {
    return explicitBase.endsWith("/") ? explicitBase : `${explicitBase}/`;
  }

  if (process.env.GITHUB_ACTIONS === "true") {
    const repository = process.env.GITHUB_REPOSITORY?.split("/")[1];
    if (repository && repository !== `${process.env.GITHUB_REPOSITORY_OWNER}.github.io`) {
      return `/${repository}/`;
    }
  }

  return "/";
}

export default defineConfig({
  base: resolveBasePath(),
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173
  }
});

