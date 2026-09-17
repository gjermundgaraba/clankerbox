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
		Description: "Lifecycle changes wait for completion by default. Terminal sessions require a running machine.",
		Writer:      streams.Out, ErrWriter: streams.Err,
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
	commandStreams(streams).addResourceCommands(root)
	commandStreams(streams).addProfileCommands(root)
	commandStreams(streams).addLifecycleCommands(root)
	commandStreams(streams).addSessionCommands(root)
	commandStreams(streams).addDevCommands(root)
	return root
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
			defer api.Close()
			return action(ctx, commandRunner{api: api, streams: Streams(streams), structured: cmd.Bool("json")}, cmd)
		},
	}
}

const childArgCount = 2

func (streams commandStreams) checkpoints() *cli.Command {
	create := streams.command("create", "Capture a machine checkpoint", "MACHINE", 1,
		func(ctx context.Context, r commandRunner, c *cli.Command) error {
			return r.captureCheckpoint(ctx, c.Args().First(), c.String("idempotency-key"), waitFlags(c))
		})
	create.Flags = lifecycleFlags()
	remove := streams.command("delete", "Delete a checkpoint", "CHECKPOINT_ID", 1,
		func(ctx context.Context, r commandRunner, c *cli.Command) error {
			return r.deleteCheckpoint(ctx, c.Args().First(), c.String("idempotency-key"), waitFlags(c))
		})
	remove.Flags = lifecycleFlags()
	return &cli.Command{Name: "checkpoint", Usage: "Manage machine checkpoints", OnUsageError: returnUsageError,
		Commands: []*cli.Command{create, remove,
			streams.command("list", "List checkpoints", " ", 0, func(ctx context.Context, r commandRunner, _ *cli.Command) error {
				return r.listCheckpoints(ctx)
			}),
			streams.command("inspect", "Inspect a checkpoint", "CHECKPOINT_ID", 1, func(ctx context.Context, r commandRunner, c *cli.Command) error {
				return r.inspectCheckpoint(ctx, c.Args().First())
			}),
		},
	}
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
				c.String("idempotency-key"),
				waitFlags(c),
			)
		},
	)
	create.Flags = append(
		lifecycleFlags(),
		&cli.StringFlag{Name: "profile", Usage: "Machine profile (default: config)"},
		&cli.StringFlag{Name: "host", Usage: "Host (default: config or automatic selection)"},
	)
	root.Commands = append(root.Commands, create)
	for _, name := range []string{"start", stopCommandName, deleteCommandName} {
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
	fork := command("fork", "Fork a machine into a new child", "MACHINE CHILD", childArgCount,
		func(ctx context.Context, r commandRunner, c *cli.Command) error {
			return r.forkMachine(ctx, c.Args().Get(0), c.Args().Get(1), c.String("idempotency-key"), waitFlags(c))
		})
	fork.Flags = lifecycleFlags()
	restore := command("restore", "Restore a checkpoint into a new machine", "CHECKPOINT_ID CHILD", childArgCount,
		func(ctx context.Context, r commandRunner, c *cli.Command) error {
			return r.restoreCheckpoint(ctx, c.Args().Get(0), c.Args().Get(1), c.String("idempotency-key"), waitFlags(c))
		})
	restore.Flags = lifecycleFlags()
	root.Commands = append(root.Commands, fork, restore)
	root.Commands = append(root.Commands, streams.checkpoints())
}

func returnUsageError(_ context.Context, _ *cli.Command, err error, _ bool) error { return err }

const (
	stopCommandName   = "stop"
	deleteCommandName = "delete"
)
