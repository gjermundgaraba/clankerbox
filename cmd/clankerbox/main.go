package main

import (
	"context"
	"encoding/json"
	"flag"
	"os"
	"os/signal"
	"syscall"

	"clankerbox/internal/client"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := client.Run(ctx, os.Args[1:], client.Streams{In: os.Stdin, Out: os.Stdout, Err: os.Stderr}); err != nil {
		if err == flag.ErrHelp {
			return
		}
		json.NewEncoder(os.Stderr).Encode(map[string]string{"error": err.Error()})
		os.Exit(1)
	}
}
