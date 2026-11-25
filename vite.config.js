import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";

/**
 * Dev server only: the benchmark (open the game with ?bench) posts its
 * results here, and they are saved to bench-results/ so they can be read
 * outside the browser. Nothing of this is in the build.
 */
function benchResults() {
  return {
    name: "ocean-bench-results",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__bench", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) req.destroy();
          else chunks.push(chunk);
        });
        req.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            JSON.parse(body);
            const dir = path.resolve(server.config.root, "bench-results");
            fs.mkdirSync(dir, { recursive: true });
            const name = new Date().toISOString().replace(/[:.]/g, "-") + ".json";
            fs.writeFileSync(path.join(dir, name), body);
            fs.writeFileSync(path.join(dir, "latest.json"), body);
            server.config.logger.info(`benchmark saved to bench-results/${name}`, { timestamp: true });
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ saved: name }));
          } catch (error) {
            res.statusCode = 400;
            res.end(String(error));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [benchResults()],
  server: {
    // Saving a result must not reload the page that is benchmarking.
    watch: { ignored: ["**/bench-results/**"] },
    // `npm run phone` serves on the local network so a phone can open the
    // game; this also lets it use the Mac's name (e.g. my-mac.local:5173).
    allowedHosts: [".local"],
  },
});
