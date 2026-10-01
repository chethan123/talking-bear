// Command bearserve serves the embedded, prebuilt Talking Bear PWA with the
// headers from headers.json (plan §4.8.1). It writes nothing to disk.
package main

import (
	"flag"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"time"
)

// probeURL is what -probe checks; distroless has no shell or curl for a
// container health check.
const probeURL = "http://127.0.0.1:8080/healthz"

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	probe := flag.Bool("probe", false, "GET "+probeURL+" and exit 0 on 204, 1 otherwise")
	flag.Parse()
	if *probe {
		os.Exit(runProbe(probeURL))
	}
	dist, err := fs.Sub(distFS, "dist")
	if err != nil {
		log.Fatal(err)
	}
	srv := newServer(*addr, newHandler(dist, headers))
	log.Printf("bearserve: listening on %s", *addr)
	log.Fatal(srv.ListenAndServe())
}

// newServer applies the plan §4.8.1 timeouts and header limit. It also turns
// off net/http's built-in "OPTIONS *" reply (a 200 without any of the app's
// headers), so that request reaches the handler and gets its 405 as well.
func newServer(addr string, h http.Handler) *http.Server {
	return &http.Server{
		Addr:                         addr,
		Handler:                      h,
		ReadHeaderTimeout:            5 * time.Second,
		ReadTimeout:                  10 * time.Second,
		WriteTimeout:                 60 * time.Second,
		IdleTimeout:                  120 * time.Second,
		MaxHeaderBytes:               16 << 10,
		DisableGeneralOptionsHandler: true,
	}
}

// runProbe GETs url and returns the process exit code: 0 on 204, 1 otherwise.
func runProbe(url string) int {
	resp, err := probeClient().Get(url)
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	if resp.StatusCode != http.StatusNoContent {
		return 1
	}
	return 0
}

// probeClient gives up after 2 s, never uses a proxy and never follows redirects.
func probeClient() *http.Client {
	return &http.Client{
		Timeout:   2 * time.Second,
		Transport: &http.Transport{DisableKeepAlives: true}, // Proxy is nil: no proxy
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}
