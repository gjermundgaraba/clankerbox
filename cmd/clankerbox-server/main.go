// Command clankerbox-server serves the authenticated API and durable work queue.
package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"clankerbox/internal/control"
	"clankerbox/internal/model"
	"clankerbox/internal/rpctransport"
	"clankerbox/internal/statefs"

	"github.com/urfave/cli/v3"
)

const (
	headerTimeout   = 10 * time.Second
	requestTimeout  = 30 * time.Second
	idleTimeout     = time.Minute
	shutdownTimeout = 10 * time.Second
	maxHeaderBytes  = 16 << 10
)

func main() {
	if err := newCommand().Run(context.Background(), os.Args); err != nil {
		log.New(os.Stderr, "", 0).Print(err)
		os.Exit(1)
	}
}
func newCommand() *cli.Command {
	return &cli.Command{
		Name:      "clankerbox-server",
		Usage:     "Serve the authenticated API and durable work queue",
		UsageText: "clankerbox-server [options]",
		Flags: []cli.Flag{
			&cli.StringFlag{Name: "config", Usage: "JSON hosts/profiles configuration `FILE`", Required: true},
			&cli.StringFlag{Name: "state-dir", Usage: "Private controller state `DIRECTORY`", Required: true},
			&cli.StringFlag{Name: "token-file", Usage: "Bearer token `FILE` (at least 32 bytes)", Required: true},
			&cli.StringFlag{
				Name:  "listen",
				Usage: "HTTP/2 listen ADDRESS (remote addresses require TLS)",
				Value: "127.0.0.1:8080",
			},
			&cli.StringFlag{Name: "ready-file", Usage: "Private file receiving the bound controller URL"},
			&cli.StringFlag{Name: "tls-cert", Usage: "Public HTTPS certificate file"},
			&cli.StringFlag{Name: "tls-key", Usage: "Public HTTPS private key file"},
			&cli.StringFlag{Name: "tls-client-ca", Usage: "Optional private ingress client CA file"},
			&cli.StringFlag{Name: "tls-client-peer-id", Usage: "Exact authorized ingress client certificate URI"},
		},
		Before: func(_ context.Context, cmd *cli.Command) (context.Context, error) {
			if cmd.Args().Present() {
				return nil, fmt.Errorf("unexpected argument %q", cmd.Args().First())
			}
			return nil, nil
		},
		OnUsageError: func(_ context.Context, _ *cli.Command, err error, _ bool) error { return err },
		Action:       run,
	}
}

func run(parent context.Context, cmd *cli.Command) error {
	config := cmd.String("config")
	stateDir := cmd.String("state-dir")
	tokenFile := cmd.String("token-file")
	listen := cmd.String("listen")
	data, err := statefs.ReadRegular(config)
	if err != nil {
		return err
	}
	var cfg model.Config
	if err = json.Unmarshal(data, &cfg); err != nil {
		return err
	}
	token, err := statefs.ReadPrivate(tokenFile)
	if err != nil {
		return err
	}
	token = bytes.TrimRight(token, "\r\n")
	c, err := control.Open(stateDir, cfg, control.RPCTransport{})
	if err != nil {
		return err
	}
	handler, err := c.Handler(token)
	if err != nil {
		return errors.Join(err, c.Close())
	}
	ctx, cancel := signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
	defer cancel()
	var tlsConfig *tls.Config
	if cmd.String("tls-cert") != "" || cmd.String("tls-key") != "" {
		certData, e := statefs.ReadRegular(cmd.String("tls-cert"))
		if e != nil {
			return errors.Join(e, c.Close())
		}
		keyData, e := statefs.ReadPrivate(cmd.String("tls-key"))
		if e != nil {
			return errors.Join(e, c.Close())
		}
		pair, e := tls.X509KeyPair(certData, keyData)
		if e != nil {
			return errors.Join(e, c.Close())
		}
		tlsConfig = &tls.Config{
			MinVersion:   tls.VersionTLS13,
			Certificates: []tls.Certificate{pair},
			NextProtos:   []string{"h2"},
		}
	}
	if cmd.String("tls-client-ca") != "" || cmd.String("tls-client-peer-id") != "" {
		tlsConfig, err = rpctransport.ServerTLS(
			rpctransport.Credentials{
				CAFile:   cmd.String("tls-client-ca"),
				CertFile: cmd.String("tls-cert"),
				KeyFile:  cmd.String("tls-key"),
				PeerID:   cmd.String("tls-client-peer-id"),
			},
		)
		if err != nil {
			return errors.Join(err, c.Close())
		}
	}
	err = serve(ctx, c, handler, listen, tlsConfig, cmd.String("ready-file"))
	return errors.Join(err, c.Close())
}

func serve(
	parent context.Context,
	c *control.Controller,
	handler http.Handler,
	listen string,
	tlsConfig *tls.Config,
	readyFiles ...string,
) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	workers := make(chan struct{})
	go func() { defer close(workers); c.Run(ctx) }()
	endpoint := listen
	if !strings.Contains(endpoint, "://") {
		scheme := "http"
		if tlsConfig != nil {
			scheme = "https"
		}
		endpoint = scheme + "://" + listen
	}
	listener, err := rpctransport.Listen(ctx, endpoint)
	if err != nil {
		cancel()
		<-workers
		return err
	}
	defer func() { _ = listener.Close() }()
	if strings.HasPrefix(endpoint, "https://") && tlsConfig == nil {
		cancel()
		<-workers
		return errors.New("HTTPS listener requires --tls-cert and --tls-key")
	}
	if err = writeReady(readyFiles, listener.Addr().String(), tlsConfig != nil); err != nil {
		cancel()
		<-workers
		return err
	}

	server := rpctransport.Server(handler, tlsConfig)
	stopped := make(chan error, 1)
	go func() {
		<-ctx.Done()
		shutdown, done := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
		defer done()
		shutdownErr := server.Shutdown(shutdown)
		if shutdownErr != nil {
			shutdownErr = errors.Join(shutdownErr, server.Close())
		}
		stopped <- shutdownErr
	}()
	log.Printf("clankerbox API listening on %s", listen)
	if tlsConfig != nil {
		err = server.ServeTLS(listener, "", "")
	} else {
		err = server.Serve(listener)
	}
	cancel()
	<-workers
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	return errors.Join(err, <-stopped)
}

func writeReady(files []string, address string, secure bool) error {
	if len(files) == 0 || files[0] == "" {
		return nil
	}
	dir, err := statefs.Open(filepath.Dir(files[0]))
	if err != nil {
		return err
	}
	defer func() { _ = dir.Close() }()
	scheme := "http://"
	if secure {
		scheme = "https://"
	}
	return dir.WriteFile(filepath.Base(files[0]), []byte(scheme+address+"\n"))
}
