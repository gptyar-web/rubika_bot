import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
const server = http.createServer(async (request, response) => {
  const reply = (code, message) => { response.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); response.end(message); };
  if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('Allow', 'GET, HEAD'); return reply(405, 'Method not allowed.'); }
  let route;
  try { route = decodeURIComponent((request.url || '/').split('?')[0]); } catch { return reply(400, 'Invalid URL.'); }
  if (!route.startsWith('/') || route.includes('\\') || route.includes('\0') || route.split('/').some(segment => segment.startsWith('.'))) return reply(403, 'Forbidden.');
  if (route === '/rubika_bot') { response.writeHead(302, { Location: '/rubika_bot/' }); return response.end(); }
  if (route.startsWith('/rubika_bot/')) route = route.slice('/rubika_bot'.length);
  if (route.endsWith('/')) route += 'index.html';
  const requestedPath = path.resolve(root, `.${route}`);
  if (!requestedPath.startsWith(`${root}${path.sep}`)) return reply(403, 'Forbidden.');
  try {
    const resolvedPath = await realpath(requestedPath);
    if (!resolvedPath.startsWith(`${root}${path.sep}`)) return reply(403, 'Forbidden.');
    const info = await stat(resolvedPath);
    if (!info.isFile()) return reply(404, 'Not found.');
    const body = request.method === 'HEAD' ? undefined : await readFile(resolvedPath);
    response.writeHead(200, { 'Content-Type': types[path.extname(resolvedPath)] || 'application/octet-stream', 'Content-Length': body?.length ?? info.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    response.end(body);
  } catch (error) { reply(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500, 'File unavailable.'); }
});
server.listen(port, '0.0.0.0', () => console.log(`Static development server ready on port ${port}; document root: ${root}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
