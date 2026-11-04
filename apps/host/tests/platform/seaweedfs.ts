import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Schedule } from "effect";
import type { Scope } from "effect";

import type { BuildsSettings } from "../../src/platform/s3.ts";

const image =
  "chrislusf/seaweedfs:4.52@sha256:57877e32bb90073b37dc109b438ba66e84fd5ed9ced5f5c04f56444ef243ce59";

const bucket = "templates";

export const dockerAnswers =
  spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0;

const docker = (args: readonly string[]) =>
  Effect.callback<string, Internal>((resume, signal) => {
    execFile("docker", [...args], { signal }, (error, stdout, stderr) => {
      resume(
        error === null
          ? Effect.succeed(stdout.trim())
          : Effect.fail(
              new Internal({
                message: `docker ${args[0] ?? ""} failed: ${stderr.trim()}`,
              })
            )
      );
    });
  });

const until = <A, E>(what: string, attempt: Effect.Effect<A, E>) =>
  attempt.pipe(
    Effect.retry({ schedule: Schedule.spaced("250 millis") }),
    Effect.timeout("1 minute"),
    Effect.mapError(
      () => new Internal({ message: `SeaweedFS never ${what} in a minute` })
    )
  );

/**
 * A SeaweedFS S3 store in a container of its own, with the bucket `templates`, removed when the
 * scope closes. Its settings are as a host's config holds them under `builds`.
 */
export const seaweedfs: Effect.Effect<
  typeof BuildsSettings.Encoded,
  Internal,
  Scope.Scope
> = Effect.gen(function* () {
  const name = `clankerbox-s3-test-${randomBytes(8).toString("hex")}`;
  const accessKeyId = `scratch-${randomBytes(8).toString("hex")}`;
  const secretAccessKey = randomBytes(24).toString("hex");

  yield* Effect.addFinalizer(() => Effect.ignore(docker(["rm", "-f", name])));

  yield* docker([
    "run",
    "-d",
    "--name",
    name,
    "-p",
    "127.0.0.1::8333",
    "-e",
    `AWS_ACCESS_KEY_ID=${accessKeyId}`,
    "-e",
    `AWS_SECRET_ACCESS_KEY=${secretAccessKey}`,
    image,
    "server",
    "-ip=127.0.0.1",
    "-ip.bind=0.0.0.0",
    "-filer",
    "-s3",
    "-s3.port.iceberg=0",
    "-s3.port.lance=0",
    "-master.telemetry=false",
    "-metricsPort=0",
    "-volume.max=0",
  ]);

  const bound = yield* docker(["port", name, "8333/tcp"]);
  const endpoint = `http://127.0.0.1:${bound.slice(bound.lastIndexOf(":") + 1)}`;

  yield* until(
    "answered on its filer",
    docker([
      "exec",
      name,
      "sh",
      "-c",
      "wget -q -O /dev/null http://127.0.0.1:8888/",
    ])
  );

  yield* until(
    "made the bucket",
    docker([
      "exec",
      name,
      "sh",
      "-c",
      `echo 's3.bucket.create -name ${bucket}' | weed shell`,
    ])
  );

  yield* until(
    "refused an unsigned read of the bucket",
    Effect.tryPromise(async () => await fetch(`${endpoint}/${bucket}`)).pipe(
      Effect.filterOrFail((response) => response.status === 403)
    )
  );

  return {
    endpoint,
    bucket,
    region: "us-east-1",
    accessKeyId,
    secretAccessKey,
  };
});
