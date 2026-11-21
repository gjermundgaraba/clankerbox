import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import {
  Capacity,
  Internal,
  Invalid,
  sizedBy,
  Unsizable,
} from "@gjermundgaraba/clankerbox-sdk";
import type {
  HostError,
  Reading,
  Missing,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  Clock,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import type { Scope } from "effect";
import type { HttpClient } from "effect/http";

import {
  CannotStart,
  Handle,
  lastLines,
  missing,
  missingCheckpoint,
  Runtime,
  unshared,
} from "../../runtime.ts";
import type {
  Identity,
  Interface,
  MachineState,
  Observed,
  Origin,
  Sizes,
  Target,
} from "../../runtime.ts";
import type { HostSettings } from "../../settings.ts";
import { KeyedApiUrl, Unanswered } from "../provider-http.ts";
import { rented } from "../tombstones.ts";
import type { Found, MarkedMachine } from "../tombstones.ts";
import * as Api from "./api.ts";
import type {
  ApiError,
  Claim,
  Condition,
  Pod,
  Sandbox,
  Snapshot,
} from "./api.ts";
import * as Channels from "./channels.ts";
import { internal } from "./channels.ts";
import { traits } from "./traits.ts";

const serviceAccount = "/var/run/secrets/kubernetes.io/serviceaccount";

const defaultGuestImage =
  "debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2";

export const AgentSandboxSettings = Schema.Struct({
  namespace: Schema.String,
  api: Schema.optionalKey(KeyedApiUrl),
  tokenFile: Schema.optionalKey(Schema.String),
  caFile: Schema.optionalKey(Schema.String),
  guestImage: Schema.optionalKey(Schema.String),
  storageClass: Schema.optionalKey(Schema.String),
  runtimeClassName: Schema.optionalKey(Schema.String),
  arch: Schema.optionalKey(Schema.String),
  unschedulableSeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0))
  ),
});

export type AgentSandboxSettings = typeof AgentSandboxSettings.Type;

const hostLabel = "cbx-host";

const instanceLabel = "cbx-instance";

const kindLabel = "cbx-kind";

const sourceLabel = "cbx-source";

const tailnetLabel = "cbx-tailnet";

const filledAnnotation = "clankerbox.dev/filled";

const guestContainer = "guest";

const persisted = [
  "usr",
  "etc",
  "var",
  "home",
  "root",
  "opt",
  "srv",
  "mnt",
  "media",
] as const;

const linkedIntoUsr = ["bin", "sbin", "lib", "lib32", "lib64", "libx32"];

const passedOver = ["dev", "proc", "sys", "run", "tmp", "boot"];

const diskMount = "/clankerbox-disk";

// A fill pod's copy is I/O bound; its limits give a namespace's compute quota what to count, which
// it requires of every pod: https://kubernetes.io/docs/concepts/policy/resource-quotas/#compute-resource-quota
const fillResources = {
  requests: { cpu: "100m", memory: "128Mi" },
  limits: { cpu: "1", memory: "512Mi" },
};

const refusedBase = 3;

// The layout a usr-merged base has, whose /bin, /sbin and /lib directories link into /usr:
// https://wiki.debian.org/UsrMerge
const seedScript = [
  "set -eu",
  `to=${diskMount}`,
  `for entry in /*; do`,
  `  name=\${entry#/}`,
  `  case " ${linkedIntoUsr.join(" ")} " in *" $name "*)`,
  `    if [ -L "$entry" ]; then continue; fi`,
  `    echo "the base's /$name is a directory, not a link into /usr: a machine's disk keeps /usr and the directories beside it, so its base is usr-merged, as Debian 12 and Ubuntu 24.04 are" >&2`,
  `    exit ${refusedBase} ;;`,
  "  esac",
  `  case " ${[...persisted, ...passedOver, diskMount.slice(1)].join(" ")} " in *" $name "*) continue ;; esac`,
  `  if [ -d "$entry" ]; then`,
  `    echo "the base has /$name, which a machine's disk wouldn't keep: it keeps ${persisted.map((dir) => `/${dir}`).join(" ")}" >&2`,
  `    exit ${refusedBase}`,
  "  fi",
  "done",
  `rm -rf "$to/root" "$to/root.new"`,
  `mkdir "$to/root.new"`,
  `for name in ${persisted.join(" ")}; do`,
  `  if [ -d "/$name" ]; then cp -a "/$name" "$to/root.new/"; else mkdir "$to/root.new/$name"; fi`,
  "done",
  "sync",
  `mv "$to/root.new" "$to/root"`,
  "sync",
].join("\n");

const graceSeconds = 30;

// A pod's processes share the namespace whose PID 1 is its pause container, which reaps orphans:
// https://kubernetes.io/docs/tasks/configure-pod-container/share-process-namespace/
// `kill -1` signals every process but PID 1 and the sender:
// https://man7.org/linux/man-pages/man2/kill.2.html#DESCRIPTION
// tailscaled opens /dev/net/tun, char 10:200, which a container's /dev lacks and containerd lets it
// make: https://www.kernel.org/doc/html/latest/networking/tuntap.html
const initScript = [
  "stop() {",
  "  kill -TERM -1 2>/dev/null",
  "  while :; do",
  "    left=",
  "    for dir in /proc/[0-9]*; do",
  `      pid=\${dir#/proc/}`,
  `      if [ "$pid" = 1 ] || [ "$pid" = "$$" ]; then continue; fi`,
  `      { read -r line <"$dir/stat"; } 2>/dev/null || continue`,
  `      state=\${line##*) }`,
  "      case $state in Z*) continue ;; esac",
  "      left=1",
  "      break",
  "    done",
  `    if [ -z "$left" ]; then exit 0; fi`,
  "    sleep 1",
  "  done",
  "}",
  "trap stop TERM INT",
  "if [ ! -e /dev/net/tun ]; then",
  "  mkdir -p /dev/net && mknod /dev/net/tun c 10 200 2>/dev/null || true",
  "fi",
  "if [ -e /etc/ssh/sshd_config.d/10-clankerbox.conf ] && [ -x /usr/sbin/sshd ]; then",
  "  mkdir -p /run/sshd",
  "  /usr/sbin/sshd || true",
  "fi",
  "while :; do",
  "  sleep 86400 &",
  "  wait $! || true",
  "done",
].join("\n");

/**
 * A script as a container's command takes it: Kubernetes expands `$(NAME)` there and reads `$$` as
 * `$`, so each `$` is doubled:
 * https://kubernetes.io/docs/tasks/inject-data-application/define-command-argument-container/#use-environment-variables-to-define-arguments
 */
const literally = (script: string): string =>
  script.replaceAll("$", () => "$$");

const pollEvery = Duration.millis(500);

const stopWithin = Duration.seconds(graceSeconds + 90);

const readyWithin = Duration.minutes(10);

const goneWithin = Duration.minutes(2);

const growWithin = Duration.minutes(5);

const fillWithin = (diskGib: number) => Duration.minutes(1 + diskGib);

/**
 * The kubelet's reasons for a container that waits and never starts, as an image it can't pull:
 * https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/kubelet/images/types.go#L29-L41
 * https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/kubelet/kuberuntime/kuberuntime_container.go#L69-L73
 */
const neverStarts = new Set([
  "ErrImagePull",
  "ImagePullBackOff",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
]);

const overQuota = (message: string | undefined) =>
  (message ?? "").includes("exceeded quota");

const failure =
  (what: string) =>
  (error: ApiError | Internal): Internal | Capacity => {
    if (error._tag === "Internal") {
      return error;
    }

    return error._tag === "Refused" &&
      error.status === 403 &&
      overQuota(error.message)
      ? new Capacity({ message: `${what}: ${error.message}` })
      : internal(what)(error);
  };

const conditionOf = (sandbox: Sandbox, type: string): Condition | undefined => {
  const found = sandbox.status?.conditions?.find(
    (condition) => condition.type === type
  );

  return found !== undefined &&
    (found.observedGeneration ?? 0) >= (sandbox.metadata.generation ?? 0)
    ? found
    : undefined;
};

const holds = (sandbox: Sandbox, type: string) =>
  conditionOf(sandbox, type)?.status === "True";

const endedReasons = new Set(["PodFailed", "PodSucceeded"]);

/**
 * How a Sandbox holds its machine, by its conditions as agent-sandbox v1.0.11 sets them for the
 * generation it observed:
 * https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.11/api/v1beta1/sandbox_types.go#L45-L143
 * `ended` is a guest whose pod exited, which a pod that never restarts leaves until a suspend.
 */
type Held = "running" | "stopping" | "stopped" | "ended" | "moving" | "gone";

export const heldOf = (sandbox: Sandbox | undefined): Held => {
  if (
    sandbox === undefined ||
    sandbox.metadata.deletionTimestamp !== undefined
  ) {
    return "gone";
  }

  if (sandbox.spec.operatingMode === "Suspended") {
    return holds(sandbox, "Suspended") ? "stopped" : "stopping";
  }

  if (holds(sandbox, "Ready")) {
    return "running";
  }

  const ready = conditionOf(sandbox, "Ready");

  return ready?.status === "False" && endedReasons.has(ready.reason ?? "")
    ? "ended"
    : "moving";
};

const readAs: Readonly<Record<Held, MachineState>> = {
  running: "running",
  stopping: "stopped",
  stopped: "stopped",
  ended: "stopped",
  moving: "unknown",
  gone: "missing",
};

const live = <
  A extends { readonly metadata: { readonly deletionTimestamp?: string } },
>(
  found: A | undefined
): A | undefined =>
  found?.metadata.deletionTimestamp === undefined ? found : undefined;

const binaryGib = 2 ** 30;

const binaryMib = 2 ** 20;

const amount = (
  of: Readonly<Record<string, string>> | undefined,
  key: string,
  unit: number
): number | undefined => {
  const text = of?.[key];
  const read = text === undefined ? undefined : Api.quantity(text);

  return read === undefined ? undefined : Math.floor(read / unit + 1e-9);
};

const measureOf = (key: string) => {
  if (/cpu/u.test(key)) {
    return { suffix: "milli", unit: 1e-3 };
  }

  return /memory|storage/u.test(key)
    ? { suffix: "mib", unit: binaryMib }
    : { suffix: "", unit: 1 };
};

const readingName = (key: string, suffix: string): string | undefined => {
  const words = key.split(/[^A-Za-z0-9]+/u).filter((word) => word !== "");

  const name = [...words, suffix]
    .map((word, at) =>
      at === 0
        ? word.toLowerCase()
        : `${word[0]?.toUpperCase() ?? ""}${word.slice(1).toLowerCase()}`
    )
    .join("");

  return /^[a-z][A-Za-z0-9]{0,31}$/u.test(name) ? name : undefined;
};

const readings = (quotas: readonly Api.Quota[]): Reading[] => {
  const least = new Map<
    string,
    Reading & { readonly limit: number; readonly used: number }
  >();

  for (const quota of quotas) {
    for (const key of Object.keys(quota.status?.hard ?? {})) {
      const { suffix, unit } = measureOf(key);
      const name = readingName(key, suffix);
      const limit = amount(quota.status?.hard, key, unit);
      const used = amount(quota.status?.used, key, unit) ?? 0;
      const kept = name === undefined ? undefined : least.get(name);

      if (
        name !== undefined &&
        limit !== undefined &&
        (kept === undefined || limit - used < kept.limit - kept.used)
      ) {
        least.set(name, { resource: name, used, limit });
      }
    }
  }

  return [...least.values()];
};

const argvOf = ({
  argv,
  user,
}: {
  readonly argv: readonly string[];
  readonly user?: string | undefined;
}) =>
  user === undefined ? argv : ["sudo", "-n", "-u", user, "-H", "--", ...argv];

const filled = (claim: Claim) =>
  claim.metadata.annotations?.[filledAnnotation] === "true";

const unschedulable = (conditions: readonly Condition[] | undefined) =>
  conditions?.find(
    ({ type, status, reason }) =>
      type === "PodScheduled" &&
      status === "False" &&
      reason === "Unschedulable"
  );

/**
 * A claim's size: its capacity, or, once the controller has expanded the volume and only the next
 * mount's filesystem resize is left, the size it expanded it to, as capacity stays the old one
 * until then:
 * https://github.com/kubernetes/api/blob/v0.34.0/core/v1/types.go#L680-L698
 */
const diskGibOf = (claim: Claim | undefined) => {
  const resizing = claim?.status?.allocatedResourceStatuses?.["storage"];

  return (
    (resizing === "NodeResizePending" || resizing === "NodeResizeInProgress"
      ? amount(claim?.status?.allocatedResources, "storage", binaryGib)
      : undefined) ??
    amount(claim?.status?.capacity, "storage", binaryGib) ??
    amount(claim?.spec.resources?.requests, "storage", binaryGib)
  );
};

/**
 * Whether the resizer gave up on a claim's growth:
 * https://github.com/kubernetes/api/blob/v0.34.0/core/v1/types.go#L680-L698
 */
const ungrowable = (claim: Claim, diskGib: number) => {
  const allocated = amount(
    claim.status?.allocatedResources,
    "storage",
    binaryGib
  );

  return (
    claim.status?.allocatedResourceStatuses?.["storage"]?.endsWith(
      "ResizeInfeasible"
    ) === true &&
    (allocated === undefined || allocated === diskGib)
  );
};

const sizesOf = (sandbox: Sandbox | undefined, claim: Claim | undefined) => {
  const limits = sandbox?.spec.podTemplate.spec.containers.find(
    ({ name }) => name === guestContainer
  )?.resources?.limits;

  return {
    cpu: amount(limits, "cpu", 1),
    ramMib: amount(limits, "memory", binaryMib),
    diskGib: diskGibOf(claim),
  };
};

const caOf = (settings: AgentSandboxSettings) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = settings.caFile ?? `${serviceAccount}/ca.crt`;

    return yield* fs.readFileString(file).pipe(
      Effect.mapError(
        (error) =>
          new CannotStart({
            message: `couldn't read the cluster's CA from ${file}: ${error.message}`,
          })
      )
    );
  });

const awaited = <A, E>(
  reading: Effect.Effect<A, E>,
  rests: (found: A) => boolean,
  within: Duration.Duration,
  what: string
): Effect.Effect<A, E | Internal> =>
  Effect.repeat(reading, {
    until: rests,
    schedule: Schedule.spaced(pollEvery).pipe(
      Schedule.upTo({ duration: within })
    ),
  }).pipe(
    Effect.filterOrFail(
      rests,
      () =>
        new Internal({
          message: `${what} didn't end within ${Duration.format(within)}`,
        })
    )
  );

const gone = (
  kind: {
    readonly get: (
      name: string
    ) => Effect.Effect<
      { readonly metadata: { readonly uid: string } } | undefined,
      ApiError
    >;
  },
  name: string,
  uid: string
) =>
  awaited(
    kind.get(name),
    (left) => left === undefined || left.metadata.uid !== uid,
    goneWithin,
    `the delete of ${name}`
  );

export const make = (
  settings: AgentSandboxSettings,
  host: Pick<HostSettings, "id" | "stateDir" | "listen">
): Effect.Effect<
  Interface,
  HostError | CannotStart,
  FileSystem.FileSystem | HttpClient.HttpClient | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { namespace } = settings;
    const tokenFile = settings.tokenFile ?? `${serviceAccount}/token`;
    const url = settings.api ?? "https://kubernetes.default.svc";
    const guestImage = settings.guestImage ?? defaultGuestImage;

    const unschedulableFor = Duration.seconds(
      settings.unschedulableSeconds ?? 120
    );

    const readToken = Effect.mapError(
      Effect.map(fs.readFileString(tokenFile), (text) =>
        Redacted.make(text.trim())
      ),
      (error) =>
        new Unanswered({
          message: `couldn't read the service account's token from ${tokenFile}: ${error.message}`,
        })
    );

    const token = yield* Effect.cachedWithTTL(readToken, (exit) =>
      Exit.isSuccess(exit) ? Duration.minutes(1) : Duration.zero
    );

    yield* Effect.mapError(
      token,
      (error) => new CannotStart({ message: error.message })
    );

    const endpoint: Channels.Endpoint = {
      api: url,
      token: Effect.mapError(token, internal("agent-sandbox")),
      ca: yield* caOf(settings),
    };

    const api = yield* Api.make(url, token);
    const paths = Api.paths(namespace);
    const sandboxes = api.resource(paths.sandboxes, Api.Sandbox);
    const claims = api.resource(paths.claims, Api.Claim);
    const pods = api.resource(paths.pods, Api.Pod);
    const snapshots = api.resource(paths.snapshots, Api.Snapshot);
    const quotas = api.resource(paths.quotas, Api.Quota);

    yield* api.served.pipe(
      Effect.mapError(
        (error) =>
          new CannotStart({
            message: `the cluster at ${url} serves no agents.x-k8s.io/v1beta1, the agent-sandbox controller's API, of v1.0 or later: ${error.message}`,
          })
      )
    );

    yield* Effect.all(
      [sandboxes.list({}), claims.list({}), pods.list({}), snapshots.list({})],
      { discard: true }
    ).pipe(
      Effect.mapError(
        (error) =>
          new CannotStart({
            message: `couldn't list the sandboxes, persistent volume claims, pods and volume snapshots of namespace ${namespace}: grant the host's service account there what README's agent-sandbox row lists: ${error.message}`,
          })
      )
    );

    const mark = { [hostLabel]: host.id };

    const machineName = (instance: string) => `cbx-${host.id}-${instance}`;

    const diskName = (instance: string) => `${machineName(instance)}-disk`;

    const fillName = (instance: string) => `${machineName(instance)}-fill`;

    const checkpointName = (instance: string) =>
      `${machineName(instance)}-checkpoint`;

    const copyName = (instance: string) => `${machineName(instance)}-copy`;

    const labelsOf = (
      instance: string,
      kind: string,
      more: Readonly<Record<string, string>> = {}
    ) => ({ ...mark, [instanceLabel]: instance, [kindLabel]: kind, ...more });

    const ours = (
      found: {
        readonly metadata: {
          readonly labels?: Readonly<Record<string, string>>;
        };
      },
      instance: string
    ) =>
      found.metadata.labels?.[hostLabel] === host.id &&
      found.metadata.labels[instanceLabel] === instance;

    const owned = <A extends { readonly metadata: Api.Sandbox["metadata"] }>(
      found: A | undefined,
      instance: string
    ) => (found !== undefined && ours(found, instance) ? found : undefined);

    const read = (machine: Target) =>
      sandboxes.get(machine.handle).pipe(
        Effect.map((found) => owned(found, machine.instance)),
        Effect.mapError(internal(`couldn't read machine ${machine.name}`))
      );

    const created = <A extends { readonly metadata: Api.Sandbox["metadata"] }>(
      kind: {
        readonly get: (name: string) => Effect.Effect<A | undefined, ApiError>;
        readonly create: (body: unknown) => Effect.Effect<A, ApiError>;
      },
      name: string,
      instance: string,
      body: unknown
    ): Effect.Effect<A, ApiError | Internal> =>
      kind.create(body).pipe(
        Effect.catchIf(Api.isTaken, () =>
          Effect.gen(function* () {
            const found = yield* kind.get(name);

            if (found !== undefined) {
              if (!ours(found, instance)) {
                return yield* new Internal({
                  message: `${name} is taken by an object this host didn't make for instance ${instance}`,
                });
              }

              if (live(found) !== undefined) {
                return found;
              }

              yield* gone(kind, name, found.metadata.uid);
            }

            return yield* created(kind, name, instance, body);
          })
        )
      );

    const removed = <A extends { readonly metadata: Api.Sandbox["metadata"] }>(
      kind: {
        readonly get: (name: string) => Effect.Effect<A | undefined, ApiError>;
        readonly remove: (
          name: string,
          uid: string
        ) => Effect.Effect<void, ApiError>;
      },
      name: string,
      instance: string
    ): Effect.Effect<string | undefined, ApiError> =>
      Effect.flatMap(kind.get(name), (found) =>
        found === undefined || !ours(found, instance)
          ? Effect.undefined
          : kind.remove(name, found.metadata.uid).pipe(
              Effect.as(found.metadata.uid),
              Effect.catchIf(Api.isReplaced, () => Effect.undefined)
            )
      );

    // A disk holds the binaries of the architecture it was seeded on, so every pod that fills or
    // boots one runs there: https://kubernetes.io/docs/reference/labels-annotations-taints/#kubernetes-io-arch
    const placed = {
      nodeSelector: { "kubernetes.io/arch": settings.arch ?? "amd64" },
      ...(settings.runtimeClassName === undefined
        ? {}
        : { runtimeClassName: settings.runtimeClassName }),
    };

    const podTemplateOf = (machine: Identity & Sizes, tailnet: boolean) => {
      const sized = {
        cpu: String(machine.cpu),
        memory: `${machine.ramMib}Mi`,
      };

      return {
        metadata: { labels: labelsOf(machine.instance, "guest") },
        spec: {
          hostname: machine.name.toLowerCase(),
          restartPolicy: "Never",
          shareProcessNamespace: true,
          terminationGracePeriodSeconds: graceSeconds,
          enableServiceLinks: false,
          automountServiceAccountToken: false,
          ...placed,
          containers: [
            {
              name: guestContainer,
              image: guestImage,
              command: [
                "/bin/sh",
                "-c",
                literally(initScript),
                "clankerbox-init",
              ],
              resources: { requests: sized, limits: sized },
              securityContext: {
                readOnlyRootFilesystem: true,
                ...(tailnet ? { capabilities: { add: ["NET_ADMIN"] } } : {}),
              },
              volumeMounts: [
                ...persisted.map((dir) => ({
                  name: "disk",
                  mountPath: `/${dir}`,
                  subPath: `root/${dir}`,
                })),
                { name: "run", mountPath: "/run" },
                { name: "tmp", mountPath: "/tmp" },
              ],
            },
          ],
          volumes: [
            {
              name: "disk",
              persistentVolumeClaim: { claimName: diskName(machine.instance) },
            },
            { name: "run", emptyDir: { medium: "Memory" } },
            { name: "tmp", emptyDir: {} },
          ],
        },
      };
    };

    const seedPodOf = (
      target: {
        readonly instance: string;
        readonly claim: string;
      },
      image: string
    ) => ({
      metadata: {
        name: fillName(target.instance),
        labels: labelsOf(target.instance, "fill-disk"),
      },
      spec: {
        restartPolicy: "Never",
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        terminationGracePeriodSeconds: 5,
        ...placed,
        containers: [
          {
            name: "fill",
            image,
            command: ["/bin/sh", "-c", literally(seedScript)],
            terminationMessagePolicy: "FallbackToLogsOnError",
            resources: fillResources,
            securityContext: { runAsUser: 0, runAsGroup: 0 },
            volumeMounts: [{ name: "to", mountPath: diskMount }],
          },
        ],
        volumes: [
          { name: "to", persistentVolumeClaim: { claimName: target.claim } },
        ],
      },
    });

    const unrunnable = (
      what: string,
      pod: Pod | undefined
    ): Effect.Effect<void, Internal | Capacity> => {
      const pulling = pod?.status?.containerStatuses?.find(({ state }) =>
        neverStarts.has(state?.waiting?.reason ?? "")
      )?.state?.waiting;

      if (pulling !== undefined) {
        return Effect.fail(
          new Internal({
            message: `${what}: ${pulling.reason ?? ""}: ${pulling.message ?? ""}`,
          })
        );
      }

      const stuck = unschedulable(pod?.status?.conditions);

      if (stuck === undefined) {
        return Effect.void;
      }

      const since = Date.parse(stuck.lastTransitionTime ?? "");

      return Effect.flatMap(Clock.currentTimeMillis, (now) =>
        now - since >= Duration.toMillis(unschedulableFor)
          ? Effect.fail(
              new Capacity({
                message: `${what}: the cluster scheduled it nowhere for ${Duration.format(unschedulableFor)}: ${stuck.message ?? ""}`,
              })
            )
          : Effect.void
      );
    };

    const seeded = (
      target: {
        readonly instance: string;
        readonly claim: string;
        readonly diskGib: number;
      },
      image: string
    ): Effect.Effect<void, Internal | Capacity | Invalid> =>
      Effect.gen(function* () {
        const name = fillName(target.instance);
        const what = `fill ${target.claim}`;

        const claim = owned(
          yield* Effect.mapError(claims.get(target.claim), internal(what)),
          target.instance
        );

        if (claim === undefined) {
          return yield* new Internal({
            message: `${what}: its claim is gone or isn't this host's`,
          });
        }

        if (filled(claim)) {
          return;
        }

        const cleared = Effect.mapError(
          Effect.flatMap(removed(pods, name, target.instance), (uid) =>
            uid === undefined
              ? Effect.void
              : Effect.asVoid(gone(pods, name, uid))
          ),
          internal(what)
        );

        yield* cleared;

        const still = yield* Effect.mapError(
          claims.get(target.claim),
          internal(what)
        );

        if (still?.metadata.uid !== claim.metadata.uid) {
          return yield* new Internal({
            message: `${what}: its claim was replaced`,
          });
        }

        yield* created(
          pods,
          name,
          target.instance,
          seedPodOf(target, image)
        ).pipe(Effect.mapError(failure(what)));

        const pod = yield* awaited(
          Effect.tap(Effect.mapError(pods.get(name), internal(what)), (found) =>
            unrunnable(what, found)
          ),
          (found) =>
            found === undefined ||
            found.status?.phase === "Succeeded" ||
            found.status?.phase === "Failed",
          fillWithin(target.diskGib),
          what
        );

        if (pod?.status?.phase !== "Succeeded") {
          const ended = pod?.status?.containerStatuses?.[0]?.state?.terminated;

          if (ended?.exitCode === refusedBase) {
            yield* cleared;

            return yield* new Invalid({
              message: `image ${image} can't be a machine's base: ${lastLines(ended.message ?? "")}`,
            });
          }

          return yield* new Internal({
            message: `${what}: ${pod === undefined ? "its pod is gone" : `its pod exited ${ended?.exitCode ?? "unknown"}: ${lastLines(ended?.message ?? "")}`}`,
          });
        }

        yield* cleared;
        yield* claims
          .patch(target.claim, claim.metadata.uid, {
            metadata: { annotations: { [filledAnnotation]: "true" } },
          })
          .pipe(Effect.mapError(internal(what)));
      });

    // A snapshot of a claim in use is the CSI driver's to take, and a restore of one is a new
    // claim whose `dataSource` names it:
    // https://kubernetes.io/docs/concepts/storage/volume-snapshots/#volume-snapshot-contents
    // https://kubernetes.io/docs/concepts/storage/persistent-volumes/#volume-snapshot-and-restore-volume-from-snapshot-support
    const snapshotted = (
      name: string,
      instance: string,
      labels: Readonly<Record<string, string>>,
      from: Claim,
      diskGib: number
    ): Effect.Effect<void, Internal | Capacity> =>
      Effect.gen(function* () {
        const what = `snapshot ${from.metadata.name}`;

        yield* created(snapshots, name, instance, {
          apiVersion: "snapshot.storage.k8s.io/v1",
          kind: "VolumeSnapshot",
          metadata: { name, labels },
          spec: { source: { persistentVolumeClaimName: from.metadata.name } },
        }).pipe(Effect.mapError(failure(what)));

        const taken = yield* awaited(
          Effect.mapError(snapshots.get(name), internal(what)),
          (found) =>
            found === undefined ||
            found.status?.readyToUse === true ||
            found.status?.error !== undefined,
          fillWithin(diskGib),
          what
        );

        if (taken?.status?.readyToUse !== true) {
          return yield* new Internal({
            message: `${what}: ${taken === undefined ? "the snapshot is gone" : `the cluster failed it: ${taken.status?.error?.message ?? ""}`}`,
          });
        }

        const source = yield* Effect.mapError(
          claims.get(from.metadata.name),
          internal(what)
        );

        if (source?.metadata.uid !== from.metadata.uid) {
          return yield* new Internal({
            message: `${what}: the claim was replaced while it was snapshotted`,
          });
        }
      });

    const claimed = (
      name: string,
      instance: string,
      labels: Readonly<Record<string, string>>,
      diskGib: number,
      snapshot?: string
    ) =>
      created(claims, name, instance, {
        metadata: {
          name,
          labels,
          ...(snapshot === undefined
            ? {}
            : { annotations: { [filledAnnotation]: "true" } }),
        },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: `${diskGib}Gi` } },
          ...(settings.storageClass === undefined
            ? {}
            : { storageClassName: settings.storageClass }),
          ...(snapshot === undefined
            ? {}
            : {
                dataSource: {
                  apiGroup: "snapshot.storage.k8s.io",
                  kind: "VolumeSnapshot",
                  name: snapshot,
                },
              }),
        },
      }).pipe(Effect.mapError(failure(`make ${name}`)));

    const ready = (machine: Target, what: string) =>
      Effect.gen(function* () {
        const sandbox = yield* awaited(
          Effect.gen(function* () {
            const found = yield* read(machine);
            const held = heldOf(found);

            if (held === "moving" && found !== undefined) {
              const reconciling = conditionOf(found, "Ready");

              const refused =
                reconciling?.reason === "ReconcilerError"
                  ? (reconciling.message ?? "")
                  : "";

              if (overQuota(refused)) {
                return yield* new Capacity({ message: `${what}: ${refused}` });
              }

              // The controller's create of the pod met admission's 403, as Pod Security's:
              // https://kubernetes.io/docs/concepts/security/pod-security-admission/
              if (refused.includes(" is forbidden: ")) {
                return yield* new Internal({
                  message: `${what}: the cluster refused its pod: ${refused}`,
                });
              }

              yield* unrunnable(
                what,
                yield* Effect.mapError(pods.get(machine.handle), internal(what))
              );
            }

            return found;
          }),
          (found) => heldOf(found) !== "moving",
          readyWithin,
          what
        );

        switch (heldOf(sandbox)) {
          case "running": {
            return;
          }

          case "gone": {
            return yield* missing(traits.runtime, machine);
          }

          case "ended": {
            const pod = yield* Effect.mapError(
              pods.get(machine.handle),
              internal(what)
            );

            const ended = pod?.status?.containerStatuses?.find(
              ({ name }) => name === guestContainer
            )?.state?.terminated;

            return yield* new Internal({
              message: `${what}: its guest exited ${ended?.exitCode ?? "unknown"}: ${lastLines(ended?.message ?? ended?.reason ?? "")}`,
            });
          }

          case "moving": {
            return yield* new Internal({
              message: `${what}: it didn't settle within ${Duration.format(readyWithin)}`,
            });
          }

          case "stopping":
          case "stopped": {
            return yield* new Internal({
              message: `${what}: the machine was stopped meanwhile`,
            });
          }
        }
      });

    const operatingMode = (machine: Target, mode: "Running" | "Suspended") =>
      Effect.flatMap(read(machine), (found) =>
        found === undefined
          ? Effect.void
          : sandboxes
              .patch(machine.handle, found.metadata.uid, {
                spec: { operatingMode: mode },
              })
              .pipe(
                Effect.catchIf(
                  (error) => Api.isGone(error) || Api.isReplaced(error),
                  () => Effect.void
                ),
                Effect.mapError(
                  internal(`couldn't set ${machine.name} ${mode}`)
                )
              )
      );

    const stopped = (machine: Target) =>
      Effect.gen(function* () {
        yield* operatingMode(machine, "Suspended");
        yield* awaited(
          read(machine),
          (found) => {
            const held = heldOf(found);

            return held === "stopped" || held === "gone";
          },
          stopWithin,
          `stop ${machine.name}`
        );
      }).pipe(Effect.uninterruptible);

    // Kubernetes mounts a claim by its name alone, so a guest boots only once its own disk is
    // there: https://kubernetes.io/docs/concepts/storage/persistent-volumes/#claims-as-volumes
    const diskHeld = (machine: Identity) =>
      claims.get(diskName(machine.instance)).pipe(
        Effect.mapError(internal(`couldn't read ${machine.name}'s disk`)),
        Effect.flatMap((found) => {
          const held = live(owned(found, machine.instance));

          return held !== undefined && filled(held)
            ? Effect.void
            : Effect.fail(missing(traits.runtime, machine));
        })
      );

    const sourceDisk = (source: Target) =>
      Effect.gen(function* () {
        const claim = live(
          owned(
            yield* claims
              .get(diskName(source.instance))
              .pipe(Effect.mapError(internal(`copy ${source.name}'s disk`))),
            source.instance
          )
        );

        const diskGib = diskGibOf(claim);

        if (claim === undefined || diskGib === undefined) {
          return yield* missing(traits.runtime, source);
        }

        return { claim, diskGib };
      });

    const dropped = (instance: string) =>
      Effect.all(
        [
          removed(pods, fillName(instance), instance),
          removed(claims, checkpointName(instance), instance),
          removed(snapshots, checkpointName(instance), instance),
        ],
        { discard: true }
      );

    const prune = (machine: Target, keep: ReadonlySet<Handle>) =>
      Effect.gen(function* () {
        const selector = {
          ...mark,
          [kindLabel]: "checkpoint",
          [sourceLabel]: machine.instance,
        };

        const held = yield* Effect.all([
          claims.list(selector),
          snapshots.list(selector),
        ]);

        yield* Effect.forEach(
          new Set(
            held
              .flat()
              .flatMap(({ metadata }) =>
                keep.has(Handle.make(metadata.name))
                  ? []
                  : (metadata.labels?.[instanceLabel] ?? [])
              )
          ),
          dropped,
          { discard: true }
        );
      }).pipe(
        Effect.mapError(
          internal(`couldn't prune ${machine.name}'s checkpoints`)
        )
      );

    const markedMachines = Effect.gen(function* () {
      const [machines, held, fills, taken] = yield* Effect.all([
        sandboxes.list(mark),
        claims.list(mark),
        pods.list({ ...mark, [kindLabel]: "fill-disk" }),
        snapshots.list(mark),
      ]);

      const kindOf = ({
        metadata,
      }: {
        readonly metadata: {
          readonly labels?: Readonly<Record<string, string>>;
        };
      }) => metadata.labels?.[kindLabel];

      const checkpoints = [...held, ...taken].filter(
        (each) => kindOf(each) === "checkpoint"
      );

      const instances = new Set(
        [
          ...machines,
          ...held.filter((each) => kindOf(each) === "disk"),
          ...fills,
          ...taken.filter((each) => kindOf(each) === "copy"),
        ].flatMap(({ metadata }) => metadata.labels?.[instanceLabel] ?? [])
      );

      return [...instances].map((instance): MarkedMachine => ({
        instance,
        handle: Handle.make(machineName(instance)),
        checkpoints: [
          ...new Set(
            checkpoints.flatMap(({ metadata }) =>
              metadata.labels?.[sourceLabel] === instance
                ? [Handle.make(metadata.name)]
                : []
            )
          ),
        ],
      }));
    }).pipe(Effect.mapError(internal("couldn't list what this host marked")));

    type DiskSource =
      | { readonly _tag: "seed"; readonly image: string }
      | { readonly _tag: "snapshot"; readonly name: string }
      | {
          readonly _tag: "claim";
          readonly claim: Claim;
          readonly diskGib: number;
        };

    const diskSourceOf = (
      origin: Origin
    ): Effect.Effect<DiskSource, Internal | Missing> => {
      switch (origin._tag) {
        case "image": {
          return Effect.succeed({ _tag: "seed", image: origin.image });
        }

        case "machine": {
          return Effect.map(
            sourceDisk(origin.machine),
            ({ claim, diskGib }): DiskSource => ({
              _tag: "claim",
              claim,
              diskGib,
            })
          );
        }

        case "checkpoint": {
          const { checkpoint } = origin;

          return Effect.all([
            snapshots.get(checkpoint.handle),
            claims.get(checkpoint.handle),
          ]).pipe(
            Effect.mapError(
              internal(`couldn't read checkpoint ${checkpoint.name}`)
            ),
            Effect.flatMap(([snapshot, claim]) => {
              const taken: Snapshot | undefined = live(
                owned(snapshot, checkpoint.instance)
              );

              if (taken?.status?.readyToUse === true) {
                return Effect.succeed<DiskSource>({
                  _tag: "snapshot",
                  name: checkpoint.handle,
                });
              }

              const held = live(owned(claim, checkpoint.instance));
              const diskGib = diskGibOf(held);

              return held !== undefined && filled(held) && diskGib !== undefined
                ? Effect.succeed<DiskSource>({
                    _tag: "claim",
                    claim: held,
                    diskGib,
                  })
                : Effect.fail(missingCheckpoint(traits.runtime, checkpoint));
            })
          );
        }
      }
    };

    const runtime: Found = {
      traits,
      guest: "debian",
      kernel: "shared",
      version: "agents.x-k8s.io/v1beta1",
      pin: undefined,
      prepares: "always",
      admission: undefined,
      builds: unshared(traits.runtime),
      reach: {
        _tag: "relayed",
        address: host.listen.address,
        dial: (machine) =>
          Channels.forward(endpoint, { namespace, name: machine.handle }, 22),
      },
      startup: Effect.void,
      sizable: () => Effect.void,
      find: (machine) =>
        Effect.gen(function* () {
          const found = yield* Effect.all([
            sandboxes.get(machineName(machine.instance)),
            claims.get(diskName(machine.instance)),
            pods.get(fillName(machine.instance)),
            snapshots.get(copyName(machine.instance)),
          ]);

          return found.some((each) => {
            const held = live(each);

            return held !== undefined && ours(held, machine.instance);
          })
            ? Handle.make(machineName(machine.instance))
            : undefined;
        }).pipe(
          Effect.mapError(internal(`couldn't search for ${machine.name}`))
        ),
      checkpointHandle: (checkpoint) =>
        Handle.make(checkpointName(checkpoint.instance)),
      observe: (machines) => {
        const [only] = machines;

        if (machines.length === 1 && only !== undefined) {
          return Effect.map(
            read(only),
            (found): Observed =>
              new Map([[only.name, { state: readAs[heldOf(found)] }]])
          );
        }

        return sandboxes.list(mark).pipe(
          Effect.map((found): Observed => {
            const byName = new Map(
              found.map((each) => [each.metadata.name, each])
            );

            return new Map(
              machines.map((machine) => [
                machine.name,
                {
                  state:
                    readAs[
                      heldOf(
                        owned(byName.get(machine.handle), machine.instance)
                      )
                    ],
                },
              ])
            );
          }),
          Effect.mapError(internal("couldn't list this host's machines"))
        );
      },
      capacity: () =>
        quotas
          .list({})
          .pipe(
            Effect.map(readings),
            Effect.mapError(
              internal(`couldn't read namespace ${namespace}'s quotas`)
            )
          ),
      make: (machine, origin, _port, tailnet = false) =>
        Effect.gen(function* () {
          const handle = Handle.make(machineName(machine.instance));
          const target = { ...machine, handle };
          const source = yield* diskSourceOf(origin);
          const disk = diskName(machine.instance);
          const copy = copyName(machine.instance);
          const labels = labelsOf(machine.instance, "disk");

          switch (source._tag) {
            case "seed": {
              yield* claimed(disk, machine.instance, labels, machine.diskGib);
              yield* seeded(
                {
                  instance: machine.instance,
                  claim: disk,
                  diskGib: machine.diskGib,
                },
                source.image
              );
              break;
            }

            case "snapshot": {
              yield* claimed(
                disk,
                machine.instance,
                labels,
                machine.diskGib,
                source.name
              );
              break;
            }

            case "claim": {
              yield* snapshotted(
                copy,
                machine.instance,
                labelsOf(machine.instance, "copy"),
                source.claim,
                source.diskGib
              );
              yield* claimed(
                disk,
                machine.instance,
                labels,
                machine.diskGib,
                copy
              );
            }
          }

          yield* diskHeld(machine);

          yield* created(sandboxes, handle, machine.instance, {
            apiVersion: "agents.x-k8s.io/v1beta1",
            kind: "Sandbox",
            metadata: {
              name: handle,
              labels: labelsOf(
                machine.instance,
                "machine",
                tailnet ? { [tailnetLabel]: "true" } : {}
              ),
            },
            spec: {
              operatingMode: "Running",
              failedPodPolicy: "Retain",
              podTemplate: podTemplateOf(machine, tailnet),
            },
          }).pipe(Effect.mapError(failure(`make ${machine.name}`)));

          yield* ready(target, `make ${machine.name}`);

          if (source._tag === "claim") {
            yield* removed(snapshots, copy, machine.instance).pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  `couldn't delete ${copy}, so the machine's delete does: ${error.message}`
                )
              )
            );
          }

          return {
            handle,
            sizes: {
              cpu: machine.cpu,
              ramMib: machine.ramMib,
              diskGib: machine.diskGib,
            },
          };
        }),
      start: (machine, keep) =>
        Effect.gen(function* () {
          const held = heldOf(yield* read(machine));

          if (held === "gone") {
            return yield* missing(traits.runtime, machine);
          }

          if (held === "ended" || held === "stopping") {
            yield* stopped(machine);
          }

          if (held !== "running") {
            yield* diskHeld(machine);
            yield* operatingMode(machine, "Running");
          }

          yield* ready(machine, `start ${machine.name}`);
          yield* prune(machine, keep).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `${error.message}, so the machine's next start or delete prunes it`
              )
            )
          );
        }),
      stop: stopped,
      delete: (machine, keep) =>
        Effect.gen(function* () {
          yield* prune(machine, keep);
          yield* Effect.mapError(
            Effect.all(
              [
                removed(sandboxes, machine.handle, machine.instance),
                removed(pods, fillName(machine.instance), machine.instance),
                removed(
                  snapshots,
                  copyName(machine.instance),
                  machine.instance
                ),
                removed(claims, diskName(machine.instance), machine.instance),
              ],
              { discard: true }
            ),
            internal(`couldn't delete ${machine.name}`)
          );
        }),
      capture: (machine, checkpoint) =>
        Effect.gen(function* () {
          const name = checkpointName(checkpoint.instance);
          const { claim, diskGib } = yield* sourceDisk(machine);

          yield* snapshotted(
            name,
            checkpoint.instance,
            labelsOf(checkpoint.instance, "checkpoint", {
              [sourceLabel]: machine.instance,
            }),
            claim,
            diskGib
          );

          return Handle.make(name);
        }),
      resize: (machine, to) =>
        Effect.gen(function* () {
          const what = `resize ${machine.name}`;

          const { diskGib } = to;

          if (diskGib !== undefined) {
            const disk = diskName(machine.instance);

            const own = Effect.map(
              Effect.mapError(claims.get(disk), internal(what)),
              (found) => owned(found, machine.instance)
            );

            const lost = new Internal({ message: `${what}: its disk is gone` });
            const before = yield* own;

            if (before === undefined) {
              return yield* lost;
            }

            yield* claims
              .patch(disk, before.metadata.uid, {
                spec: {
                  resources: { requests: { storage: `${diskGib}Gi` } },
                },
              })
              .pipe(
                Effect.mapError((error) => {
                  if (Api.isGone(error) || Api.isReplaced(error)) {
                    return lost;
                  }

                  return error._tag === "Refused" &&
                    (error.status === 403 || error.status === 422)
                    ? new Unsizable({
                        message: `the cluster grows no disk of ${machine.name}: ${error.message}`,
                      })
                    : internal(what)(error);
                })
              );

            const claim = yield* awaited(
              own,
              (found) =>
                found?.metadata.uid !== before.metadata.uid ||
                ungrowable(found, diskGib) ||
                (diskGibOf(found) ?? 0) >= diskGib,
              growWithin,
              `the growth of ${machine.name}'s disk`
            );

            if (claim?.metadata.uid !== before.metadata.uid) {
              return yield* lost;
            }

            if (ungrowable(claim, diskGib)) {
              return yield* new Unsizable({
                message: `the cluster couldn't grow the disk of ${machine.name} to ${diskGib} GiB`,
              });
            }
          }

          if (to.cpu !== undefined || to.ramMib !== undefined) {
            const found = yield* read(machine);

            if (found === undefined) {
              return yield* new Internal({ message: `${what}: it is gone` });
            }

            yield* sandboxes
              .patch(machine.handle, found.metadata.uid, {
                spec: {
                  podTemplate: podTemplateOf(
                    { ...machine, ...sizedBy(machine, to) },
                    found.metadata.labels?.[tailnetLabel] === "true"
                  ),
                },
              })
              .pipe(
                Effect.mapError((error) =>
                  Api.isGone(error) || Api.isReplaced(error)
                    ? new Internal({ message: `${what}: it is gone` })
                    : internal(what)(error)
                )
              );
          }
        }),
      sizes: (machine) =>
        Effect.gen(function* () {
          const [sandbox, claim] = yield* Effect.all([
            sandboxes.get(machine.handle),
            claims.get(diskName(machine.instance)),
          ]);

          return sizesOf(
            owned(sandbox, machine.instance),
            owned(claim, machine.instance)
          );
        }).pipe(
          Effect.mapError(internal(`couldn't read ${machine.name}'s sizes`))
        ),
      deleteCheckpoint: (checkpoint) =>
        dropped(checkpoint.instance).pipe(
          Effect.mapError(
            internal(`couldn't delete checkpoint ${checkpoint.name}`)
          )
        ),
      exec: (machine, command) =>
        Channels.exec(
          endpoint,
          { namespace, name: machine.handle },
          guestContainer,
          argvOf(command),
          command.stdin
        ),
    };

    return yield* rented(runtime, {
      dir: `${host.stateDir}/agent-sandbox`,
      marked: markedMachines,
    });
  });

/**
 * The API server's client, over HTTP/1.1. Over HTTP/2, which undici offers by default, the Agent's
 * destroy as its scope closes sometimes threw an uncaught `ClientDestroyedError` after the kind
 * suite's stall cases. That was never caught in the act, so HTTP/1.1 is a reasoned fix, not a proven
 * one: it leaves out the path where Node hands that error to every stream an HTTP/2 session still
 * tracks. `tests/kind/teardown-error.md` holds the hunt.
 */
export const httpLayer = (settings: AgentSandboxSettings) =>
  Layer.unwrap(
    Effect.map(caOf(settings), (ca) =>
      NodeHttpClient.layerUndiciOptions({ allowH2: false, connect: { ca } })
    )
  );

export const layer = (
  settings: AgentSandboxSettings,
  host: HostSettings
): Layer.Layer<Runtime, HostError | CannotStart, FileSystem.FileSystem> =>
  Layer.effect(Runtime, make(settings, host)).pipe(
    Layer.provide(httpLayer(settings))
  );
