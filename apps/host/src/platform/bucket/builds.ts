import { describeFileError, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import type { PlatformError } from "effect";
import { Hex } from "effect/encoding";

import type {
  SharedBuilds,
  Handle,
  Identity,
  RuntimeError,
  Target,
} from "../../runtime.ts";

export interface Store {
  readonly list: (prefix: string) => Effect.Effect<readonly string[], Internal>;
  readonly get: (key: string) => Effect.Effect<Uint8Array, Internal>;
  readonly put: (
    key: string,
    body: Uint8Array
  ) => Effect.Effect<void, Internal>;
  readonly remove: (keys: readonly string[]) => Effect.Effect<void, Internal>;
}

export interface CheckpointFile {
  readonly path: string;
  readonly file: string;
  readonly key?: string | undefined;
}

export interface CheckpointFiles {
  readonly checkpointFiles: (
    checkpoint: Target
  ) => Effect.Effect<readonly CheckpointFile[], RuntimeError>;
  readonly held: (key: string) => Effect.Effect<string | undefined>;
  readonly staging: (checkpoint: Identity) => string;
  readonly install: (
    checkpoint: Identity,
    staged: string
  ) => Effect.Effect<Handle, RuntimeError>;
}

export const pieceBytes = 16 * 1024 * 1024;

const objects = "objects/";

const manifests = "builds/";

const concurrency = 16;

const Within = Schema.String.check(
  Schema.makeFilter(
    (path: string) =>
      path
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== "..") ||
      "a relative path with no empty, . or .. part"
  )
);

const Size = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Sha256 = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u, { message: "a SHA-256 in hex" })
);

const Key = Schema.String.check(
  Schema.isPattern(/^[a-z]+\/[0-9a-f]{64}$/u, {
    message: "a runtime's name, / and a SHA-256 in hex",
  })
);

const storeObject = /^objects\/(?<hash>[0-9a-f]{64})$/u;

const Keyed = Schema.Struct({ path: Within, size: Size, key: Key }).check(
  Schema.makeFilter(
    ({ path, key }: { readonly path: string; readonly key: string }) => {
      const object = storeObject.exec(path)?.groups?.["hash"];

      return (
        object === undefined ||
        key.endsWith(`/${object}`) ||
        "a key of the SHA-256 its objects/ path names"
      );
    }
  )
);

const Pieced = Schema.Struct({
  path: Within,
  size: Size,
  pieces: Schema.Array(Schema.NullOr(Sha256)),
}).check(
  Schema.makeFilter(
    ({
      size,
      pieces,
    }: {
      readonly size: number;
      readonly pieces: readonly unknown[];
    }) =>
      pieces.length === Math.ceil(size / pieceBytes) ||
      `one piece for each ${pieceBytes} bytes of its size`
  ),
  Schema.makeFilter(
    ({ path }: { readonly path: string }) =>
      !path.startsWith("objects/") ||
      "a path outside objects/, which holds keyed files"
  )
);

const overlapping = (paths: readonly string[]) => {
  const seen = new Set<string>();

  for (const path of paths) {
    if (seen.has(path)) {
      return path;
    }

    seen.add(path);
  }

  return paths.find((path) => {
    const parts = path.split("/");

    return parts.some((_, end) => seen.has(parts.slice(0, end).join("/")));
  });
};

const Manifest = Schema.Struct({
  files: Schema.Array(Schema.Union([Keyed, Pieced])).check(
    Schema.makeFilter((files: ReadonlyArray<{ readonly path: string }>) => {
      const path = overlapping(files.map((file) => file.path));

      return (
        path === undefined ||
        `each path once, and none within another file: not ${path}`
      );
    })
  ),
});

type Manifest = typeof Manifest.Type;

const ManifestJson = Schema.fromJsonString(Manifest);

const encodeManifest = Schema.encodeSync(ManifestJson);

const decodeManifest = Schema.decodeUnknownEffect(ManifestJson, {
  onExcessProperty: "error",
});

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
  manifest.files.flatMap((file) =>
    "key" in file
      ? [file.key]
      : file.pieces.flatMap((piece) =>
          piece === null ? [] : [pieceKey(piece)]
        )
  );

const readManifest = (store: Store, name: string) =>
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

export const publish = (
  store: Store,
  local: CheckpointFiles,
  checkpoint: Target
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

    const files = yield* local.checkpointFiles(checkpoint);

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
      manifestKey(checkpoint.name),
      new TextEncoder().encode(encodeManifest({ files: listed }))
    );
    yield* Effect.logInfo(
      `publish ${checkpoint.name} uploaded ${uploaded} bytes for ${files.length} files`
    );
  });

export const fetch = (
  store: Store,
  local: CheckpointFiles,
  checkpoint: Identity,
  from: string,
  build: string
): Effect.Effect<Handle, Internal, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const staged = local.staging(checkpoint);
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

    const placed = (file: Manifest["files"][number]) =>
      Effect.gen(function* () {
        const target = paths.join(staged, file.path);
        const writing = onFile(`couldn't write ${target}`);

        yield* writing(
          fs.makeDirectory(paths.dirname(target), { recursive: true })
        );

        if ("key" in file) {
          const held = yield* local.held(file.key);

          const fromStore = Effect.gen(function* () {
            const bytes = yield* object(file.key);

            if (bytes.length !== file.size) {
              return yield* new Internal({
                message: `build object ${file.key} of ${file.path} holds ${bytes.length} bytes, not the manifest's ${file.size}`,
              });
            }

            yield* writing(fs.writeFile(target, bytes));
          });

          return yield* held === undefined
            ? fromStore
            : fs.link(held, target).pipe(Effect.catch(() => fromStore));
        }

        yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* writing(fs.open(target, { flag: "w" }));

            for (const [index, piece] of file.pieces.entries()) {
              if (piece !== null) {
                const length = Math.min(
                  pieceBytes,
                  file.size - index * pieceBytes
                );

                const bytes = yield* gzipped(
                  yield* object(pieceKey(piece)),
                  new DecompressionStream("gzip")
                );

                if (bytes.length !== length) {
                  return yield* new Internal({
                    message: `build piece ${index} of ${file.path} holds ${bytes.length} bytes, not ${length}`,
                  });
                }

                if ((yield* sha256(bytes)) !== piece) {
                  return yield* new Internal({
                    message: `build piece ${index} of ${file.path} doesn't hash to ${piece}`,
                  });
                }

                yield* writing(
                  handle.seek(BigInt(index * pieceBytes), "start")
                );
                yield* writing(handle.writeAll(bytes));
              }
            }

            yield* writing(handle.truncate(file.size));
          })
        );
      });

    const installed = yield* Effect.gen(function* () {
      yield* onFile(`couldn't make ${staged}`)(
        fs.makeDirectory(staged, { recursive: true })
      );
      yield* Effect.forEach(manifest.files, placed, {
        concurrency,
        discard: true,
      });

      return yield* local.install(checkpoint, staged);
    }).pipe(
      Effect.ensuring(
        Effect.ignore(fs.remove(staged, { recursive: true, force: true }))
      )
    );

    yield* Effect.logInfo(
      `fetch ${build} downloaded ${downloaded} bytes in ${fetched} objects, for ${manifest.files.length} files`
    );

    return installed;
  });

export const unpublish = (
  store: Store,
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

export const throughBucket = (
  store: Store,
  local: CheckpointFiles
): Effect.Effect<SharedBuilds, never, FileSystem.FileSystem | Path.Path> =>
  Effect.map(Effect.context<FileSystem.FileSystem | Path.Path>(), (files) => ({
    shared: true,
    publish: (checkpoint) =>
      Effect.provideContext(publish(store, local, checkpoint), files),
    fetch: (checkpoint, from, build) =>
      Effect.provideContext(
        fetch(store, local, checkpoint, from, build),
        files
      ),
    unpublish: (name) => unpublish(store, name),
  }));
