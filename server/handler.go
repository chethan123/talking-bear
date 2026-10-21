package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// variant is one stored representation of a file: the identity bytes or a
// precompressed .br/.gz sibling.
type variant struct {
	data     []byte
	etag     string // strong, quoted; a .br/.gz suffix sits inside the quotes
	encoding string // "", "br" or "gzip" (the Content-Encoding value)
}

// entry is one servable file with everything precomputed at startup.
type entry struct {
	contentType  string
	cacheControl string
	html         bool // media type text/html: gets the HTML-only headers (Headers.htmlHeaders)
	identity     variant
	br, gz       *variant // nil when dist has no such variant
}

type handler struct {
	files map[string]*entry // keyed by URL path: "/index.html", "/assets/app-abc.js", …
	h     Headers
	html  map[string]string // h.htmlHeaders(), computed once
}

// newHandler walks fsys once and returns the static-file handler (plan §4.8.1).
// Files ending in .br or .gz are only served as variants of their base file.
// It panics if h is invalid or fsys cannot be read: both are build errors.
func newHandler(fsys fs.FS, h Headers) http.Handler {
	if err := h.validate(); err != nil {
		panic("newHandler: invalid headers: " + err.Error())
	}
	files := map[string]*entry{}
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || strings.HasSuffix(p, ".br") || strings.HasSuffix(p, ".gz") {
			return err
		}
		data, err := fs.ReadFile(fsys, p)
		if err != nil {
			return err
		}
		tag := etagBase(data)
		urlPath := "/" + p
		ct := h.mimeFor(urlPath)
		e := &entry{
			contentType:  ct,
			cacheControl: h.cacheControlFor(urlPath),
			html:         isHTML(ct),
			identity:     variant{data: data, etag: `"` + tag + `"`},
		}
		if e.br, err = readVariant(fsys, p, tag, ".br", "br"); err != nil {
			return err
		}
		if e.gz, err = readVariant(fsys, p, tag, ".gz", "gzip"); err != nil {
			return err
		}
		files[urlPath] = e
		return nil
	})
	if err != nil {
		panic("newHandler: " + err.Error())
	}
	return &handler{files: files, h: h, html: h.htmlHeaders()}
}

// etagBase is the first 16 characters of base64url(sha256(data)), unquoted.
func etagBase(data []byte) string {
	sum := sha256.Sum256(data)
	return base64.RawURLEncoding.EncodeToString(sum[:])[:16]
}

// readVariant loads p+ext if it exists. Its ETag is the identity ETag with the
// suffix inside the quotes: an unquoted suffix makes the header invalid, and
// ServeContent would then ignore If-None-Match.
func readVariant(fsys fs.FS, p, tag, ext, encoding string) (*variant, error) {
	data, err := fs.ReadFile(fsys, p+ext)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &variant{data: data, etag: `"` + tag + ext + `"`, encoding: encoding}, nil
}

func isHTML(contentType string) bool {
	mediaType, _, _ := strings.Cut(contentType, ";")
	return strings.EqualFold(strings.TrimSpace(mediaType), "text/html")
}

func (s *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	hdr := w.Header()
	for k, v := range s.h.Common {
		hdr.Set(k, v)
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		hdr.Set("Allow", "GET, HEAD")
		hdr.Set("Cache-Control", s.h.ErrorCacheControl)
		http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
		return
	}
	p := r.URL.Path
	if p == "/healthz" {
		hdr.Set("Cache-Control", s.h.ErrorCacheControl)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if p == "/" {
		p = "/index.html"
	}
	// Exact lookup: no path cleaning, no directory index, no SPA fallback.
	e, ok := s.files[p]
	if !ok {
		hdr.Set("Cache-Control", s.h.ErrorCacheControl)
		http.Error(w, http.StatusText(http.StatusNotFound), http.StatusNotFound)
		return
	}
	if e.html {
		// Set: a same-name HTML-only header replaces the common field with the
		// merged value (Headers.htmlHeaders), never a second field (issue #121).
		for k, v := range s.html {
			hdr.Set(k, v)
		}
	}
	v := &e.identity
	if e.br != nil || e.gz != nil {
		hdr.Set("Vary", "Accept-Encoding") // on every response for this file, identity included
		br, gzip := acceptedEncodings(r.Header.Values("Accept-Encoding"))
		switch {
		case e.br != nil && br:
			v = e.br
		case e.gz != nil && gzip:
			v = e.gz
		}
	}
	hdr.Set("Content-Type", e.contentType) // set, so ServeContent never sniffs
	hdr.Set("Cache-Control", e.cacheControl)
	hdr.Set("ETag", v.etag) // ServeContent evaluates If-None-Match, If-Match and If-Range against it
	fw := &fullLengthWriter{ResponseWriter: w, errorCacheControl: s.h.ErrorCacheControl}
	if v.encoding != "" {
		hdr.Set("Content-Encoding", v.encoding)
		// ServeContent omits Content-Length on a 200 when Content-Encoding is set.
		fw.length = strconv.Itoa(len(v.data))
	}
	http.ServeContent(fw, r, "", time.Time{}, bytes.NewReader(v.data))
}

// fullLengthWriter adjusts the headers of the status ServeContent picks.
//
// For an encoded variant, it sets Content-Length to the whole variant's length
// when ServeContent sends a 200 (a full response, GET or HEAD). ServeContent
// sets it itself on 206; 304, 412 and 416 must not carry the variant's length.
// (A multi-range 206 of an encoded variant is multipart/byteranges and keeps
// Content-Encoding; browsers do not send multi-range requests.)
//
// A 412 (failed If-Match) gets errorCacheControl instead of the file's policy,
// so no cache stores it for a year; serveError already strips it from a 416.
type fullLengthWriter struct {
	http.ResponseWriter
	length            string // the encoded variant's length; "" for identity
	errorCacheControl string
}

func (w *fullLengthWriter) WriteHeader(code int) {
	if code == http.StatusPreconditionFailed {
		w.Header().Set("Cache-Control", w.errorCacheControl)
	}
	if code == http.StatusOK && w.length != "" {
		w.Header().Set("Content-Length", w.length)
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *fullLengthWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// acceptedEncodings parses Accept-Encoding (RFC 9110 §12.5.3) and reports
// whether br and gzip are acceptable. A coding is acceptable when its q-value
// is above 0; an unlisted coding takes the q-value of "*" if present, else 0;
// "x-gzip" counts as "gzip"; an invalid q-value counts as 0. The first entry
// for a coding wins. The server's own preference (br, gzip, identity) decides
// among acceptable codings, not the q-values.
func acceptedEncodings(values []string) (br, gzip bool) {
	q := map[string]float64{}
	for _, value := range values {
		for _, elem := range strings.Split(value, ",") {
			name, params, _ := strings.Cut(elem, ";")
			name = strings.ToLower(strings.TrimSpace(name))
			if name == "" {
				continue
			}
			if name == "x-gzip" {
				name = "gzip"
			}
			if _, seen := q[name]; !seen {
				q[name] = qValue(params)
			}
		}
	}
	acceptable := func(coding string) bool {
		if v, ok := q[coding]; ok {
			return v > 0
		}
		return q["*"] > 0
	}
	return acceptable("br"), acceptable("gzip")
}

// qValue returns the weight in an element's parameters ("q=0.5"): 1 when
// there is none, and 0 when it is not a valid qvalue.
func qValue(params string) float64 {
	for _, param := range strings.Split(params, ";") {
		k, v, _ := strings.Cut(param, "=")
		if strings.EqualFold(strings.TrimSpace(k), "q") {
			return parseQ(strings.TrimSpace(v))
		}
	}
	return 1
}

// parseQ parses an RFC 9110 qvalue: "0" to "0.999", or "1" to "1.000"
// (at most three decimals). Anything else is 0.
func parseQ(s string) float64 {
	if len(s) == 0 || len(s) > 5 || (s[0] != '0' && s[0] != '1') {
		return 0
	}
	if len(s) > 1 {
		if s[1] != '.' {
			return 0
		}
		for _, c := range s[2:] {
			if c < '0' || c > '9' || (s[0] == '1' && c != '0') {
				return 0
			}
		}
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return f
}
