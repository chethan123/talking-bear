//go:build !noembed

package main

import "embed"

// distFS is the built PWA. The all: prefix is required: without it, embed
// skips files whose names start with "_" or ".", and Rolldown emits
// "_"-prefixed chunks (plan §4.8.1). dist/ exists only inside the Docker build.
//
//go:embed all:dist
var distFS embed.FS
