import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { cliIn, expect, files } from "../process.ts";

const searchPath = "/usr/bin:/bin";

export interface SshKey {
  readonly file: string;
  readonly publicKey: string;
}

export const keyFile = (stateDir: string): string => join(stateDir, "boat-ssh", "id_ed25519");

export const sshKey = (stateDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = keyFile(stateDir);

    if (!(yield* files(`couldn't read ${file}`, fs.exists(file)))) {
      const fresh = `${file}.new`;
      const { run } = yield* cliIn({ PATH: searchPath });

      yield* files(
        `couldn't create ${join(stateDir, "boat-ssh")}`,
        fs.makeDirectory(join(stateDir, "boat-ssh"), { recursive: true, mode: 0o700 }),
      );

      for (const left of [fresh, `${fresh}.pub`]) {
        yield* files(`couldn't remove ${left}`, fs.remove(left, { force: true }));
      }

      yield* Effect.flatMap(
        run(
          "ssh-keygen",
          ["-q", "-t", "ed25519", "-N", "", "-C", "clankerbox-boat", "-f", fresh],
          "ssh-keygen",
        ),
        (ran) => expect(ran, "ssh-keygen"),
      );

      yield* files(`couldn't place ${file}.pub`, fs.rename(`${fresh}.pub`, `${file}.pub`));
      yield* files(`couldn't place ${file}`, fs.rename(fresh, file));
    }

    const publicKey = yield* files(`couldn't read ${file}.pub`, fs.readFileString(`${file}.pub`));

    return { file, publicKey: publicKey.trim() } satisfies SshKey;
  });
