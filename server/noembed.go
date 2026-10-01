//go:build noembed

package main

import "embed"

// distFS is empty in noembed builds (go vet and go test -tags noembed), which
// compile without server/dist/. Tests serve an fstest.MapFS instead; a
// noembed binary has nothing to serve and fails at startup.
var distFS embed.FS
