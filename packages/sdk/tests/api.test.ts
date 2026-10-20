import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Schema } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { Http, Invalid, PublicKeys, Usage } from "../src/index.ts";
import { operatorKey } from "./keys.ts";
import { type StubHost, stubHost } from "./stub-host.ts";

let host: StubHost | undefined;

afterEach(async () => {
  await host?.dispose();
  host = undefined;
});

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

test("every action declares Invalid, which the host's version check answers before any handler", () => {
  expect(
    Http.actions.filter((action) => !action.error.includes(Invalid)).map(({ name }) => name),
  ).toEqual([]);
});

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

test("setup needs its script, and its timeout goes inside it", async () => {
  const halves: ReadonlyArray<Schema.Json> = [
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

test("a refused create's message doesn't carry authorized keys that aren't public keys", async () => {
  const secret = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEsecret\n";

  const answer = await post("createMachine", {
    ...create,
    setup: { script: "#!/bin/sh\n", authorizedKeys: secret },
  });

  expect(answer.status).toBe(400);
  expect(answer.body.includes("b3BlbnNzaC1rZXktdjEsecret")).toBe(false);
});

const decodeKeys = Schema.decodeUnknownExit(PublicKeys);

for (const [kind, key] of [
  ["an ed25519", operatorKey],
  ["an RSA", "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQExample me@laptop"],
  ["an ecdsa-sha2-nistp256", "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYExample="],
  [
    "a hardware sk-ssh-ed25519@openssh.com",
    "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tExample== yubikey",
  ],
  [
    "a hardware sk-ecdsa-sha2-nistp256@openssh.com",
    "sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNhLXNoYTItbmlzdHAyNTZAb3BlbnNzaC5jb20Example",
  ],
  [
    "an ssh-ed25519-cert-v01@openssh.com certificate",
    "ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tExample me",
  ],
  [
    "an ecdsa-sha2-nistp256-cert-v01@openssh.com certificate",
    "ecdsa-sha2-nistp256-cert-v01@openssh.com AAAAKGVjZHNhLXNoYTItbmlzdHAyNTYtY2VydC12MDFAb3BlbnNzaC5jb20Example",
  ],
] as const) {
  test(`authorized keys take ${kind} public key, as a .pub file holds it`, () => {
    expect(decodeKeys(`${key}\n`)._tag).toBe("Success");
  });
}

test("authorized keys take blank lines, so two .pub files concatenated are one value", () => {
  const rsa = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQExample me@laptop";

  expect(decodeKeys(`${operatorKey}\n\n${rsa}\n\n`)._tag).toBe("Success");
  expect(decodeKeys(`${operatorKey}\n${rsa}`)._tag).toBe("Success");
});

for (const [what, text] of [
  [
    "an OpenSSH private key",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE=\n-----END OPENSSH PRIVATE KEY-----\n",
  ],
  [
    "a PEM private key",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n",
  ],
  [
    "a PuTTY key",
    "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nPrivate-Lines: 1\nAAAAIExample\n",
  ],
  ["a .netrc", "machine example.com login me password hunter2\n"],
  ["a key line with authorized_keys options", `restrict ${operatorKey}\n`],
  ["a public key followed by anything else", `${operatorKey}\nmachine example.com login me\n`],
  ["an empty file", ""],
  ["blank lines alone", "\n \n"],
] as const) {
  test(`authorized keys refuse ${what}`, () => {
    expect(decodeKeys(text)._tag).toBe("Failure");
  });
}

test("a capacity row has a sum or the machines it couldn't count, and needs one of them", () => {
  const decode = Schema.decodeUnknownExit(Usage);
  const row = { host: "linux", resource: "cpu" };

  expect(decode({ ...row, used: 3 })._tag).toBe("Success");
  expect(decode({ ...row, unread: ["linux_dev"] })._tag).toBe("Success");
  expect(decode(row)._tag).toBe("Failure");
});
