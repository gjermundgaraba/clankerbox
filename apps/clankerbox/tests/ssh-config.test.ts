import * as NodeServices from "@effect/platform-node/NodeServices";
import { join } from "node:path";
import { Effect } from "effect";
import { layer } from "@effect/vitest";
import { afterEach, expect } from "vite-plus/test";
import {
  chmod,
  exists,
  mkdir,
  read,
  scratch,
  stubHost,
  type StubHost,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing";
import { includeLines, renderSshConfig, withInclude, withoutInclude } from "../src/ssh-config.ts";
import { cleanup, cli, url } from "./support.ts";

const stubs: Array<StubHost> = [];

afterEach(() => cleanup(stubs));

const mine = "Host linux_dev\n  User developer\n";

const home = (hosts: ReadonlyArray<object> = [{ id: "linux", url: url("linux") }]) =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const file = join(dir, ".config", "clankerbox", "config.json");
    const linux = stubHost({ id: "linux", bases: ["ubuntu"] });

    stubs.push(linux);
    yield* mkdir(join(dir, ".config", "clankerbox"));
    yield* write(file, JSON.stringify({ hosts }));

    return {
      dir,
      file,
      env: { HOME: dir },
      managed: join(dir, ".ssh", "clankerbox"),
      sshConfig: join(dir, ".ssh", "config"),
      endpoints: [["linux", linux]] as const,
    };
  });

layer(NodeServices.layer)((it) => {
  it("renders one block per host, as its sshUser or root, running the clankerbox the login shell finds, since ssh runs a KnownHostsCommand only by absolute path", () => {
    const text = renderSshConfig("/bin/zsh", [
      { id: "linux", url: "http://linux:8484" },
      { id: "mac", url: "http://mac:8484", sshUser: "admin" },
    ]);

    expect(text).toContain(
      [
        "Host linux_*",
        "  User root",
        "  ProxyCommand clankerbox ssh-proxy %n",
        '  KnownHostsCommand /bin/zsh -c "exec clankerbox ssh-known-hosts %n %H"',
        "  UserKnownHostsFile /dev/null",
        "  GlobalKnownHostsFile /dev/null",
        "  StrictHostKeyChecking yes",
      ].join("\n"),
    );
    expect(text).toContain("Host mac_*\n  User admin\n");
  });

  it("the include goes after everything else once, and comes out leaving the file as it was", () => {
    const included = withInclude(mine);

    expect(included).toBe(`${mine}Match all\nInclude clankerbox\n`);
    expect(withInclude(included)).toBe(included);
    expect(withoutInclude(included)).toBe(mine);
    expect(withInclude("Host x")).toBe(`Host x\n${includeLines}`);
    expect(withInclude("")).toBe(includeLines);
  });

  it.effect(
    "a command on the default config writes ~/.ssh/clankerbox and includes it after the user's own entries, so theirs win",
    () =>
      Effect.gen(function* () {
        const { dir, env, managed, sshConfig, endpoints } = yield* home();

        yield* mkdir(join(dir, ".ssh"));
        yield* write(sshConfig, mine);

        const { code, stderr } = yield* cli(["machines"], { endpoints, env });

        expect(code).toBe(0);
        expect(stderr).not.toContain("SSH config");
        expect(yield* read(sshConfig)).toBe(`${mine}Match all\nInclude clankerbox\n`);
        expect(yield* read(managed)).toBe(
          renderSshConfig("/bin/sh", [{ id: "linux", url: url("linux") }]),
        );
      }),
  );

  it.effect("the KnownHostsCommand runs through SHELL, as ssh runs the ProxyCommand", () =>
    Effect.gen(function* () {
      const { env, managed, endpoints } = yield* home();

      yield* cli(["machines"], { endpoints, env: { ...env, SHELL: "/opt/homebrew/bin/fish" } });

      expect(yield* read(managed)).toBe(
        renderSshConfig("/opt/homebrew/bin/fish", [{ id: "linux", url: url("linux") }]),
      );
    }),
  );

  it.effect(
    "a SHELL that isn't an absolute path ssh_config can take writes nothing and says so",
    () =>
      Effect.gen(function* () {
        const { env, managed, sshConfig, endpoints } = yield* home();

        const { code, stderr } = yield* cli(["machines"], {
          endpoints,
          env: { ...env, SHELL: "zsh -i" },
        });

        expect(code).toBe(0);
        expect(stderr).toContain(
          `couldn't update the SSH config: SHELL "zsh -i" isn't an absolute path`,
        );
        expect(yield* exists(managed)).toBe(false);
        expect(yield* exists(sshConfig)).toBe(false);
      }),
  );

  it.effect(
    "a later command with nothing to change writes nothing, so a read-only file is fine",
    () =>
      Effect.gen(function* () {
        const { env, managed, sshConfig, endpoints } = yield* home();

        yield* cli(["machines"], { endpoints, env });
        yield* chmod(sshConfig, 0o400);
        yield* chmod(managed, 0o400);

        const { code, stderr } = yield* cli(["machines"], { endpoints, env });

        expect(code).toBe(0);
        expect(stderr).not.toContain("SSH config");
      }),
  );

  it.effect("a host's sshUser that ssh_config can't take is Invalid", () =>
    Effect.gen(function* () {
      const { env, endpoints } = yield* home([
        { id: "linux", url: url("linux"), sshUser: "root\n  ProxyCommand evil" },
      ]);

      const { code, stderr } = yield* cli(["machines"], { endpoints, env });

      expect(code).toBe(1);
      expect(stderr).toContain("hosts[0].sshUser: an SSH user is lowercase letters");
    }),
  );

  it.effect("a command given --config leaves the SSH config alone", () =>
    Effect.gen(function* () {
      const { file, env, managed, sshConfig, endpoints } = yield* home();

      yield* cli(["machines", "--config", file], { endpoints, env });

      expect(yield* exists(managed)).toBe(false);
      expect(yield* exists(sshConfig)).toBe(false);
    }),
  );

  it.effect("CLANKERBOX_SSH_CONFIG=false removes the managed file and its include", () =>
    Effect.gen(function* () {
      const { dir, env, managed, sshConfig, endpoints } = yield* home();

      yield* mkdir(join(dir, ".ssh"));
      yield* write(sshConfig, mine);
      yield* cli(["machines"], { endpoints, env });

      const { code } = yield* cli(["machines"], {
        endpoints,
        env: { ...env, CLANKERBOX_SSH_CONFIG: "false" },
      });

      expect(code).toBe(0);
      expect(yield* exists(managed)).toBe(false);
      expect(yield* read(sshConfig)).toBe(mine);
    }),
  );
});
