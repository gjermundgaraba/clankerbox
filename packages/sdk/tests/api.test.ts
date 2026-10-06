import { Schema } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { Invalid } from "../src/index.ts";
import { type StubHost, stubHost } from "./stub-host.ts";

let host: StubHost | undefined;

afterEach(async () => {
  await host?.dispose();
  host = undefined;
});

const decodeInvalid = Schema.decodeUnknownSync(Schema.fromJsonString(Invalid));

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
  const { status } = await post("machine/create", create);

  expect(status).toBe(200);
});

test("an undeclared field is refused with Invalid, before the handler runs", async () => {
  const { status, body } = await post("machine/create", { ...create, labels: ["x"] });

  expect(status).toBe(400);
  expect(decodeInvalid(body)).toBeInstanceOf(Invalid);
  expect(host?.calls).toEqual([]);
});

test("every group refuses undeclared fields with Invalid", async () => {
  for (const [path, body] of [
    ["machine/get", { id: "linux_dev", extra: 1 }],
    ["checkpoint/get", { id: "linux_dev", extra: 1 }],
    ["host/get", { extra: 1 }],
  ] as const) {
    const answer = await post(path, body);

    expect(answer.status, path).toBe(400);
    expect(decodeInvalid(answer.body), path).toBeInstanceOf(Invalid);
    await host?.dispose();
  }
});

test("malformed IDs, names and sizes are refused with Invalid", async () => {
  for (const [path, body] of [
    ["machine/get", { id: "nohost" }],
    ["machine/create", { ...create, id: "linux_2dev" }],
    ["machine/create", { ...create, id: `linux_${"a".repeat(57)}` }],
    ["machine/create", { ...create, cpu: 0 }],
    ["machine/create", { ...create, cpu: 1.5 }],
    ["machine/fork", { machine: "linux_dev", name: "a.b" }],
  ] as const) {
    const answer = await post(path, body);

    expect(answer.status, path).toBe(400);
    expect(decodeInvalid(answer.body), path).toBeInstanceOf(Invalid);
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
    const answer = await post("machine/create", body);

    expect(answer.status).toBe(400);
    expect(decodeInvalid(answer.body)).toBeInstanceOf(Invalid);
    await host?.dispose();
  }
});

test("a refused create's message doesn't carry its setup script", async () => {
  const marker = "setup-text-marker";

  const answer = await post("machine/create", {
    ...create,
    setup: { script: `#!/bin/sh\necho ${marker}\n`, timeoutSeconds: "soon" },
    extra: true,
  });

  expect(answer.status).toBe(400);
  expect(answer.body.includes(marker)).toBe(false);
});
