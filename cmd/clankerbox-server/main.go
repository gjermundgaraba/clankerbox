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
	"net"
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
	shutdownTimeout = 10 * time.Second
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
	c, err := control.Open(stateDir, cfg, &control.RPCTransport{})
	if err != nil {
		return err
	}
	handler, err := c.Handler(token)
	if err != nil {
		return errors.Join(err, c.Close())
	}
	ctx, cancel := signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
	defer cancel()
	tlsConfig, err := controllerTLS(cmd)
	if err != nil {
		return errors.Join(err, c.Close())
	}

	return serve(ctx, c, handler, listen, tlsConfig, cmd.String("ready-file"))
}

func controllerTLS(cmd *cli.Command) (*tls.Config, error) {
	if cmd.String("tls-client-ca") != "" || cmd.String("tls-client-peer-id") != "" {
		return rpctransport.ServerTLS(
			rpctransport.Credentials{
				CAFile:   cmd.String("tls-client-ca"),
				CertFile: cmd.String("tls-cert"),
				KeyFile:  cmd.String("tls-key"),
				PeerID:   cmd.String("tls-client-peer-id"),
			},
		)
	} else if cmd.String("tls-cert") != "" || cmd.String("tls-key") != "" {
		certData, e := statefs.ReadRegular(cmd.String("tls-cert"))
		if e != nil {
			return nil, e
		}
		keyData, e := statefs.ReadPrivate(cmd.String("tls-key"))
		if e != nil {
			return nil, e
		}
		pair, e := tls.X509KeyPair(certData, keyData)
		if e != nil {
			return nil, e
		}
		return &tls.Config{
			MinVersion:   tls.VersionTLS13,
			Certificates: []tls.Certificate{pair},
			NextProtos:   []string{"h2"},
		}, nil
	}

	return nil, nil //nolint:nilnil // A nil TLS config selects the explicitly configured plaintext listener.
}

func serve(
	parent context.Context,
	c *control.Controller,
	handler http.Handler,
	listen string,
	tlsConfig *tls.Config,
	readyFile string,
) error {
	endpoint := listen
	if !strings.Contains(endpoint, "://") {
		scheme := "http"
		if tlsConfig != nil {
			scheme = "https"
		}
		endpoint = scheme + "://" + listen
	}
	if strings.HasPrefix(endpoint, "https://") && tlsConfig == nil {
		return errors.Join(errors.New("HTTPS listener requires --tls-cert and --tls-key"), c.Close())
	}
	listener, err := rpctransport.Listen(parent, endpoint)
	if err != nil {
		return errors.Join(err, c.Close())
	}
	defer func() { _ = listener.Close() }()
	if err = writeReady(readyFile, listener.Addr().String(), tlsConfig != nil); err != nil {
		return errors.Join(err, c.Close())
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	workers := make(chan struct{})
	go func() { defer close(workers); c.Run(ctx) }()
	requests := &rpctransport.Handlers{Handler: handler}
	server := rpctransport.Server(requests, tlsConfig)
	// Request cancellation and worker cancellation share the service lifetime;
	// live attachments need not consume the entire graceful shutdown allowance.
	server.BaseContext = func(net.Listener) context.Context { return ctx }
	completed := make(chan error, 1)
	go func() {
		if tlsConfig != nil {
			completed <- server.ServeTLS(listener, "", "")
		} else {
			completed <- server.Serve(listener)
		}
	}()
	log.Printf("clankerbox API listening on %s", listen)
	select {
	case err = <-completed:
	case <-ctx.Done():
	}
	cancel()
	shutdown, done := context.WithTimeout(context.WithoutCancel(parent), shutdownTimeout)
	defer done()
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	return errors.Join(err, shutdownController(shutdown, requests, server, c, workers))
}

// shutdownController owns final release. Its caller has stopped workers and
// cancelled request contexts; timing out never releases resources under them.
func shutdownController(
	ctx context.Context,
	requests *rpctransport.Handlers,
	server *http.Server,
	c *control.Controller,
	workers <-chan struct{},
) error {
	requests.Stop()
	httpErr := server.Shutdown(ctx)
	if httpErr != nil {
		httpErr = errors.Join(httpErr, server.Close())
	}
	cleanup := make(chan error, 1)
	go func() {
		<-workers
		requests.Wait()
		cleanup <- c.Close()
	}()
	select {
	case err := <-cleanup:
		return errors.Join(httpErr, err)
	case <-ctx.Done():
		return errors.Join(httpErr, ctx.Err())
	}
}

func writeReady(file string, address string, secure bool) error {
	if file == "" {
		return nil
	}
	dir, err := statefs.Open(filepath.Dir(file))
	if err != nil {
		return err
	}
	defer func() { _ = dir.Close() }()
	scheme := "http://"
	if secure {
		scheme = "https://"
	}
	return dir.WriteFile(filepath.Base(file), []byte(scheme+address+"\n"))
}
