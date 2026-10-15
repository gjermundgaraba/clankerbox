import { Config, Console, Context, Effect, FileSystem, Option, Path } from "effect";
import type { LoadedConfig } from "./config.ts";

export const Executable = Context.Reference<Option.Option<string>>(
  "@clankerbox/clankerbox/Executable",
  { defaultValue: Option.none },
);

export const includeLines = "Match all\nInclude clankerbox\n";

const unquotable = /["'$`\\%\n]/u;

const block = (run: (command: string) => string, host: LoadedConfig["hosts"][number]): string =>
  [
    `Host ${host.id}_*`,
    `  User ${host.sshUser ?? "root"}`,
    `  ProxyCommand ${run("ssh-proxy")} %n`,
    `  KnownHostsCommand ${run("ssh-known-hosts")} %n %H`,
    "  UserKnownHostsFile /dev/null",
    "  GlobalKnownHostsFile /dev/null",
    "  StrictHostKeyChecking yes",
    "  CheckHostIP no",
    "  UpdateHostKeys no",
    "",
  ].join("\n");

export const renderSshConfig = (executable: string, config: LoadedConfig): string => {
  const run = (command: string) => `"${executable}" ${command} --config "${config.file}"`;

  return [
    "# Managed by clankerbox; do not edit. CLANKERBOX_SSH_CONFIG=false removes it.",
    "",
    ...config.hosts.map((host) => block(run, host)),
  ].join("\n");
};

export const withInclude = (text: string): string =>
  text.includes(includeLines)
    ? text
    : `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${includeLines}`;

export const withoutInclude = (text: string): string => text.replace(includeLines, "");

const readOrEmpty = (fs: FileSystem.FileSystem, file: string) =>
  Effect.flatMap(fs.exists(file), (exists) =>
    exists ? fs.readFileString(file) : Effect.succeed(""),
  );

const update = (fs: FileSystem.FileSystem, file: string, change: (text: string) => string) =>
  Effect.flatMap(readOrEmpty(fs, file), (before) => {
    const after = change(before);

    return after === before ? Effect.void : fs.writeFileString(file, after, { mode: 0o600 });
  });

const warn = (reason: string) =>
  Console.error(
    `clankerbox: couldn't update the SSH config: ${reason}; CLANKERBOX_SSH_CONFIG=false stops trying`,
  );

export const syncSshConfig = (config: LoadedConfig) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const enabled = yield* Config.Boolean("CLANKERBOX_SSH_CONFIG").pipe(Config.withDefault(true));
    const home = yield* Config.option(Config.String("HOME"));
    const executable = yield* Executable;

    if (Option.isNone(home)) {
      return;
    }

    const directory = path.join(home.value, ".ssh");
    const managed = path.join(directory, "clankerbox");
    const userConfig = path.join(directory, "config");

    if (!enabled) {
      yield* fs.remove(managed, { force: true });
      yield* update(fs, userConfig, withoutInclude);

      return;
    }

    if (Option.isNone(executable)) {
      return;
    }

    if (unquotable.test(executable.value) || unquotable.test(config.file)) {
      return yield* warn(`${executable.value} or ${config.file} has a character it can't quote`);
    }

    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    yield* update(fs, managed, () => renderSshConfig(executable.value, config));
    yield* update(fs, userConfig, withInclude);
  }).pipe(Effect.catch((error) => warn(error.message)));
