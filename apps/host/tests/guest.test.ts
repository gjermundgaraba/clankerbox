import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import {
  chmod,
  mkdir,
  outputOf,
  read as readFile,
  readBytes,
  remove,
  scratch,
  stat,
  symlink,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Duration, Effect, Exit, Schedule } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";

import {
  hostKeyIn,
  preparationScript,
  tailnetIn,
  tailnetScript,
} from "../src/guest.ts";
import { furnish, writeStubs, writeTailscaleStubs } from "./fake-runtime.ts";

const seedOf = () => globalThis.crypto.getRandomValues(new Uint8Array(64));

const guest = (uname = "Linux") =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const root = path.join(dir, "root");

    const bin = writeStubs(dir, uname);

    yield* mkdir(path.join(root, "dev"));
    furnish(root, bin);

    return { root, bin };
  });

const prepare = (
  where: { readonly root: string; readonly bin: string },
  instance: string,
  seed: Uint8Array = seedOf()
) =>
  Effect.map(
    outputOf(
      "/bin/sh",
      ["-c", preparationScript, "prepare", instance, "linux_dev"],
      {
        env: { CLANKERBOX_ROOT: where.root, PATH: "/nowhere" },
        extendEnv: true,
        input: seed,
      }
    ),
    ({ code, stdout, stderr }) => ({ code, output: `${stdout}${stderr}` })
  );

const read = (root: string, file: string) => readFile(path.join(root, file));

const calls = (root: string) =>
  Effect.map(
    Effect.orElseSucceed(read(root, "calls"), () => ""),
    (text) => text.split("\n").filter((line) => line !== "")
  );

const hook = (root: string, name: string, body: string) =>
  Effect.gen(function* () {
    const file = path.join(root, "etc", "clankerbox", name);

    yield* mkdir(path.join(root, "etc", "clankerbox"));
    yield* write(file, `#!/bin/sh\n${body}\n`);
    yield* chmod(file, 0o755);
  });

const withHostKeys = (root: string) =>
  Effect.gen(function* () {
    yield* mkdir(path.join(root, "etc", "ssh"));
    yield* write(
      path.join(root, "etc", "ssh", "ssh_host_ed25519_key"),
      "old private\n"
    );
    yield* write(
      path.join(root, "etc", "ssh", "ssh_host_ed25519_key.pub"),
      "ssh-ed25519 AAAAold root@old\n"
    );
  });

const isMissing = (file: string) =>
  Effect.map(Effect.exit(stat(file)), Exit.isFailure);

const waitFor = (file: string, text: string) =>
  Effect.orElseSucceed(readFile(file), () => "").pipe(
    Effect.repeat({
      until: (contents) => contents.includes(text),
      schedule: Schedule.spaced(Duration.millis(10)),
    })
  );

const listener = (root: string, comm: string) =>
  Effect.gen(function* () {
    const marker = path.join(root, "listener");
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const child = yield* spawner.spawn(
      ChildProcess.make(
        "/bin/sh",
        [
          "-c",
          [
            `trap 'echo hup >>"${marker}"' HUP`,
            `trap 'echo usr1 >>"${marker}"' USR1`,
            `echo ready >>"${marker}"`,
            "while :; do sleep 0.05; done",
          ].join("\n"),
        ],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          killSignal: "SIGKILL",
        }
      )
    );

    const pid = String(child.pid);

    yield* mkdir(path.join(root, "run"));
    yield* mkdir(path.join(root, "proc", pid));
    yield* write(path.join(root, "run", "sshd.pid"), `${pid}\n`);
    yield* write(path.join(root, "proc", pid, "comm"), `${comm}\n`);
    yield* waitFor(marker, "ready");

    return {
      hup: waitFor(marker, "hup"),
      settled: Effect.gen(function* () {
        yield* Effect.sync(() => process.kill(child.pid, "SIGUSR1"));

        return yield* waitFor(marker, "usr1");
      }),
    };
  });

const tailnet = (
  where: { readonly root: string; readonly bin: string },
  args: readonly string[],
  input?: string
) =>
  Effect.map(
    outputOf("/bin/sh", ["-c", tailnetScript, "tailnet", ...args], {
      env: { CLANKERBOX_ROOT: where.root, PATH: "/nowhere" },
      extendEnv: true,
      input: new TextEncoder().encode(input ?? ""),
    }),
    ({ code, stdout, stderr }) => ({ code, output: `${stdout}${stderr}` })
  );

const daemon = (root: string, comm: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const child = yield* spawner.spawn(
      ChildProcess.make("/bin/sh", ["-c", "while :; do sleep 0.05; done"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        killSignal: "SIGKILL",
      })
    );

    const pid = String(child.pid);
    const dir = path.join(root, "var", "lib", "clankerbox", "tailscale");

    yield* mkdir(path.join(dir, "state"));
    yield* write(path.join(dir, "state", "tailscaled.state"), "{}\n");
    yield* write(path.join(dir, "tailscaled.pid"), `${pid}\n`);
    yield* mkdir(path.join(root, "proc", pid));
    yield* write(path.join(root, "proc", pid, "comm"), `${comm}\n`);

    return {
      dir,
      alive: Effect.sync(() => {
        try {
          process.kill(child.pid, 0);

          return true;
        } catch {
          return false;
        }
      }),
    };
  });

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "a new instance reseeds, writes the machine ID and the instance, and runs start",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();
        const seed = seedOf();

        yield* hook(
          where.root,
          "start",
          `cat "$CLANKERBOX_ROOT/var/lib/clankerbox/machine-id" >"$CLANKERBOX_ROOT/started"`
        );

        const { code, output } = yield* prepare(where, "aaaa1111", seed);

        expect(code, output).toBe(0);
        expect([
          ...(yield* readBytes(path.join(where.root, "dev", "random"))),
        ]).toStrictEqual([...seed]);
        expect(yield* calls(where.root)).toStrictEqual([
          `perl ${where.root}/dev/urandom`,
        ]);
        expect(yield* read(where.root, "var/lib/clankerbox/machine-id")).toBe(
          "linux_dev\n"
        );
        expect(yield* read(where.root, "var/lib/clankerbox/instance")).toBe(
          "aaaa1111\n"
        );
        expect(yield* read(where.root, "started")).toBe("linux_dev\n");
        expect(hostKeyIn(output)).toBeUndefined();
      })
  );

  it.effect("on Linux without perl, preparation says it needs perl", () =>
    Effect.gen(function* () {
      const where = yield* guest();

      yield* remove(path.join(where.bin, "perl"));
      yield* remove(path.join(where.root, "usr", "bin"));
      yield* remove(path.join(where.root, "bin"));
      yield* symlink("/bin/cat", path.join(where.bin, "cat"));

      const { code, output } = yield* prepare(where, "aaaa1111");

      expect(code).toBe(1);
      expect(output).toContain("preparation needs perl");
      expect(
        yield* isMissing(path.join(where.root, "var/lib/clankerbox/instance"))
      ).toBe(true);
    })
  );

  it.effect("on macOS the seed write is the whole reseed", () =>
    Effect.gen(function* () {
      const where = yield* guest("Darwin");
      const { code, output } = yield* prepare(where, "aaaa1111");

      expect(code, output).toBe(0);
      expect((yield* stat(path.join(where.root, "dev", "random"))).size).toBe(
        64n
      );
      expect(yield* calls(where.root)).toStrictEqual([]);
    })
  );

  it.effect(
    "host keys are re-minted after the reseed, and the new public key is printed last",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        yield* withHostKeys(where.root);

        const { code, output } = yield* prepare(where, "aaaa1111");
        const printed = hostKeyIn(output);

        expect(code, output).toBe(0);
        expect(yield* calls(where.root)).toStrictEqual([
          `perl ${where.root}/dev/urandom`,
          "ssh-keygen -A",
        ]);
        expect(printed).toMatch(/^ssh-ed25519 AAAA[0-9a-f]+$/u);
        expect(`${printed} root@stub\n`).toBe(
          yield* read(where.root, "etc/ssh/ssh_host_ed25519_key.pub")
        );
      })
  );

  it.effect(
    "the same instance skips identity, but start runs and the key is printed again",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        yield* withHostKeys(where.root);
        yield* hook(
          where.root,
          "new-identity",
          `echo hook >>"$CLANKERBOX_ROOT/hooks"`
        );
        yield* hook(
          where.root,
          "start",
          `echo start >>"$CLANKERBOX_ROOT/starts"`
        );

        const first = yield* prepare(where, "aaaa1111");
        const callsAfterFirst = yield* calls(where.root);
        const second = yield* prepare(where, "aaaa1111");

        expect(first.code).toBe(0);
        expect(second.code, second.output).toBe(0);
        expect(yield* calls(where.root)).toStrictEqual(callsAfterFirst);
        expect(yield* read(where.root, "hooks")).toBe("hook\n");
        expect(yield* read(where.root, "starts")).toBe("start\nstart\n");
        expect(hostKeyIn(second.output)).toBe(hostKeyIn(first.output));
      })
  );

  it.effect(
    "another instance, as after a fork or a restore under a reused name, re-mints again",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        yield* withHostKeys(where.root);

        const first = yield* prepare(where, "aaaa1111");
        const second = yield* prepare(where, "bbbb2222");

        expect(second.code, second.output).toBe(0);
        expect(hostKeyIn(second.output)).not.toBe(hostKeyIn(first.output));
        expect(yield* read(where.root, "var/lib/clankerbox/instance")).toBe(
          "bbbb2222\n"
        );
      })
  );

  it.effect(
    "new-identity sees the new machine ID; when it fails, the instance stays old so it runs again",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        yield* hook(
          where.root,
          "new-identity",
          `cat "$CLANKERBOX_ROOT/var/lib/clankerbox/machine-id"; echo "hook broke" >&2; exit 4`
        );

        const { code, output } = yield* prepare(where, "aaaa1111");

        expect(code).toBe(4);
        expect(output).toContain("linux_dev");
        expect(output).toContain("hook broke");
        expect(
          yield* isMissing(path.join(where.root, "var/lib/clankerbox/instance"))
        ).toBe(true);
      })
  );

  it.effect("a failing start fails preparation with its output", () =>
    Effect.gen(function* () {
      const where = yield* guest();

      yield* hook(where.root, "start", `echo "sshd wouldn't start"; exit 2`);

      const { code, output } = yield* prepare(where, "aaaa1111");

      expect(code).toBe(2);
      expect(output).toContain("sshd wouldn't start");
    })
  );

  it.effect(
    "a running sshd gets SIGHUP after the re-mint, so it serves the new key",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        yield* withHostKeys(where.root);

        const sshd = yield* listener(where.root, "sshd");
        const { code, output } = yield* prepare(where, "aaaa1111");

        expect(code, output).toBe(0);
        yield* sshd.hup;
      })
  );

  it.effect("a stale sshd.pid naming another process is left alone", () =>
    Effect.gen(function* () {
      const where = yield* guest();
      const other = yield* listener(where.root, "sleep");
      const { code, output } = yield* prepare(where, "aaaa1111");

      expect(code, output).toBe(0);
      expect(yield* other.settled).not.toContain("hup");
    })
  );

  it("hostKeyIn takes the last marker line and refuses anything that isn't a key", () => {
    expect(
      hostKeyIn(
        "clankerbox-host-key: ssh-rsa AAAAold\nlog\nclankerbox-host-key: ssh-ed25519 AAAAnew=\n"
      )
    ).toBe("ssh-ed25519 AAAAnew=");
    expect(hostKeyIn("clankerbox-host-key: not a key\n")).toBeUndefined();
    expect(hostKeyIn("no key here\n")).toBeUndefined();
  });

  it.effect(
    "a new instance stops the tailscaled its source left running before wiping its node",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();
        const node = yield* daemon(where.root, "tailscaled");
        const { code, output } = yield* prepare(where, "aaaa1111");

        expect(code, output).toBe(0);
        expect(
          yield* Effect.repeat(node.alive, {
            while: (alive) => alive,
            times: 50,
          })
        ).toBe(false);
        expect(yield* isMissing(node.dir)).toBe(true);
      })
  );

  it.effect(
    "a stale tailscaled.pid naming another process is left alone, and the node wiped",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();
        const other = yield* daemon(where.root, "sleep");
        const { code, output } = yield* prepare(where, "aaaa1111");

        expect(code, output).toBe(0);
        expect(yield* other.alive).toBe(true);
        expect(yield* isMissing(other.dir)).toBe(true);
      })
  );

  it.effect("the same instance again keeps its tailscaled and its node", () =>
    Effect.gen(function* () {
      const where = yield* guest();

      expect((yield* prepare(where, "aaaa1111")).code).toBe(0);

      const node = yield* daemon(where.root, "tailscaled");
      const { code, output } = yield* prepare(where, "aaaa1111");

      expect(code, output).toBe(0);
      expect(yield* node.alive).toBe(true);
      expect(
        yield* isMissing(path.join(node.dir, "state", "tailscaled.state"))
      ).toBe(false);
    })
  );

  it.effect(
    "a guest without tailscaled reports it missing, and the check starts nothing",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();
        const { code, output } = yield* tailnet(where, ["linux-dev", "user"]);

        expect(code, output).toBe(0);
        expect(tailnetIn(output)).toStrictEqual({ missing: true });
        expect(yield* calls(where.root)).toStrictEqual([]);
      })
  );

  it.effect(
    "the check starts tailscaled from its saved state, with a fresh log, sets its DNS and firewall preferences, and reports it",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        const dir = path.join(
          where.root,
          "var",
          "lib",
          "clankerbox",
          "tailscale"
        );

        yield* Effect.sync(() => {
          writeTailscaleStubs(where.bin);
        });
        yield* mkdir(dir);
        yield* write(
          path.join(dir, "tailscaled.log"),
          "the last boot's daemon\n"
        );

        const { code, output } = yield* tailnet(where, ["linux-dev", "user"]);

        expect(code, output).toBe(0);
        expect(tailnetIn(output)).toStrictEqual({
          missing: false,
          backend: "NeedsLogin",
          name: undefined,
        });
        expect(yield* calls(where.root)).toStrictEqual([
          `tailscaled --statedir=${dir}/state --socket=${dir}/tailscaled.sock --port=0`,
          `tailscale --socket=${dir}/tailscaled.sock set --accept-dns --netfilter-mode=off`,
        ]);
        expect(yield* isMissing(path.join(dir, "tailscaled.pid"))).toBe(false);
        expect(yield* read(dir, "tailscaled.log")).toBe("");
      })
  );

  it.effect(
    "the check finds tailscale in /opt/homebrew/bin, where Tart's guests have it",
    () =>
      Effect.gen(function* () {
        const where = yield* guest("Darwin");

        yield* Effect.sync(() => {
          writeTailscaleStubs(path.join(where.root, "opt", "homebrew", "bin"));
        });

        const { code, output } = yield* tailnet(where, ["mac-dev", "admin"]);

        expect(code, output).toBe(0);
        expect(tailnetIn(output)).toMatchObject({
          missing: false,
          backend: "NeedsLogin",
        });
        expect(
          (yield* read(where.root, "tailscaled.env")).split("\n")
        ).toContain("TS_PERMIT_CERT_UID=admin");
        expect((yield* calls(where.root)).at(-1)).toMatch(
          / set --accept-dns$/u
        );
      })
  );

  it.effect(
    "the check lets the login user fetch the node's certificate, and reach the socket across rechecks",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        const dir = path.join(
          where.root,
          "var",
          "lib",
          "clankerbox",
          "tailscale"
        );

        yield* Effect.sync(() => {
          writeTailscaleStubs(where.bin);
        });

        const first = yield* tailnet(where, ["linux-dev", "user"]);

        expect(first.code, first.output).toBe(0);
        expect(
          (yield* read(where.root, "tailscaled.env")).split("\n")
        ).toContain("TS_PERMIT_CERT_UID=user");
        expect((yield* stat(dir)).mode & 0o777).toBe(0o711);

        yield* chmod(dir, 0o755);

        const second = yield* tailnet(where, ["linux-dev", "user"]);

        expect(second.code, second.output).toBe(0);
        expect(
          (yield* calls(where.root)).filter((call) =>
            call.startsWith("tailscaled ")
          )
        ).toHaveLength(1);
        expect((yield* stat(dir)).mode & 0o777).toBe(0o711);
      })
  );

  it.effect(
    "a check that finds tailscaled answering starts no second one",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        yield* Effect.sync(() => {
          writeTailscaleStubs(where.bin);
        });
        yield* write(path.join(where.root, "daemon"), "");
        yield* write(
          path.join(where.root, "status.json"),
          '{\n  "BackendState": "Running",\n  "Self": {\n    "ID": "n1",\n    "DNSName": "linux-dev.example.ts.net."\n  }\n}\n'
        );

        const { code, output } = yield* tailnet(where, ["linux-dev", "user"]);

        expect(code, output).toBe(0);
        expect(tailnetIn(output)).toStrictEqual({
          missing: false,
          backend: "Running",
          name: "linux-dev.example.ts.net",
        });
        expect(yield* calls(where.root)).toStrictEqual([
          expect.stringMatching(/ set --accept-dns --netfilter-mode=off$/u),
        ]);
      })
  );

  it.effect(
    "a check that finds tailscaled stopped leaves it so, and says so",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        yield* Effect.sync(() => {
          writeTailscaleStubs(where.bin);
        });
        yield* write(path.join(where.root, "daemon"), "");
        yield* write(
          path.join(where.root, "status.json"),
          '{"BackendState": "Stopped", "Self": {}}\n'
        );

        const { code, output } = yield* tailnet(where, ["linux-dev", "user"]);

        expect(code, output).toBe(0);
        expect(tailnetIn(output)).toMatchObject({ backend: "Stopped" });
        expect(yield* calls(where.root)).toStrictEqual([
          expect.stringMatching(/ set --accept-dns --netfilter-mode=off$/u),
        ]);
      })
  );

  it.effect(
    "a join signs in as the hostname given, with the key in a private file it removes",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        const dir = path.join(
          where.root,
          "var",
          "lib",
          "clankerbox",
          "tailscale"
        );

        yield* Effect.sync(() => {
          writeTailscaleStubs(where.bin);
        });
        yield* write(path.join(where.root, "daemon"), "");

        const { code, output } = yield* tailnet(
          where,
          ["linux-dev", "user", "join"],
          "tskey-auth-k1"
        );

        const [up] = yield* calls(where.root);

        expect(code, output).toBe(0);
        expect(tailnetIn(output)).toStrictEqual({
          missing: false,
          backend: "Running",
          name: "linux-dev.example.ts.net",
        });
        expect(up).toMatch(
          new RegExp(
            `^tailscale --socket=${dir}/tailscaled\\.sock up --reset --hostname=linux-dev --accept-dns --netfilter-mode=off --timeout=60s --auth-key=file:${dir}/key\\.\\S+$`,
            "u"
          )
        );
        expect(yield* read(where.root, "key-seen")).toBe("tskey-auth-k1");
        expect((yield* read(where.root, "key-mode")).trim()).toBe("-rw-------");
        expect(
          (yield* outputOf("/bin/sh", ["-c", `ls "${dir}"`])).stdout
        ).not.toContain("key.");
      })
  );

  it("tailnetIn decodes the last report, whatever order its fields come in", () => {
    expect(
      tailnetIn(
        [
          'clankerbox-tailnet: {"BackendState": "NeedsLogin"}',
          "log",
          'clankerbox-tailnet: {"Self": {"CapMap": {"a": null}, "DNSName": "a.ts.net."}, "BackendState": "Running"}',
        ].join("\n")
      )
    ).toStrictEqual({ missing: false, backend: "Running", name: "a.ts.net" });
    expect(
      tailnetIn(
        'clankerbox-tailnet: {"BackendState": "Running", "Self": {"DNSName": ""}}'
      )
    ).toStrictEqual({ missing: false, backend: "Running", name: undefined });
    expect(tailnetIn("clankerbox-tailnet:  \n")).toStrictEqual({
      missing: false,
      backend: "unreachable",
      name: undefined,
    });
    expect(tailnetIn("clankerbox-tailnet: missing\n")).toStrictEqual({
      missing: true,
    });
    expect(tailnetIn("clankerbox-tailnet: {not json\n")).toBeUndefined();
    expect(tailnetIn("nothing\n")).toBeUndefined();
  });
});
