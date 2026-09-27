const http = require('http'), fs = require('fs'), path = require('path');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const csp = (wasm) => ["default-src 'self'", `script-src 'self'${wasm ? " 'wasm-unsafe-eval'" : ''}`, "object-src 'none'", "base-uri 'none'"].join('; ');
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname === '/' || u.pathname === '/nowasm' || u.pathname === '/nocsp' ? '/index.html' : u.pathname;
  const f = path.join(__dirname, p);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  const h = { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' };
  if (p === '/index.html' && u.pathname !== '/nocsp') { h['Content-Security-Policy'] = csp(u.pathname !== '/nowasm'); h['Permissions-Policy'] = 'microphone=(self)'; }
  res.writeHead(200, h); fs.createReadStream(f).pipe(res);
}).listen(8765, () => console.log('listening'));
