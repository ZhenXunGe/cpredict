// Loopback-only browser acceptance harness for the public site build.
// Production Nginx routing, HTTPS and authentication require their separate gate.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const site = resolve("dist/user-site");
await readFile(resolve(site, "index.html"));
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};
const server = createServer(async (request, response) => {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    const path = decodeURIComponent(
      new URL(request.url, "http://127.0.0.1").pathname,
    );
    if (path.startsWith("/demo/assets/")) {
      response.writeHead(404).end();
      return;
    }
    if (path === "/demo" || path.startsWith("/demo/")) {
      response.writeHead(308, { location: "/", "cache-control": "no-store" }).end();
      return;
    }
    const root = site;
    const relative = path.slice(1);
    const file = resolve(root, relative || "index.html");
    if (
      !file.startsWith(`${root}${sep}`) ||
      path.includes("\\") ||
      path.includes("\0")
    ) {
      response.writeHead(404).end();
      return;
    }
    let bytes,
      type = types[extname(file)];
    try {
      bytes = await readFile(file);
    } catch {
      if (extname(file)) {
        response.writeHead(404).end();
        return;
      }
      bytes = await readFile(resolve(root, "index.html"));
      type = types[".html"];
    }
    response.writeHead(200, {
      "content-type": type || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch {
    response.writeHead(404).end();
  }
});
server.listen(4207, "127.0.0.1", () => process.send?.({ type: "ready" }));
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
