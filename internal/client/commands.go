package client

import (
	"context"
	"fmt"
	"time"

	"github.com/urfave/cli/v3"
)

// Run executes the CLI with isolated command state and caller-owned streams.
func Run(ctx context.Context, args []string, streams Streams) error {
	command := newCommand(streams)
	return command.Run(ctx, append([]string{"clankerbox"}, args...))
}

type commandAction func(context.Context, commandRunner, *cli.Command) error

func newCommand(streams Streams) *cli.Command {
	root := &cli.Command{
		Name: "clankerbox", Usage: "Create and control machines",
		Description: "Lifecycle changes wait for completion by default. Connections require a running machine.",
		Reader:      streams.In, Writer: streams.Out, ErrWriter: streams.Err,
		Flags: []cli.Flag{
			&cli.StringFlag{
				Name:      "config",
				Value:     DefaultConfigPath(),
				Usage:     "Load client configuration from FILE",
				TakesFile: true,
			},
			&cli.BoolFlag{Name: "json", Usage: "Print resources and operations as JSON"},
		},
		ExitErrHandler: func(context.Context, *cli.Command, error) {},
		OnUsageError:   returnUsageError,
	}
	commandStreams(streams).addAuthCommands(root)
	commandStreams(streams).addResourceCommands(root)
	commandStreams(streams).addLifecycleCommands(root)
	commandStreams(streams).addSSHCommands(root)
	commandStreams(streams).addConnectionCommands(root)
	return root
}

func keyFlag() cli.Flag {
	return &cli.StringFlag{Name: "key", Usage: "Read SSH public key from FILE (default: config)", TakesFile: true}
}
func configValue(c *cli.Command, name, fallback string) string {
	if c.IsSet(name) {
		return c.String(name)
	}
	return fallback
}
func lifecycleFlags() []cli.Flag {
	return []cli.Flag{
		&cli.BoolFlag{Name: "async", Usage: "Return the accepted operation without waiting"},
		&cli.DurationFlag{
			Name:  "timeout",
			Value: defaultWaitTimeout,
			Usage: "Maximum time to wait",
			Validator: func(d time.Duration) error {
				if d <= 0 {
					return fmt.Errorf("--timeout must be positive")
				}
				return nil
			},
		},
		&cli.StringFlag{Name: "idempotency-key", Usage: "Use KEY to retry an operation"},
	}
}
func waitFlags(c *cli.Command) *waitOptions {
	return &waitOptions{async: c.Bool("async"), timeout: c.Duration("timeout")}
}

type commandStreams Streams

func (streams commandStreams) command(name, usage, argsUsage string, count int, action commandAction) *cli.Command {
	return &cli.Command{Name: name, Usage: usage, ArgsUsage: argsUsage,
		OnUsageError: returnUsageError,
		Action: func(ctx context.Context, cmd *cli.Command) error {
			if count >= 0 && cmd.NArg() != count {
				return fmt.Errorf(
					"%s requires %d arguments; usage: %s %s",
					cmd.FullName(),
					count,
					cmd.FullName(),
					cmd.ArgsUsage,
				)
			}
			config, err := LoadConfig(cmd.String("config"))
			if err != nil {
				return err
			}
			api, err := NewAPI(config)
			if err != nil {
				return err
			}
			return action(ctx, commandRunner{api: api, streams: Streams(streams), structured: cmd.Bool("json")}, cmd)
		},
	}
}

const restoreCommand = "restore"
const childArgCount = 2

// rawCommandHelp handles local help without parsing the remote argument tail.
func rawCommandHelp(action cli.ActionFunc) cli.ActionFunc {
	return func(ctx context.Context, c *cli.Command) error {
		if c.NArg() == 1 && (c.Args().First() == "--help" || c.Args().First() == "-h") {
			return cli.ShowCommandHelp(ctx, c.Root(), c.Name)
		}
		return action(ctx, c)
	}
}

func (streams commandStreams) checkpoints() *cli.Command {
	command := streams.command
	checkpoint := &cli.Command{Name: "checkpoint", Usage: "Manage machine checkpoints", OnUsageError: returnUsageError}
	for _, name := range []string{"create", "delete"} {
		c := command(
			name,
			name+" a checkpoint",
			"ID",
			1,
			func(ctx context.Context, r commandRunner, c *cli.Command) error {
				return r.deriveMachine(
					ctx,
					"checkpoint",
					c.Name,
					c.Args().First(),
					"",
					"",
					c.String("idempotency-key"),
					waitFlags(c),
				)
			},
		)
		if name == "create" {
			c.ArgsUsage = "MACHINE"
		}
		c.Flags = lifecycleFlags()
		checkpoint.Commands = append(checkpoint.Commands, c)
	}
	for _, name := range []string{"list", "inspect"} {
		count, usage := 0, " "
		if name == "inspect" {
			count, usage = 1, "ID"
		}
		checkpoint.Commands = append(
			checkpoint.Commands,
			command(
				name,
				name+" checkpoints",
				usage,
				count,
				func(ctx context.Context, r commandRunner, c *cli.Command) error {
					return r.queryCheckpoint(ctx, c.Name, c.Args().Slice())
				},
			),
		)
	}
	return checkpoint
}

func (streams commandStreams) addResourceCommands(root *cli.Command) {
	command := streams.command
	for _, name := range []string{"profiles", "hosts", "machines"} {
		root.Commands = append(
			root.Commands,
			command(name, "List "+name, " ", 0, func(ctx context.Context, r commandRunner, c *cli.Command) error {
				return r.listResources(ctx, c.Name)
			}),
		)
	}
	root.Commands = append(
		root.Commands,
		command(
			"inspect",
			"Inspect a machine",
			"MACHINE",
			1,
			func(ctx context.Context, r commandRunner, c *cli.Command) error {
				return r.inspectMachine(ctx, c.Args().Slice())
			},
		),
		command(
			"operation",
			"Inspect an operation",
			"ID",
			1,
			func(ctx context.Context, r commandRunner, c *cli.Command) error {
				return r.inspectOperation(ctx, c.Args().Slice())
			},
		),
	)
}

func (streams commandStreams) addLifecycleCommands(root *cli.Command) {
	command := streams.command
	create := command(
		"create",
		"Create a machine",
		"NAME",
		1,
		func(ctx context.Context, r commandRunner, c *cli.Command) error {
			return r.createMachine(
				ctx,
				c.Args().First(),
				configValue(c, "profile", r.api.Config.DefaultProfile),
				configValue(c, "host", r.api.Config.DefaultHost),
				configValue(c, "key", r.api.Config.publicKeyFile()),
				c.String("idempotency-key"),
				waitFlags(c),
			)
		},
	)
	create.Flags = append(
		lifecycleFlags(),
		&cli.StringFlag{Name: "profile", Usage: "Machine profile (default: config)"},
		&cli.StringFlag{Name: "host", Usage: "Host (default: config or automatic selection)"},
		keyFlag(),
	)
	root.Commands = append(root.Commands, create)
	for _, name := range []string{"start", "stop", "delete"} {
		c := command(
			name,
			name+" a machine",
			"MACHINE",
			1,
			func(ctx context.Context, r commandRunner, c *cli.Command) error {
				return r.mutateMachine(ctx, c.Name, c.Args().First(), c.String("idempotency-key"), waitFlags(c))
			},
		)
		c.Flags = lifecycleFlags()
		root.Commands = append(root.Commands, c)
	}
	for _, name := range []string{"fork", restoreCommand} {
		c := command(
			name,
			name+" a machine into a new child",
			"SOURCE CHILD",
			childArgCount,
			func(ctx context.Context, r commandRunner, c *cli.Command) error {
				return r.deriveMachine(
					ctx,
					c.Name,
					c.Name,
					c.Args().Get(0),
					c.Args().Get(1),
					configValue(c, "key", r.api.Config.publicKeyFile()),
					c.String("idempotency-key"),
					waitFlags(c),
				)
			},
		)
		if name == restoreCommand {
			c.ArgsUsage = "CHECKPOINT_ID CHILD"
		}
		c.Flags = append(lifecycleFlags(), keyFlag())
		root.Commands = append(root.Commands, c)
	}
	root.Commands = append(root.Commands, streams.checkpoints())
}

func (streams commandStreams) addSSHCommands(root *cli.Command) {
	command := streams.command
	sshConfig := &cli.Command{
		Name:         "ssh-config",
		OnUsageError: returnUsageError,
		Usage:        "Manage SSH aliases",
		Commands: []*cli.Command{
			command(
				"install",
				"Install SSH aliases",
				" ",
				0,
				func(ctx context.Context, r commandRunner, _ *cli.Command) error { return r.installSSH(ctx) },
			),
		},
	}
	root.Commands = append(root.Commands, sshConfig)
	exec := command(
		"exec",
		"Execute literal arguments remotely, preserving streams and exit status",
		"MACHINE -- COMMAND [ARG...]",
		-1,
		func(ctx context.Context, r commandRunner, c *cli.Command) error {
			return r.execMachine(ctx, c.Args().Slice())
		},
	)
	exec.SkipFlagParsing = true
	exec.Action = rawCommandHelp(exec.Action)
	ssh := command(
		"ssh",
		"Open an interactive SSH session",
		"MACHINE",
		1,
		func(ctx context.Context, r commandRunner, c *cli.Command) error {
			return r.sshMachine(ctx, c.Args().Slice())
		},
	)
	root.Commands = append(
		root.Commands,
		exec,
		ssh,
		command(
			"proxy",
			"Proxy a machine's SSH stream",
			"IMMUTABLE_ID",
			1,
			func(ctx context.Context, r commandRunner, c *cli.Command) error {
				return r.proxyMachine(ctx, c.Args().Slice())
			},
		),
	)
	owner := command(
		"_owner",
		"Run the forwarding owner",
		"PIN",
		1,
		func(ctx context.Context, r commandRunner, c *cli.Command) error {
			return r.serveOwner(ctx, c.Args().Slice())
		},
	)
	owner.Hidden = true
	root.Commands = append(root.Commands, owner)
}

func (streams commandStreams) addConnectionCommands(root *cli.Command) {
	command := streams.command
	connect := command(
		"connect",
		"Hold a connection and port forwards until exit",
		"MACHINE",
		1,
		func(ctx context.Context, r commandRunner, c *cli.Command) error {
			var endpoints []Endpoint
			for _, value := range c.StringSlice("forward") {
				ep, err := ParseEndpoint(value)
				if err != nil {
					return err
				}
				endpoints = append(endpoints, ep)
			}
			return r.connectMachine(ctx, c.Args().First(), endpoints)
		},
	)
	connect.Flags = []cli.Flag{
		&cli.StringSliceFlag{Name: "forward", Usage: "Forward numeric guest loopback HOST:PORT (repeatable)"},
	}
	connect.DisableSliceFlagSeparator = true
	root.Commands = append(root.Commands, connect)
	for _, name := range []string{"ports", "url", "open-url"} {
		count, usage := 2, "MACHINE URL"
		if name == "ports" {
			count, usage = 1, "MACHINE"
		}
		root.Commands = append(
			root.Commands,
			command(
				name,
				name+" for a connected machine",
				usage,
				count,
				func(ctx context.Context, r commandRunner, c *cli.Command) error {
					return r.queryForward(ctx, c.Name, c.Args().Slice())
				},
			),
		)
	}
	vnc := command(
		"vnc",
		"Forward VNC until exit",
		"MACHINE",
		1,
		func(ctx context.Context, r commandRunner, c *cli.Command) error {
			return r.vncMachine(ctx, c.Args().First(), c.Bool("viewer"))
		},
	)
	vnc.Flags = []cli.Flag{&cli.BoolFlag{Name: "viewer", Usage: "Open the native VNC viewer"}}
	root.Commands = append(root.Commands, vnc)
}

func returnUsageError(_ context.Context, _ *cli.Command, err error, _ bool) error { return err }
