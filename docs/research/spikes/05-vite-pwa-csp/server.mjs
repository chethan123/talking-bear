import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve(process.argv[2] || 'dist'); const port = +(process.argv[3] || 8089); const ttMode = process.argv[4] || 'report';
const CSP = "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; font-src 'self'; style-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
const TT = "require-trusted-types-for 'script'; trusted-types default";
const PP = "microphone=(self), screen-wake-lock=(self), autoplay=(self), fullscreen=(self), camera=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), bluetooth=(), midi=(), payment=(), accelerometer=(), gyroscope=(), magnetometer=(), idle-detection=(), publickey-credentials-get=(), browsing-topics=()";
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.webmanifest':'application/manifest+json', '.bin':'application/octet-stream', '.png':'image/png', '.json':'application/json' };
http.createServer((req, res) => {
  let p = new URL(req.url, 'http://x').pathname; if (p === '/') p = '/index.html';
  const f = path.join(root, path.normalize(p));
  const h = { 'Content-Security-Policy': CSP, 'Permissions-Policy': PP, 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404, { ...h, 'Cache-Control': 'no-store' }); return res.end('nf'); }
  const ext = path.extname(f);
  if (ext === '.html') { if (ttMode === 'report') h['Content-Security-Policy-Report-Only'] = TT; else if (ttMode === 'enforce') h['Content-Security-Policy'] = CSP + '; ' + TT; }
  res.writeHead(200, { ...h, 'Content-Type': mime[ext] || 'application/octet-stream', 'Cache-Control': p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
  fs.createReadStream(f).pipe(res);
}).listen(port, '127.0.0.1', () => console.log('listening', port, root, ttMode));
