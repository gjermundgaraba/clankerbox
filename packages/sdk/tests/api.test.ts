import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Schema } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { type StubHost, stubHost } from "./stub-host.ts";

let host: StubHost | undefined;

afterEach(async () => {
  await host?.dispose();
  host = undefined;
});

/** Input that doesn't decode is effect-actions' own `InvalidInput`; the client maps it to `Invalid`. */
const decodeInvalidInput = Schema.decodeUnknownSync(Schema.fromJsonString(Action.InvalidInput));

const post = async (path: string, body: Schema.Json) => {
  host = stubHost({ id: "linux", bases: ["ubuntu"] });

  const response = await host.handler(
    new Request(`http://linux.test/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

  return { status: response.status, body: await response.text() };
};

const create = { id: "linux_dev", base: "ubuntu", cpu: 1, ramMib: 1024, diskGib: 10 };

test("a valid call is answered", async () => {
  const { status } = await post("createMachine", create);

  expect(status).toBe(200);
});

test("an undeclared field is refused with InvalidInput, before the handler runs", async () => {
  const { status, body } = await post("createMachine", { ...create, labels: ["x"] });

  expect(status).toBe(400);
  expect(decodeInvalidInput(body)).toBeInstanceOf(Action.InvalidInput);
  expect(host?.calls).toEqual([]);
});

test("the reads of a machine, a checkpoint and the host refuse undeclared fields with InvalidInput", async () => {
  for (const [path, body] of [
    ["getMachine", { id: "linux_dev", extra: 1 }],
    ["getCheckpoint", { id: "linux_dev", extra: 1 }],
    ["getHost", { extra: 1 }],
    ["getCapacity", { extra: 1 }],
  ] as const) {
    const answer = await post(path, body);

    expect(answer.status, path).toBe(400);
    expect(decodeInvalidInput(answer.body), path).toBeInstanceOf(Action.InvalidInput);
    await host?.dispose();
  }
});

test("malformed IDs, names and sizes are refused with InvalidInput", async () => {
  for (const [path, body] of [
    ["getMachine", { id: "nohost" }],
    ["createMachine", { ...create, id: "linux_2dev" }],
    ["createMachine", { ...create, id: `linux_${"a".repeat(57)}` }],
    ["createMachine", { ...create, cpu: 0 }],
    ["createMachine", { ...create, cpu: 1.5 }],
    ["forkMachine", { machine: "linux_dev", name: "a.b" }],
  ] as const) {
    const answer = await post(path, body);

    expect(answer.status, path).toBe(400);
    expect(decodeInvalidInput(answer.body), path).toBeInstanceOf(Action.InvalidInput);
    await host?.dispose();
  }
});

test("setup goes with its timeout", async () => {
  const halves: ReadonlyArray<Schema.Json> = [
    { ...create, setup: { script: "#!/bin/sh\ntrue\n" } },
    { ...create, setup: { timeoutSeconds: 60 } },
    { ...create, setupTimeoutSeconds: 60 },
  ];

  for (const body of halves) {
    const answer = await post("createMachine", body);

    expect(answer.status).toBe(400);
    expect(decodeInvalidInput(answer.body)).toBeInstanceOf(Action.InvalidInput);
    await host?.dispose();
  }
});

test("a refused create's message doesn't carry its setup script", async () => {
  const marker = "setup-text-marker";

  const answer = await post("createMachine", {
    ...create,
    setup: { script: `#!/bin/sh\necho ${marker}\n`, timeoutSeconds: "soon" },
    extra: true,
  });

  expect(answer.status).toBe(400);
  expect(answer.body.includes(marker)).toBe(false);
});
