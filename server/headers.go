package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
)

// headersJSON is server/headers.json: the single source of the app's response
// headers, shared with vite preview (vite.config.ts). See plan §4.8.3.
//
//go:embed headers.json
var headersJSON []byte

// headers is headers.json, parsed and validated at package initialisation.
var headers = mustParseHeaders(headersJSON)

// Headers mirrors the shape of headers.json. The JSON field names are mapped
// explicitly; unknown fields are rejected by parseHeaders.
type Headers struct {
	// Common is sent on every response.
	Common map[string]string `json:"common"`
	// HTMLOnly is sent in addition to Common on text/html responses.
	HTMLOnly map[string]string `json:"htmlOnly"`
	// CacheControl is an ordered rule list; the first matching rule wins.
	CacheControl []CacheRule `json:"cacheControl"`
	// ErrorCacheControl is the Cache-Control of 404, 405 and /healthz.
	ErrorCacheControl string `json:"errorCacheControl"`
	// MIME maps a lower-case file extension (with its dot) to a Content-Type.
	MIME map[string]string `json:"mime"`
}

// CacheRule is one cacheControl entry: "**" matches every path, a pattern
// ending in "/**" matches every path under that prefix, and any other pattern
// matches exactly one path.
type CacheRule struct {
	Match string `json:"match"`
	Value string `json:"value"`
}

func mustParseHeaders(b []byte) Headers {
	h, err := parseHeaders(b)
	if err != nil {
		panic("server/headers.json: " + err.Error())
	}
	return h
}

// parseHeaders decodes headers.json strictly (unknown fields and trailing data
// are errors) and validates it.
func parseHeaders(b []byte) (Headers, error) {
	var h Headers
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&h); err != nil {
		return Headers{}, err
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Headers{}, errors.New("unexpected data after the top-level object")
	}
	if err := h.validate(); err != nil {
		return Headers{}, err
	}
	return h, nil
}

// validate checks the invariants the handler relies on: every path gets a
// Cache-Control (the last rule is the "**" catch-all) and no value is empty.
func (h Headers) validate() error {
	n := len(h.CacheControl)
	if n == 0 || h.CacheControl[n-1].Match != "**" {
		return errors.New(`cacheControl must end with the "**" catch-all rule`)
	}
	for i, r := range h.CacheControl {
		if r.Value == "" || (r.Match != "**" && !strings.HasPrefix(r.Match, "/")) {
			return fmt.Errorf("cacheControl[%d]: match must be \"**\" or start with \"/\", and value must be non-empty", i)
		}
	}
	if h.ErrorCacheControl == "" {
		return errors.New("errorCacheControl must be non-empty")
	}
	for name, m := range map[string]map[string]string{"common": h.Common, "htmlOnly": h.HTMLOnly, "mime": h.MIME} {
		for k, v := range m {
			if k == "" || v == "" {
				return fmt.Errorf("%s: empty name or value (%q: %q)", name, k, v)
			}
		}
	}
	return nil
}

// cacheControlFor returns the value of the first cacheControl rule that
// matches the URL path p ("/index.html", "/assets/app-abc.js", …).
func (h Headers) cacheControlFor(p string) string {
	for _, r := range h.CacheControl {
		switch {
		case r.Match == "**":
			return r.Value
		case strings.HasSuffix(r.Match, "/**"):
			if strings.HasPrefix(p, strings.TrimSuffix(r.Match, "**")) {
				return r.Value
			}
		case r.Match == p:
			return r.Value
		}
	}
	return ""
}

// mimeFor returns the Content-Type for p from the extension map, or
// application/octet-stream. Content is never sniffed.
func (h Headers) mimeFor(p string) string {
	if ct, ok := h.MIME[strings.ToLower(path.Ext(p))]; ok {
		return ct
	}
	return "application/octet-stream"
}
