import path from "node:path";
import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

// In the Docker image the server also hands out the built web app (WEB_DIR=/app/web), so the
// whole app runs on one port. In development Vite serves the pages and this stays off.
export async function serveWebApp(app: FastifyInstance, dir: string | undefined) {
  if (!dir) return;
  const root = path.resolve(dir);
  if (!existsSync(path.join(root, "index.html"))) throw new Error(`WEB_DIR has no index.html: ${root}`);
  await app.register(fastifyStatic, {
    root,
    wildcard: false,
    cacheControl: false, // set below instead
    // Hashed files (assets/…) never change; index.html is always checked again
    setHeaders: (res, file) => res.setHeader("Cache-Control", file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache"),
  });
  // Any other page address is the app itself (it reads the rest from the # part of the address)
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.header("Cache-Control", "no-cache").sendFile("index.html");
    return reply.status(404).send({ error: "Not found" });
  });
}
