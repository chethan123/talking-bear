package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"maps"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

// Plan §4.8.3 (copied character for character into headers.json by T06).
const (
	wantCSP = "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; font-src 'self'; style-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
	wantTT  = "require-trusted-types-for 'script'; trusted-types default" // HTML only; merged into the CSP from M8 (T110)
	wantPP  = "microphone=(self), screen-wake-lock=(self), autoplay=(self), fullscreen=(self), camera=(), geolocation=(), display-capture=(), usb=(), serial=(), midi=(), payment=(), accelerometer=(), gyroscope=(), magnetometer=(), idle-detection=(), publickey-credentials-get=(), browsing-topics=()"

	// The CSP of text/html responses (issue #121): wantCSP with wantTT merged in.
	wantHTMLCSP = "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; font-src 'self'; style-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types default"

	immutable = "public, max-age=31536000, immutable"
	htmlType  = "text/html; charset=utf-8"
	jsType    = "text/javascript; charset=utf-8"
	textPlain = "text/plain; charset=utf-8" // http.Error's body type
)

// The fixture: the files the issue names, with .br/.gz variants of the app chunk.
// Stdlib has no brotli encoder; the server never decodes variants, so the .br
// stand-in only needs distinct bytes. All three app-abc.js lengths differ.
var (
	indexHTML = []byte(`<html><head><title>Juni</title><script type="module" src="/assets/app-abc.js"></script></head><body></body></html>` + "\n")
	swJS      = []byte("self.addEventListener('install', () => self.skipWaiting());\n")
	manifest  = []byte(`{"name":"Talking Bear","start_url":"/","display":"standalone"}` + "\n")
	appJS     = []byte(strings.Repeat("console.log('the bear says hello');\n", 32))
	appJSGz   = gzipped(appJS)
	appJSBr   = []byte("stand-in brotli bytes: served verbatim, never decoded\n")
	chunkJS   = []byte("export const chunk = 'x';\n")
	iconPNG   = []byte("\x89PNG\r\n\x1a\nstand-in icon bytes")
)

func testFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":           {Data: indexHTML},
		"sw.js":                {Data: swJS},
		"manifest.webmanifest": {Data: manifest},
		"assets/app-abc.js":    {Data: appJS},
		"assets/app-abc.js.br": {Data: appJSBr},
		"assets/app-abc.js.gz": {Data: appJSGz},
		"assets/_chunk-x.js":   {Data: chunkJS},
		"icons/icon-192.png":   {Data: iconPNG},
	}
}

func gzipped(b []byte) []byte {
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	_, _ = zw.Write(b)
	_ = zw.Close()
	return buf.Bytes()
}

// etagOf is the spec's ETag: "<base64url(sha256(identity bytes))[:16]><suffix>".
func etagOf(identity []byte, suffix string) string {
	sum := sha256.Sum256(identity)
	return `"` + base64.RawURLEncoding.EncodeToString(sum[:])[:16] + suffix + `"`
}

var etagRE = regexp.MustCompile(`^"[A-Za-z0-9_-]{16}(\.br|\.gz)?"$`)

var (
	indexETag = etagOf(indexHTML, "")
	idETag    = etagOf(appJS, "")
	brETag    = etagOf(appJS, ".br")
	gzETag    = etagOf(appJS, ".gz")
)

// with returns headers.json's common headers plus the given name/value pairs.
func with(kv ...string) http.Header {
	h := http.Header{}
	for k, v := range headers.Common {
		h.Set(k, v)
	}
	for i := 0; i < len(kv); i += 2 {
		h.Set(kv[i], kv[i+1])
	}
	return h
}

// withHTML applies headers.json's htmlOnly headers by the handler's rule
// (issue #121): one that common also names is merged into it as
// common + "; " + htmlOnly, any other is added. So these expectations stay
// exact as htmlOnly changes.
func withHTML(h http.Header) http.Header {
	for k, v := range headers.HTMLOnly {
		if c, ok := headers.Common[k]; ok {
			h.Set(k, c+"; "+v)
		} else {
			h.Add(k, v)
		}
	}
	return h
}

// full is the header set of a 200 that ServeContent sends in full.
func full(contentType, cacheControl, etag string, n int, kv ...string) http.Header {
	return with(append([]string{"Content-Type", contentType, "Cache-Control", cacheControl,
		"Etag", etag, "Accept-Ranges", "bytes", "Content-Length", strconv.Itoa(n)}, kv...)...)
}

var (
	appBr  = full(jsType, immutable, brETag, len(appJSBr), "Content-Encoding", "br", "Vary", "Accept-Encoding")
	appGz  = full(jsType, immutable, gzETag, len(appJSGz), "Content-Encoding", "gzip", "Vary", "Accept-Encoding")
	appID  = full(jsType, immutable, idETag, len(appJS), "Vary", "Accept-Encoding")
	index  = withHTML(full(htmlType, "no-cache", indexETag, len(indexHTML)))
	nf     = with("Cache-Control", "no-store", "Content-Type", textPlain)
	nfBody = []byte("Not Found\n")
	na     = with("Allow", "GET, HEAD", "Cache-Control", "no-store", "Content-Type", textPlain)
	naBody = []byte("Method Not Allowed\n")
	// 416 comes from ServeContent's serveError, which strips Cache-Control,
	// Content-Encoding and ETag (Go ≥ 1.23) and lets http.Error drop Content-Length.
	badRange = func(size int) http.Header {
		return with("Content-Type", textPlain, "Content-Range", "bytes */"+strconv.Itoa(size), "Vary", "Accept-Encoding")
	}
	badRangeBody = []byte("invalid range: failed to overlap\n")
)

const chrome = "gzip, deflate, br, zstd" // Chrome's Accept-Encoding

type serveCase struct {
	name   string
	method string
	path   string
	req    []string // request header name/value pairs (repeatable)
	status int
	header http.Header // the exact response header set
	body   []byte      // the exact body; nil means empty
}

var serveCases = []serveCase{
	// 200: shell, variants, Cache-Control rules, MIME types.
	{"root is index.html", "GET", "/", []string{"Accept-Encoding", chrome}, 200, index, indexHTML},
	{"index.html", "GET", "/index.html", nil, 200, index, indexHTML},
	{"HEAD root has no body", "HEAD", "/", nil, 200, index, nil},
	{"br for Chrome", "GET", "/assets/app-abc.js", []string{"Accept-Encoding", chrome}, 200, appBr, appJSBr},
	{"gzip", "GET", "/assets/app-abc.js", []string{"Accept-Encoding", "gzip"}, 200, appGz, appJSGz},
	{"identity keeps Vary", "GET", "/assets/app-abc.js", []string{"Accept-Encoding", "identity"}, 200, appID, appJS},
	{"no Accept-Encoding is identity", "GET", "/assets/app-abc.js", nil, 200, appID, appJS},
	{"br;q=0 falls back to gzip", "GET", "/assets/app-abc.js", []string{"Accept-Encoding", "br;q=0, gzip"}, 200, appGz, appJSGz},
	{"two Accept-Encoding lines", "GET", "/assets/app-abc.js", []string{"Accept-Encoding", "identity", "Accept-Encoding", "br"}, 200, appBr, appJSBr},
	{"every coding refused is identity", "GET", "/assets/app-abc.js", []string{"Accept-Encoding", "br;q=0, gzip;q=0"}, 200, appID, appJS},
	{"HEAD br keeps the variant length", "HEAD", "/assets/app-abc.js", []string{"Accept-Encoding", "br"}, 200, appBr, nil},
	{"_-prefixed chunk is served", "GET", "/assets/_chunk-x.js", []string{"Accept-Encoding", chrome}, 200,
		full(jsType, immutable, etagOf(chunkJS, ""), len(chunkJS)), chunkJS},
	{"sw.js", "GET", "/sw.js", nil, 200, full(jsType, "no-cache", etagOf(swJS, ""), len(swJS)), swJS},
	{"manifest", "GET", "/manifest.webmanifest", nil, 200,
		full("application/manifest+json", "no-cache", etagOf(manifest, ""), len(manifest)), manifest},
	{"icon via the ** rule", "GET", "/icons/icon-192.png", nil, 200,
		full("image/png", "no-cache", etagOf(iconPNG, ""), len(iconPNG)), iconPNG},

	// 304: per variant, security headers kept, representation headers dropped.
	{"304 br", "GET", "/assets/app-abc.js", []string{"Accept-Encoding", chrome, "If-None-Match", brETag}, 304,
		with("Cache-Control", immutable, "Etag", brETag, "Vary", "Accept-Encoding"), nil},
	{"304 gzip", "GET", "/assets/app-abc.js", []string{"Accept-Encoding", "gzip", "If-None-Match", gzETag}, 304,
		with("Cache-Control", immutable, "Etag", gzETag, "Vary", "Accept-Encoding"), nil},
	{"304 identity", "GET", "/assets/app-abc.js", []string{"If-None-Match", idETag}, 304,
		with("Cache-Control", immutable, "Etag", idETag, "Vary", "Accept-Encoding"), nil},
	{"304 index.html", "GET", "/", []string{"If-None-Match", indexETag}, 304,
		withHTML(with("Cache-Control", "no-cache", "Etag", indexETag)), nil},
	{"304 HEAD with a list", "HEAD", "/assets/app-abc.js", []string{"Accept-Encoding", "br", "If-None-Match", `"x", ` + brETag}, 304,
		with("Cache-Control", immutable, "Etag", brETag, "Vary", "Accept-Encoding"), nil},
	{"another variant's ETag is no match", "GET", "/assets/app-abc.js", []string{"Accept-Encoding", "br", "If-None-Match", idETag}, 200, appBr, appJSBr},

	// 206: ServeContent sets Content-Length; the range is over the chosen variant.
	{"206 identity", "GET", "/assets/app-abc.js", []string{"Accept-Encoding", "identity", "Range", "bytes=0-9"}, 206,
		with("Content-Type", jsType, "Cache-Control", immutable, "Etag", idETag, "Accept-Ranges", "bytes", "Vary", "Accept-Encoding",
			"Content-Length", "10", "Content-Range", "bytes 0-9/"+strconv.Itoa(len(appJS))), appJS[:10]},
	{"206 br", "GET", "/assets/app-abc.js", []string{"Accept-Encoding", "br", "Range", "bytes=0-9"}, 206,
		with("Content-Type", jsType, "Cache-Control", immutable, "Etag", brETag, "Accept-Ranges", "bytes", "Vary", "Accept-Encoding",
			"Content-Encoding", "br", "Content-Length", "10", "Content-Range", "bytes 0-9/"+strconv.Itoa(len(appJSBr))), appJSBr[:10]},
	{"stale If-Range is a full 200", "GET", "/assets/app-abc.js", []string{"Accept-Encoding", "br", "Range", "bytes=0-9", "If-Range", `"stale"`}, 200, appBr, appJSBr},
	{"oversized ranges are a full 200", "GET", "/assets/app-abc.js", []string{"Accept-Encoding", "br", "Range", "bytes=0-,0-"}, 200, appBr, appJSBr},

	// 416: status asserted; Cache-Control and ETag are stripped by serveError.
	{"416 identity", "GET", "/assets/app-abc.js", []string{"Accept-Encoding", "identity", "Range", "bytes=999999-"}, 416,
		badRange(len(appJS)), badRangeBody},
	{"416 br", "GET", "/assets/app-abc.js", []string{"Accept-Encoding", "br", "Range", "bytes=999999-"}, 416,
		badRange(len(appJSBr)), badRangeBody},

	// 412: no-store, and no Content-Length of the variant on a bodiless status.
	{"412 on a failed If-Match", "GET", "/assets/app-abc.js", []string{"Accept-Encoding", "br", "If-Match", `"nope"`}, 412,
		with("Content-Type", jsType, "Cache-Control", "no-store", "Etag", brETag, "Content-Encoding", "br", "Vary", "Accept-Encoding"), nil},

	// 404: no-store, no SPA fallback, no path cleaning, variants not addressable.
	{"404 unknown", "GET", "/nope", nil, 404, nf, nfBody},
	{"404 SPA route", "GET", "/talk/settings", []string{"Accept", "text/html"}, 404, nf, nfBody},
	{"404 variant file", "GET", "/assets/app-abc.js.br", nil, 404, nf, nfBody},
	{"404 trailing slash", "GET", "/index.html/", nil, 404, nf, nfBody},
	{"404 directory", "GET", "/assets/", nil, 404, nf, nfBody},
	{"404 uncleaned path", "GET", "/assets/../index.html", nil, 404, nf, nfBody},

	// 405: only GET and HEAD.
	{"405 POST", "POST", "/", nil, 405, na, naBody},
	{"405 PUT", "PUT", "/assets/app-abc.js", nil, 405, na, naBody},
	{"405 DELETE unknown", "DELETE", "/nope", nil, 405, na, naBody},
	{"405 OPTIONS", "OPTIONS", "/", nil, 405, na, naBody},
	{"405 POST healthz", "POST", "/healthz", nil, 405, na, naBody},

	// /healthz
	{"healthz", "GET", "/healthz", nil, 204, with("Cache-Control", "no-store"), nil},
	{"HEAD healthz", "HEAD", "/healthz", nil, 204, with("Cache-Control", "no-store"), nil},
}

// startServer serves h on a loopback port with newServer's configuration.
func startServer(t *testing.T, h http.Handler) *httptest.Server {
	t.Helper()
	ts := httptest.NewUnstartedServer(h)
	ts.Config = newServer("", h)
	ts.Start()
	t.Cleanup(ts.Close)
	return ts
}

func TestServe(t *testing.T) {
	h := newHandler(testFS(), headers)
	srv := startServer(t, h)
	client := &http.Client{Transport: &http.Transport{DisableCompression: true}}

	for _, c := range serveCases {
		t.Run(c.name+"/recorder", func(t *testing.T) {
			req := httptest.NewRequest(c.method, c.path, nil)
			for i := 0; i < len(c.req); i += 2 {
				req.Header.Add(c.req[i], c.req[i+1])
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			res := rec.Result()
			body, _ := io.ReadAll(res.Body)
			checkResponse(t, c, res, body, false)
		})
		t.Run(c.name+"/wire", func(t *testing.T) {
			req, err := http.NewRequest(c.method, srv.URL+c.path, nil)
			if err != nil {
				t.Fatal(err)
			}
			for i := 0; i < len(c.req); i += 2 {
				req.Header.Add(c.req[i], c.req[i+1])
			}
			res, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(res.Body)
			_ = res.Body.Close()
			if err != nil {
				t.Fatalf("reading body: %v", err) // e.g. a Content-Length longer than the body
			}
			checkResponse(t, c, res, body, true)
		})
	}
}

// checkResponse asserts the status, the exact header set and the body. On the
// wire the server may add Date, and Content-Length when it equals the body.
func checkResponse(t *testing.T, c serveCase, res *http.Response, body []byte, wire bool) {
	t.Helper()
	if res.StatusCode != c.status {
		t.Errorf("status %d, want %d", res.StatusCode, c.status)
	}
	for k, want := range c.header {
		if got := res.Header.Values(k); !slices.Equal(got, want) {
			t.Errorf("%s: %q, want %q", k, got, want)
		}
	}
	for k, got := range res.Header {
		if _, ok := c.header[k]; ok {
			continue
		}
		if wire && (k == "Date" || (k == "Content-Length" && len(got) == 1 && got[0] == strconv.Itoa(len(body)))) {
			continue
		}
		t.Errorf("unexpected header %s: %q", k, got)
	}
	wantPolicy := wantCSP
	if servesHTML(c) {
		wantPolicy = wantHTMLCSP
	}
	if got := res.Header.Values("Content-Security-Policy"); !slices.Equal(got, []string{wantPolicy}) {
		t.Errorf("Content-Security-Policy %q, want exactly [%q]", got, wantPolicy)
	}
	if etag := res.Header.Get("Etag"); etag != "" && !etagRE.MatchString(etag) {
		t.Errorf("ETag %s does not match %s", etag, etagRE)
	}
	if !bytes.Equal(body, c.body) {
		t.Errorf("body %q, want %q", body, c.body)
	}
}

// servesHTML reports whether c's response is index.html (or its 304), which
// carries the merged HTML CSP: the 405 on / is an error response.
func servesHTML(c serveCase) bool {
	return (c.path == "/" || c.path == "/index.html") && c.status != http.StatusMethodNotAllowed
}

func TestHeadersJSON(t *testing.T) {
	if got := headers.Common["Content-Security-Policy"]; got != wantCSP {
		t.Errorf("CSP %q, want %q", got, wantCSP)
	}
	if got := headers.Common["Permissions-Policy"]; got != wantPP {
		t.Errorf("Permissions-Policy %q, want %q", got, wantPP)
	}
	for k, want := range map[string]string{
		"Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Resource-Policy": "same-origin",
		"X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
	} {
		if got := headers.Common[k]; got != want {
			t.Errorf("common %s: %q, want %q", k, got, want)
		}
	}
	if want := map[string]string{"Content-Security-Policy": wantTT}; !maps.Equal(headers.HTMLOnly, want) {
		t.Errorf("htmlOnly %q, want %q", headers.HTMLOnly, want)
	}
	if wantCSP+"; "+wantTT != wantHTMLCSP {
		t.Errorf("wantCSP + \"; \" + wantTT differs from wantHTMLCSP")
	}
	if got, want := headers.htmlHeaders(), map[string]string{"Content-Security-Policy": wantHTMLCSP}; !maps.Equal(got, want) {
		t.Errorf("htmlHeaders() %q, want %q", got, want)
	}
	wantRules := []CacheRule{
		{"/assets/**", immutable}, {"/", "no-cache"}, {"/index.html", "no-cache"},
		{"/sw.js", "no-cache"}, {"/manifest.webmanifest", "no-cache"}, {"**", "no-cache"},
	}
	if !slices.Equal(headers.CacheControl, wantRules) {
		t.Errorf("cacheControl %q, want %q", headers.CacheControl, wantRules)
	}
	if headers.ErrorCacheControl != "no-store" {
		t.Errorf("errorCacheControl %q, want no-store", headers.ErrorCacheControl)
	}
	for ext, want := range map[string]string{".html": htmlType, ".js": jsType, ".wasm": "application/wasm", ".webmanifest": "application/manifest+json"} {
		if got := headers.MIME[ext]; got != want {
			t.Errorf("mime %s: %q, want %q", ext, got, want)
		}
	}
}

func TestParseHeadersRejects(t *testing.T) {
	const tail = `"errorCacheControl":"no-store","mime":{}}`
	valid := `{"common":{},"htmlOnly":{},"cacheControl":[{"match":"**","value":"no-cache"}],` + tail
	if _, err := parseHeaders([]byte(valid)); err != nil {
		t.Fatalf("minimal valid file rejected: %v", err)
	}
	for name, doc := range map[string]string{
		"unknown field":       `{"common":{},"extra":1,"cacheControl":[{"match":"**","value":"no-cache"}],` + tail,
		"unknown rule field":  `{"common":{},"cacheControl":[{"match":"**","value":"no-cache","glob":true}],` + tail,
		"no rules":            `{"common":{},"cacheControl":[],` + tail,
		"no catch-all":        `{"common":{},"cacheControl":[{"match":"/assets/**","value":"x"}],` + tail,
		"catch-all not last":  `{"common":{},"cacheControl":[{"match":"**","value":"x"},{"match":"/a","value":"y"}],` + tail,
		"relative match":      `{"common":{},"cacheControl":[{"match":"assets/**","value":"x"},{"match":"**","value":"y"}],` + tail,
		"empty rule value":    `{"common":{},"cacheControl":[{"match":"/a","value":""},{"match":"**","value":"y"}],` + tail,
		"no error value":      `{"common":{},"cacheControl":[{"match":"**","value":"x"}],"errorCacheControl":"","mime":{}}`,
		"empty header value":  `{"common":{"X-A":""},"cacheControl":[{"match":"**","value":"x"}],` + tail,
		"common name twice":   `{"common":{"X-A":"1","x-a":"2"},"cacheControl":[{"match":"**","value":"x"}],` + tail,
		"htmlOnly name twice": `{"common":{},"htmlOnly":{"X-A":"1","x-A":"2"},"cacheControl":[{"match":"**","value":"x"}],` + tail,
		"trailing data":       valid + `{}`,
		"not an object":       `[]`,
	} {
		if _, err := parseHeaders([]byte(doc)); err == nil {
			t.Errorf("%s: accepted %s", name, doc)
		}
	}
}

func TestCacheControlFor(t *testing.T) {
	for p, want := range map[string]string{
		"/assets/app-abc.js":    immutable,
		"/assets/_chunk-x.js":   immutable,
		"/assets/deep/x.css":    immutable,
		"/":                     "no-cache",
		"/index.html":           "no-cache",
		"/sw.js":                "no-cache",
		"/manifest.webmanifest": "no-cache",
		"/icons/icon-192.png":   "no-cache",
		"/assets":               "no-cache", // "/assets/**" needs the slash
		"/assetsx/a.js":         "no-cache",
	} {
		if got := headers.cacheControlFor(p); got != want {
			t.Errorf("headers.json: cacheControlFor(%q) = %q, want %q", p, got, want)
		}
	}
	custom := Headers{CacheControl: []CacheRule{
		{"/a/**", "A"}, {"/a/b", "B"}, {"/x*", "X"}, {"/y/**", "Y"}, {"**", "Z"},
	}}
	for p, want := range map[string]string{
		"/a/b":   "A", // the first matching rule wins
		"/a/":    "A",
		"/x*":    "X", // no single-star glob: exact match only
		"/xy":    "Z",
		"/y/1/2": "Y",
		"/b":     "Z",
	} {
		if got := custom.cacheControlFor(p); got != want {
			t.Errorf("custom: cacheControlFor(%q) = %q, want %q", p, got, want)
		}
	}
	if got := (Headers{CacheControl: []CacheRule{{"/a", "A"}}}).cacheControlFor("/b"); got != "" {
		t.Errorf("no matching rule: %q, want empty", got)
	}
}

func TestMimeFor(t *testing.T) {
	for p, want := range map[string]string{
		"/index.html":           htmlType,
		"/assets/app-abc.js":    jsType,
		"/assets/x.mjs":         jsType,
		"/assets/x.css":         "text/css; charset=utf-8",
		"/manifest.webmanifest": "application/manifest+json",
		"/x.wasm":               "application/wasm",
		"/assets/weights.bin":   "application/octet-stream",
		"/icons/icon-192.png":   "image/png",
		"/ICON.PNG":             "image/png",
		"/unknown.xyz":          "application/octet-stream",
		"/LICENSE":              "application/octet-stream",
		"/assets/app.js.map":    "application/octet-stream",
	} {
		if got := headers.mimeFor(p); got != want {
			t.Errorf("mimeFor(%q) = %q, want %q", p, got, want)
		}
	}
}

func TestAcceptedEncodings(t *testing.T) {
	for _, c := range []struct {
		values   []string
		br, gzip bool
	}{
		{nil, false, false},
		{[]string{""}, false, false},
		{[]string{chrome}, true, true},
		{[]string{"br"}, true, false},
		{[]string{"gzip"}, false, true},
		{[]string{"identity"}, false, false},
		{[]string{"br;q=0, gzip"}, false, true},
		{[]string{"br;q=0.0, gzip;q=0.000"}, false, false},
		{[]string{"BR ; Q=0.001"}, true, false},
		{[]string{"gzip, BR ; Q=0"}, false, true}, // the parameter name is case-insensitive, with optional whitespace
		{[]string{"identity; q=0.5, br; q=0, gzip"}, false, true},
		{[]string{"br;q=0.5 , gzip;q=0"}, true, false},
		{[]string{"gzip;q=1.0, br;q=0.1"}, true, true},
		{[]string{"*"}, true, true},
		{[]string{"*;q=0, br"}, true, false},
		{[]string{"gzip, *;q=0"}, false, true},
		{[]string{"br;q=0, *"}, false, true},
		{[]string{"x-gzip"}, false, true},
		{[]string{"identity", "br"}, true, false}, // two header lines
		{[]string{"br;q=0", "br"}, false, false},  // the first entry wins
		{[]string{"br;q=abc"}, false, false},      // invalid q-values count as 0
		{[]string{"br;q=1.5"}, false, false},
		{[]string{"br;q=0.0001"}, false, false},
		{[]string{"br;q=-1"}, false, false},
		{[]string{"br;level=1;q=0.5"}, true, false},
		{[]string{" , br ,"}, true, false},
	} {
		br, gz := acceptedEncodings(c.values)
		if br != c.br || gz != c.gzip {
			t.Errorf("acceptedEncodings(%q) = br %v gzip %v, want br %v gzip %v", c.values, br, gz, c.br, c.gzip)
		}
	}
}

func TestETag(t *testing.T) {
	// Known answers: base64url (not base64) of SHA-256, first 16 characters.
	for in, want := range map[string]string{"hello": "LPJNul-wow4m6Dsq", "": "47DEQpj8HBSa-_TI"} {
		if got := etagBase([]byte(in)); got != want {
			t.Errorf("etagBase(%q) = %q, want %q", in, got, want)
		}
	}
	for _, tag := range []string{indexETag, idETag, brETag, gzETag} {
		if !etagRE.MatchString(tag) {
			t.Errorf("%s does not match %s", tag, etagRE)
		}
	}
	if brETag != strings.TrimSuffix(idETag, `"`)+`.br"` || gzETag != strings.TrimSuffix(idETag, `"`)+`.gz"` {
		t.Errorf("variant ETags %s %s must be the identity ETag %s with the suffix inside the quotes", brETag, gzETag, idETag)
	}
}

// OPTIONS * reaches the handler only because newServer disables net/http's
// general OPTIONS handler, which would answer 200 without the app's headers.
func TestOptionsAsterisk(t *testing.T) {
	srv := startServer(t, newHandler(testFS(), headers))
	conn, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := io.WriteString(conn, "OPTIONS * HTTP/1.1\r\nHost: bear\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	res, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	checkResponse(t, serveCase{name: "OPTIONS *", status: 405, header: na, body: naBody}, res, body, true)
}

// TestHTMLHeadersMerge checks the merge rule on its own (issue #121): an
// htmlOnly header that common also names, in any letter case, is merged into
// the common value; any other is passed through.
func TestHTMLHeadersMerge(t *testing.T) {
	common := map[string]string{"Content-Security-Policy": "a", "X-C": "c"}
	for _, c := range []struct {
		name     string
		htmlOnly map[string]string
		want     map[string]string
	}{
		{"none", map[string]string{}, map[string]string{}},
		{"same name", map[string]string{"Content-Security-Policy": "b"}, map[string]string{"Content-Security-Policy": "a; b"}},
		{"same name, other case", map[string]string{"content-security-policy": "b"}, map[string]string{"Content-Security-Policy": "a; b"}},
		{"html only", map[string]string{"X-B": "b"}, map[string]string{"X-B": "b"}},
		{"report-only stays separate", map[string]string{"Content-Security-Policy-Report-Only": "b"},
			map[string]string{"Content-Security-Policy-Report-Only": "b"}},
		{"both", map[string]string{"Content-Security-Policy": "b", "x-b": "b"},
			map[string]string{"Content-Security-Policy": "a; b", "X-B": "b"}},
	} {
		if got := (Headers{Common: common, HTMLOnly: c.htmlOnly}).htmlHeaders(); !maps.Equal(got, c.want) {
			t.Errorf("%s: htmlHeaders() %q, want %q", c.name, got, c.want)
		}
	}
}

func TestHTMLOnlyHeaders(t *testing.T) {
	const tt = "require-trusted-types-for 'script'; trusted-types default"
	// A header common has not (the M7 Report-Only shape) is added; a same-name
	// one, here in lower case, is merged into the common CSP as one field
	// (issue #121).
	h := headers
	h.HTMLOnly = map[string]string{"Content-Security-Policy-Report-Only": tt, "content-security-policy": tt}
	srv := newHandler(testFS(), h)
	for _, c := range []struct {
		method, path string
		req          []string
		html         bool
	}{
		{"GET", "/", nil, true},
		{"GET", "/index.html", nil, true},
		{"HEAD", "/", nil, true},
		{"GET", "/", []string{"If-None-Match", indexETag}, true},
		{"GET", "/sw.js", nil, false},
		{"GET", "/assets/app-abc.js", []string{"Accept-Encoding", "br"}, false},
		{"GET", "/manifest.webmanifest", nil, false},
		{"GET", "/icons/icon-192.png", nil, false},
		{"GET", "/nope.html", nil, false},
		{"POST", "/", nil, false},
		{"GET", "/healthz", nil, false},
	} {
		req := httptest.NewRequest(c.method, c.path, nil)
		for i := 0; i < len(c.req); i += 2 {
			req.Header.Add(c.req[i], c.req[i+1])
		}
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		ro := rec.Result().Header.Values("Content-Security-Policy-Report-Only")
		csp := rec.Result().Header.Values("Content-Security-Policy")
		if c.html {
			if !slices.Equal(ro, []string{tt}) || !slices.Equal(csp, []string{wantCSP + "; " + tt}) {
				t.Errorf("%s %s: report-only %q, CSP %q", c.method, c.path, ro, csp)
			}
		} else if len(ro) != 0 || !slices.Equal(csp, []string{wantCSP}) {
			t.Errorf("%s %s: report-only %q, CSP %q; want no HTML-only headers", c.method, c.path, ro, csp)
		}
	}
}

// TestTrustedTypesEnforced checks headers.json's own htmlOnly entry (T110,
// plan §4.8.3, §7 M8): Trusted Types enforced on HTML responses only, as one
// CSP field that is the common policy plus the TT directives. /sw.js, the JS
// assets and a 404 keep the common CSP only (TT directives on worker scripts
// would break importScripts), and no response has a Report-Only header.
func TestTrustedTypesEnforced(t *testing.T) {
	srv := newHandler(testFS(), headers)
	for _, c := range []struct {
		method, path string
		req          []string
		status       int
		html         bool
	}{
		{"GET", "/", []string{"Accept-Encoding", chrome}, 200, true},
		{"GET", "/index.html", nil, 200, true},
		{"HEAD", "/", nil, 200, true},
		{"GET", "/", []string{"If-None-Match", indexETag}, 304, true},
		{"GET", "/sw.js", nil, 200, false},
		{"GET", "/sw.js", []string{"Accept-Encoding", chrome}, 200, false},
		{"GET", "/assets/app-abc.js", []string{"Accept-Encoding", chrome}, 200, false},
		{"GET", "/assets/app-abc.js", []string{"Accept-Encoding", "gzip"}, 200, false},
		{"GET", "/assets/app-abc.js", nil, 200, false},
		{"GET", "/assets/app-abc.js", []string{"If-None-Match", idETag}, 304, false},
		{"GET", "/assets/_chunk-x.js", nil, 200, false},
		{"GET", "/does-not-exist", nil, 404, false},
	} {
		req := httptest.NewRequest(c.method, c.path, nil)
		for i := 0; i < len(c.req); i += 2 {
			req.Header.Add(c.req[i], c.req[i+1])
		}
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		res := rec.Result()
		ro := res.Header.Values("Content-Security-Policy-Report-Only")
		csp := res.Header.Values("Content-Security-Policy")
		want := wantCSP
		if c.html {
			want = wantHTMLCSP
		}
		if res.StatusCode != c.status || len(ro) != 0 || !slices.Equal(csp, []string{want}) {
			t.Errorf("%s %s %q: %d, report-only %q, CSP %q; want %d, no report-only, CSP [%q]",
				c.method, c.path, c.req, res.StatusCode, ro, csp, c.status, want)
		}
	}
}

func TestOrphanVariantsAreNotServed(t *testing.T) {
	h := newHandler(fstest.MapFS{
		"a.js.gz": {Data: []byte("orphan gzip")},
		"b.js":    {Data: []byte("plain")},
		"b.js.br": {Data: []byte("b-br")},
	}, headers)
	for p, want := range map[string]int{"/a.js": 404, "/a.js.gz": 404, "/b.js": 200, "/b.js.br": 404} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", p, nil))
		if rec.Code != want {
			t.Errorf("GET %s: %d, want %d", p, rec.Code, want)
		}
	}
}

func TestNewHandlerPanicsOnInvalidHeaders(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("newHandler accepted headers without a catch-all cacheControl rule")
		}
	}()
	h := headers
	h.CacheControl = h.CacheControl[:len(h.CacheControl)-1]
	newHandler(testFS(), h)
}

func TestNewServer(t *testing.T) {
	mux := http.NewServeMux()
	s := newServer(":8080", mux)
	if s.Addr != ":8080" || s.Handler != mux ||
		s.ReadHeaderTimeout != 5*time.Second || s.ReadTimeout != 10*time.Second ||
		s.WriteTimeout != 60*time.Second || s.IdleTimeout != 120*time.Second ||
		s.MaxHeaderBytes != 16*1024 || !s.DisableGeneralOptionsHandler || defaultAddr != ":8080" {
		t.Errorf("newServer: %+v", s)
	}
}

func TestProbe(t *testing.T) {
	if probeURL != "http://127.0.0.1:8080/healthz" {
		t.Errorf("probeURL %q", probeURL)
	}
	c := probeClient()
	tr, ok := c.Transport.(*http.Transport)
	if c.Timeout != 2*time.Second || !ok || tr.Proxy != nil || !tr.DisableKeepAlives || c.CheckRedirect == nil {
		t.Errorf("probeClient: timeout %v, transport %T; want 2s, an *http.Transport without a proxy, no keep-alives, no redirects", c.Timeout, c.Transport)
	}
	live := httptest.NewServer(newHandler(testFS(), headers))
	defer live.Close()
	status := func(code int) string {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(code) }))
		t.Cleanup(s.Close)
		return s.URL
	}
	redirect := httptest.NewServer(http.RedirectHandler(live.URL+"/healthz", http.StatusFound))
	defer redirect.Close()
	down := httptest.NewServer(http.NotFoundHandler())
	down.Close()

	for _, c := range []struct {
		name, url string
		want      int
	}{
		{"healthz 204", live.URL + "/healthz", 0},
		{"200 is not healthy", status(200) + "/healthz", 1},
		{"500", status(500) + "/healthz", 1},
		{"404", live.URL + "/nope", 1},
		{"redirects are not followed", redirect.URL + "/healthz", 1},
		{"connection refused", down.URL + "/healthz", 1},
	} {
		if got := runProbe(c.url); got != c.want {
			t.Errorf("%s: runProbe = %d, want %d", c.name, got, c.want)
		}
	}
}

// The embed only runs in the Docker build, so pin its source here: the all:
// prefix (for Rolldown's "_" chunks) and the build tags that let tests compile
// without server/dist/.
func TestEmbedSources(t *testing.T) {
	for file, want := range map[string][]string{
		"embed.go":   {"//go:build !noembed\n", "\n//go:embed all:dist\nvar distFS embed.FS\n"},
		"noembed.go": {"//go:build noembed\n", "\nvar distFS embed.FS\n"},
	} {
		src, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(string(src), want[0]) || !strings.Contains(string(src), want[1]) {
			t.Errorf("%s must start with %q and contain %q", file, want[0], want[1])
		}
	}
}
