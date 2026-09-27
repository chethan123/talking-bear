import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const port = +(process.argv[2] || 8091);
const CSP = "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; font-src 'self'; style-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.webmanifest':'application/manifest+json', '.bin':'application/octet-stream', '.png':'image/png' };
http.createServer((req, res) => {
  const root = path.resolve(fs.readFileSync('root.txt', 'utf8').trim());
  let p = new URL(req.url, 'http://x').pathname; if (p === '/') p = '/index.html';
  const f = path.join(root, path.normalize(p));
  const h = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' };
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404, { ...h, 'Cache-Control': 'no-store' }); return res.end('nf'); }
  const ext = path.extname(f);
  res.writeHead(200, { ...h, 'Content-Type': mime[ext] || 'application/octet-stream', 'Cache-Control': p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
  fs.createReadStream(f).pipe(res);
}).listen(port, '127.0.0.1', () => console.log('listening', port));
