// Command bearserve serves the embedded, prebuilt PWA bundle. It writes nothing to disk.
package main

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"time"
)

//go:embed all:dist
var distFS embed.FS

type variant struct {
	data []byte
	etag string
}

type entry struct {
	ctype, cacheControl string
	identity            variant
	br, gz              *variant
}

var (
	files = map[string]*entry{}

	mimeTypes = map[string]string{
		".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
		".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
		".json": "application/json", ".webmanifest": "application/manifest+json",
		".wasm": "application/wasm", ".onnx": "application/octet-stream",
		".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon",
		".woff2": "font/woff2", ".wav": "audio/wav", ".riv": "application/octet-stream",
		".glb": "model/gltf-binary", ".txt": "text/plain; charset=utf-8",
	}

	// Applied to every response (including 304/404). CSP also governs workers, whose
	// policy comes from their own script response.
	securityHeaders = [][2]string{
		{"Content-Security-Policy", "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; " +
			"worker-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; font-src 'self'; " +
			"media-src 'self' blob:; manifest-src 'self'; base-uri 'none'; form-action 'none'; " +
			"frame-ancestors 'none'; object-src 'none'"},
		{"Permissions-Policy", "microphone=(self), screen-wake-lock=(self), fullscreen=(self), autoplay=(self), " +
			"camera=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), bluetooth=(), midi=(), " +
			"payment=(), accelerometer=(), gyroscope=(), magnetometer=(), idle-detection=(), browsing-topics=()"},
		{"Cross-Origin-Opener-Policy", "same-origin"},
		{"Cross-Origin-Resource-Policy", "same-origin"},
		{"X-Content-Type-Options", "nosniff"},
		{"Referrer-Policy", "no-referrer"},
	}
)

func cacheControlFor(p string) string {
	switch {
	case strings.HasPrefix(p, "/assets/"): // Vite content-hashed output
		return "public, max-age=31536000, immutable"
	default: // index.html, sw.js, workbox-*.js, registerSW.js, manifest, icons
		return "no-cache"
	}
}

func etagOf(b []byte, suffix string) string {
	s := sha256.Sum256(b)
	// Avoid "-gzip"/"-zstd" suffixes: Caddy's encode handler rewrites If-None-Match values ending in those.
	return `"` + base64.RawURLEncoding.EncodeToString(s[:12]) + suffix + `"`
}

func load() {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		log.Fatal(err)
	}
	err = fs.WalkDir(sub, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || strings.HasSuffix(p, ".br") || strings.HasSuffix(p, ".gz") {
			return err
		}
		data, _ := fs.ReadFile(sub, p)
		ct, ok := mimeTypes[path.Ext(p)]
		if !ok {
			ct = "application/octet-stream"
		}
		e := &entry{ctype: ct, cacheControl: cacheControlFor("/" + p), identity: variant{data, etagOf(data, "")}}
		if b, err := fs.ReadFile(sub, p+".br"); err == nil {
			e.br = &variant{b, etagOf(data, ".br")}
		}
		if b, err := fs.ReadFile(sub, p+".gz"); err == nil {
			e.gz = &variant{b, etagOf(data, ".gz")}
		}
		files["/"+p] = e
		return nil
	})
	if err != nil {
		log.Fatal(err)
	}
}

// accepts reports whether coding is acceptable per Accept-Encoding (q=0 means "not acceptable").
func accepts(header, coding string) bool {
	for _, part := range strings.Split(header, ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if !strings.EqualFold(strings.TrimSpace(name), coding) {
			continue
		}
		if k, v, ok := strings.Cut(strings.TrimSpace(params), "="); ok && strings.TrimSpace(k) == "q" {
			q, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
			return err == nil && q > 0
		}
		return true
	}
	return false
}

func handler(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	for _, kv := range securityHeaders {
		h.Set(kv[0], kv[1])
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		h.Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	p := path.Clean("/" + r.URL.Path)
	if p == "/" {
		p = "/index.html"
	}
	if p == "/healthz" {
		h.Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	e, ok := files[p]
	if !ok {
		h.Set("Cache-Control", "no-store")
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	v := &e.identity
	if e.br != nil || e.gz != nil {
		h.Add("Vary", "Accept-Encoding")
		ae := r.Header.Get("Accept-Encoding")
		switch {
		case e.br != nil && accepts(ae, "br"):
			v = e.br
			h.Set("Content-Encoding", "br")
		case e.gz != nil && accepts(ae, "gzip"):
			v = e.gz
			h.Set("Content-Encoding", "gzip")
		}
	}
	h.Set("Content-Type", e.ctype) // set explicitly so ServeContent never sniffs
	h.Set("Cache-Control", e.cacheControl)
	h.Set("ETag", v.etag) // ServeContent evaluates If-None-Match / If-Range against this
	if h.Get("Content-Encoding") != "" {
		// ServeContent omits Content-Length when Content-Encoding is set (non-range); restore it.
		h.Set("Content-Length", strconv.Itoa(len(v.data)))
	}
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(v.data))
}

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	probe := flag.Bool("probe", false, "GET /healthz on 127.0.0.1:8080 and exit 0/1 (for HEALTHCHECK)")
	flag.Parse()
	if *probe {
		c := http.Client{Timeout: 2 * time.Second}
		resp, err := c.Get("http://127.0.0.1:8080/healthz")
		if err != nil || resp.StatusCode != http.StatusNoContent {
			os.Exit(1)
		}
		os.Exit(0)
	}
	load()
	srv := &http.Server{
		Addr: *addr, Handler: http.HandlerFunc(handler),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
		WriteTimeout: 60 * time.Second, IdleTimeout: 120 * time.Second, MaxHeaderBytes: 16 << 10,
	}
	log.Printf("serving %d files on %s", len(files), *addr)
	log.Fatal(srv.ListenAndServe())
}
