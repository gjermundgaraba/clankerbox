import type { CheckpointRef } from "@clankerbox/host-contract";
import { describeFileError, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Context, Effect, FileSystem, Option, Path, Schema } from "effect";
import type { PlatformError } from "effect";
import { Hex } from "effect/encoding";

import type { Runtime } from "./runtime.ts";

/**
 * Where a host copies template builds to and from, shared by every host of the fleet: objects by
 * key. A key names the same bytes for good, so a put of a key that is there changes nothing.
 */
export interface Interface {
  /** Every key that starts with `prefix`. */
  readonly list: (prefix: string) => Effect.Effect<readonly string[], Internal>;
  readonly get: (key: string) => Effect.Effect<Uint8Array, Internal>;
  readonly put: (
    key: string,
    body: Uint8Array
  ) => Effect.Effect<void, Internal>;
  /** Removes each key, also one that isn't there. */
  readonly remove: (keys: readonly string[]) => Effect.Effect<void, Internal>;
}

export class BuildStore extends Context.Service<BuildStore, Interface>()(
  "@clankerbox/host/BuildStore"
) {}

export const pieceBytes = 16 * 1024 * 1024;

const objects = "objects/";

const manifests = "builds/";

const concurrency = 16;

const Manifest = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      size: Schema.Int,
      key: Schema.optionalKey(Schema.String),
      pieces: Schema.optionalKey(Schema.Array(Schema.NullOr(Schema.String))),
    })
  ),
});

type Manifest = typeof Manifest.Type;

const ManifestJson = Schema.fromJsonString(Manifest);

const encodeManifest = Schema.encodeSync(ManifestJson);

const decodeManifest = Schema.decodeUnknownEffect(ManifestJson);

const manifestKey = (name: string) => `${manifests}${name}.json`;

const pieceKey = (hash: string) => `pieces/${hash}`;

const sha256 = (bytes: Uint8Array) =>
  Effect.map(
    Effect.promise(
      async () =>
        await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes))
    ),
    (digest) => Hex.encode(new Uint8Array(digest))
  );

const gzipped = (bytes: Uint8Array, through: ReadableWritablePair) =>
  Effect.tryPromise({
    try: async () =>
      new Uint8Array(
        await new Response(
          new Blob([new Uint8Array(bytes)]).stream().pipeThrough(through)
        ).arrayBuffer()
      ),
    catch: (cause) =>
      new Internal({ message: `a build piece isn't gzip: ${String(cause)}` }),
  });

const zeros = (bytes: Uint8Array) => bytes.every((byte) => byte === 0);

const onFile =
  (what: string) =>
  <A, R>(effect: Effect.Effect<A, PlatformError.PlatformError, R>) =>
    Effect.mapError(
      effect,
      (error) =>
        new Internal({ message: `${what}: ${describeFileError(error)}` })
    );

const referenced = (manifest: Manifest) =>
  manifest.files.flatMap(({ key, pieces }) =>
    key === undefined
      ? (pieces ?? []).flatMap((piece) =>
          piece === null ? [] : [pieceKey(piece)]
        )
      : [key]
  );

const readManifest = (store: Interface, name: string) =>
  Effect.flatMap(store.get(manifestKey(name)), (body) =>
    decodeManifest(new TextDecoder().decode(body)).pipe(
      Effect.mapError(
        (error) =>
          new Internal({
            message: `build store object ${manifestKey(name)} isn't a manifest: ${error.message}`,
          })
      )
    )
  );

/**
 * Uploads `checkpoint`'s files under `as`, each object only when the store lacks it, and the
 * manifest last, so whatever reads the manifest finds every object it names.
 */
export const publish = (
  store: Interface,
  runtime: Runtime["Service"],
  checkpoint: CheckpointRef,
  as: string
): Effect.Effect<void, Internal, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const present = new Set(yield* store.list(objects));
    let uploaded = 0;

    const put = (key: string, body: Effect.Effect<Uint8Array, Internal>) =>
      present.has(`${objects}${key}`)
        ? Effect.void
        : Effect.flatMap(body, (bytes) => {
            uploaded += bytes.length;

            return store.put(`${objects}${key}`, bytes);
          });

    const pieced = (file: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const reading = onFile(`couldn't read ${file}`);
          const handle = yield* reading(fs.open(file, { flag: "r" }));
          const pieces: Array<string | null> = [];

          for (;;) {
            const read = yield* reading(handle.readAlloc(pieceBytes));

            if (Option.isNone(read)) {
              return pieces;
            }

            if (zeros(read.value)) {
              pieces.push(null);
            } else {
              const hash = yield* sha256(read.value);

              yield* put(
                pieceKey(hash),
                gzipped(read.value, new CompressionStream("gzip"))
              );
              pieces.push(hash);
            }
          }
        })
      );

    const files = yield* runtime.checkpointFiles(checkpoint);

    const listed = yield* Effect.forEach(
      files,
      ({ path, file, key }) =>
        Effect.gen(function* () {
          const reading = onFile(`couldn't read ${file}`);
          const size = Number((yield* reading(fs.stat(file))).size);

          if (key === undefined) {
            return { path, size, pieces: yield* pieced(file) };
          }

          yield* put(key, reading(fs.readFile(file)));

          return { path, size, key };
        }),
      { concurrency }
    );

    yield* store.put(
      manifestKey(as),
      new TextEncoder().encode(encodeManifest({ files: listed }))
    );
    yield* Effect.logInfo(
      `publish ${checkpoint.name} as ${as} uploaded ${uploaded} bytes for ${files.length} files`
    );
  });

/**
 * Makes `checkpoint` from what was published as `from`, of template build `build`: a file this host
 * holds by its key is linked from where it lies, and only the rest is downloaded.
 */
export const fetch = (
  store: Interface,
  runtime: Runtime["Service"],
  checkpoint: CheckpointRef,
  from: string,
  build: string
): Effect.Effect<void, Internal, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const staged = runtime.staging(checkpoint);
    const manifest = yield* readManifest(store, from);
    let downloaded = 0;
    let fetched = 0;

    const object = (key: string) =>
      Effect.tap(store.get(`${objects}${key}`), (bytes) =>
        Effect.sync(() => {
          downloaded += bytes.length;
          fetched += 1;
        })
      );

    const placed = ({ path, size, key, pieces }: Manifest["files"][number]) =>
      Effect.gen(function* () {
        const target = paths.join(staged, path);
        const writing = onFile(`couldn't write ${target}`);

        yield* writing(
          fs.makeDirectory(paths.dirname(target), { recursive: true })
        );

        if (key !== undefined) {
          const local = yield* runtime.held(key);

          const fromStore = Effect.flatMap(object(key), (bytes) =>
            writing(fs.writeFile(target, bytes))
          );

          return yield* local === undefined
            ? fromStore
            : fs.link(local, target).pipe(Effect.catch(() => fromStore));
        }

        yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* writing(fs.open(target, { flag: "w" }));

            for (const [index, piece] of (pieces ?? []).entries()) {
              if (piece !== null) {
                const bytes = yield* gzipped(
                  yield* object(pieceKey(piece)),
                  new DecompressionStream("gzip")
                );

                yield* writing(
                  handle.seek(BigInt(index * pieceBytes), "start")
                );
                yield* writing(handle.writeAll(bytes));
              }
            }

            yield* writing(handle.truncate(size));
          })
        );
      });

    yield* Effect.gen(function* () {
      yield* onFile(`couldn't make ${staged}`)(
        fs.makeDirectory(staged, { recursive: true })
      );
      yield* Effect.forEach(manifest.files, placed, {
        concurrency,
        discard: true,
      });
      yield* runtime.install(checkpoint, staged);
    }).pipe(
      Effect.ensuring(
        Effect.ignore(fs.remove(staged, { recursive: true, force: true }))
      )
    );

    yield* Effect.logInfo(
      `fetch ${build} downloaded ${downloaded} bytes in ${fetched} objects, for ${manifest.files.length} files`
    );
  });

/**
 * Removes what was published as `name`: its manifest, then every object no other manifest names,
 * which also clears what a publish that never ended left.
 */
export const unpublish = (
  store: Interface,
  name: string
): Effect.Effect<void, Internal> =>
  Effect.gen(function* () {
    yield* store.remove([manifestKey(name)]);

    const kept = new Set<string>();

    for (const key of yield* store.list(manifests)) {
      const other = key.slice(manifests.length, -".json".length);

      for (const each of referenced(yield* readManifest(store, other))) {
        kept.add(`${objects}${each}`);
      }
    }

    const unused = (yield* store.list(objects)).filter((key) => !kept.has(key));

    yield* store.remove(unused);
    yield* Effect.logInfo(
      `unpublish ${name} removed ${unused.length} objects no other build holds`
    );
  });
