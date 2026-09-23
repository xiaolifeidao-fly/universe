package bootstrap

import (
	"os"

	"common/middleware/httpx"
)

func ListenAddress(envKey, fallback string) string {
	if address := os.Getenv(envKey); address != "" {
		return address
	}
	if address := httpx.Property("server.address"); address != "" {
		return address
	}
	return fallback
}
