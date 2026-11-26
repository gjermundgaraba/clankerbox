import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

interface Weakening {
  readonly what: string;
  readonly file: string;
  readonly edits: ReadonlyArray<readonly [from: string, to: string]>;
  readonly package: string;
  readonly test: string;
  readonly by: string;
}

const node = "packages/sdk/src/node.ts";
const reach = "packages/sdk/src/reach.ts";
const client = "packages/sdk/src/client.ts";
const tokens = "apps/server/src/composition/tokens.ts";
const routes = "apps/server/src/composition/routes.ts";
const config = "apps/server/src/composition/config.ts";
const setup = "packages/sdk/src/setup.ts";
const resources = "packages/sdk/src/resources.ts";

const minting = (random: string) =>
  `const token = \`\${tokenPrefix[kind]}\${${random}}\`;`;

const hashed = 'createHash("sha256").update(token, "utf8")';

const compare =
  "if (timingSafeEqual(presented, caller.hash) && found === undefined) {";

const mapped =
  "(leadingZeros && g5 === 0xff_ff && v4Reaches([g6 >> 8, g6 & 0xff]))";

const loopback = "(leadingZeros && g5 === 0 && g6 === 0 && g7 === 1)";

const comparing = (what: string, test: string, by: string): Weakening => ({
  what,
  file: node,
  edits: [[compare, `if ((${test}) && found === undefined) {`]],
  package: "packages/sdk",
  test: "tests/tokens.test.ts",
  by,
});

const reaching = (what: string, from: string, to: string): Weakening => ({
  what,
  file: reach,
  edits: [[from, to]],
  package: "packages/sdk",
  test: "tests/tokens.test.ts",
  by: "takes the loopback and tailnet ranges",
});

const serving = (
  what: string,
  file: string,
  from: string,
  to: string,
  by: string,
  test = "tests/composition/routes.test.ts"
): Weakening => ({
  what,
  file,
  edits: [[from, to]],
  package: "apps/server",
  test,
  by,
});

const sum = (bytes: string) => `${bytes}.reduce((a, b) => a + b, 0)`;

const bits = (bytes: string) =>
  `${bytes}.reduce((a, b) => a + b.toString(2).replaceAll("0", "").length, 0)`;

const weakenings: readonly Weakening[] = [
  comparing(
    "compares only the first 4 bytes",
    "timingSafeEqual(presented.subarray(0, 4), caller.hash.subarray(0, 4))",
    "in any one bit"
  ),
  comparing(
    "skips byte 16",
    "timingSafeEqual(Buffer.concat([presented.subarray(0, 16), presented.subarray(17)]), Buffer.concat([caller.hash.subarray(0, 16), caller.hash.subarray(17)]))",
    "in any one bit"
  ),
  comparing(
    "compares only bytes 0 and 31",
    "presented[0] === caller.hash[0] && presented[31] === caller.hash[31]",
    "in any one bit"
  ),
  comparing(
    "compares only the last 4 bytes",
    "timingSafeEqual(presented.subarray(28), caller.hash.subarray(28))",
    "in any one bit"
  ),
  comparing(
    "compares bytes 0-30 and the low bit of 31",
    "timingSafeEqual(presented.subarray(0, 31), caller.hash.subarray(0, 31)) && ((presented[31] ?? 0) & 1) === ((caller.hash[31] ?? 0) & 1)",
    "in any one bit"
  ),
  comparing(
    "compares the bytes' sums",
    `${sum("presented")} === ${sum("caller.hash")}`,
    "has the token's byte sum"
  ),
  comparing(
    "compares the bits set",
    `${bits("presented")} === ${bits("caller.hash")}`,
    "has the token's byte sum"
  ),
  comparing(
    "compares the bytes in any order",
    "Buffer.from([...presented].toSorted()).equals(Buffer.from([...caller.hash].toSorted()))",
    "in another order"
  ),
  comparing(
    "checks the caller prefix, then compares only 4 bytes",
    'token.startsWith("cbx_") ? timingSafeEqual(presented.subarray(0, 4), caller.hash.subarray(0, 4)) : timingSafeEqual(presented, caller.hash)',
    "in any one bit"
  ),
  comparing(
    "checks the host prefix, then compares only 4 bytes",
    'token.startsWith("cbxh_") ? timingSafeEqual(presented.subarray(0, 4), caller.hash.subarray(0, 4)) : timingSafeEqual(presented, caller.hash)',
    "in any one bit"
  ),
  comparing(
    "takes any prefixed token without comparing",
    'token.startsWith("cbx") || timingSafeEqual(presented, caller.hash)',
    "finds each caller by its own token"
  ),
  {
    what: "hashes only a token's first 36 characters",
    file: node,
    edits: [
      [hashed, 'createHash("sha256").update(token.slice(0, 36), "utf8")'],
    ],
    package: "packages/sdk",
    test: "tests/tokens.test.ts",
    by: "differs from its own in any one character",
  },
  {
    what: "hashes a token without its prefix",
    file: node,
    edits: [
      [
        hashed,
        'createHash("sha256").update(token.replace(/^cbxh?_/u, ""), "utf8")',
      ],
    ],
    package: "packages/sdk",
    test: "tests/tokens.test.ts",
    by: "differs from its own in any one character",
  },
  {
    what: "a token file may hold either hop's token",
    file: setup,
    edits: [
      ["if (held !== kind) {", 'if (held !== "caller" && held !== "host") {'],
    ],
    package: "apps/cli",
    test: "tests/config.test.ts",
    by: "a host's token or a token without its prefix",
  },
  {
    what: "a SHA-256 passes as a caller's name",
    file: resources,
    edits: [
      [
        "if (held !== undefined) {",
        'if (held !== undefined && held !== "hash") {',
      ],
    ],
    package: "apps/server",
    test: "tests/composition/token.test.ts",
    by: "a SHA-256 or token given as a name",
  },
  reaching(
    "takes every IPv4-mapped address",
    mapped,
    "(leadingZeros && g5 === 0xff_ff)"
  ),
  reaching("takes no IPv4-mapped address", mapped, "false"),
  reaching(
    "takes ffff after any prefix",
    mapped,
    "(g5 === 0xff_ff && v4Reaches([g6 >> 8, g6 & 0xff]))"
  ),
  reaching(
    "takes ::1 with group 5 unchecked",
    loopback,
    "(leadingZeros && g6 === 0 && g7 === 1)"
  ),
  reaching(
    "takes ::1 with only four leading zero groups",
    loopback,
    "([g0, g1, g2, g3].every((g) => g === 0) && g5 === 0 && g6 === 0 && g7 === 1)"
  ),
  {
    what: "a token goes to http://localhost",
    file: client,
    edits: [
      [
        "isTailnetOrLoopback(hostname.replace(",
        'hostname === "localhost" || isTailnetOrLoopback(hostname.replace(',
      ],
    ],
    package: "packages/sdk",
    test: "tests/tokens.test.ts",
    by: "lets a token go over https anywhere",
  },
  {
    what: "one middleware reads its callers once",
    file: node,
    edits: [
      [
        "HttpRouter.middleware((handle) =>",
        "HttpRouter.middleware((handle, memo: { read?: readonly Caller[] } = {}) =>",
      ],
      [
        "Effect.flatMap(callers, (taken) => {",
        "Effect.flatMap(memo.read === undefined ? Effect.tap(callers, (read) => Effect.sync(() => { memo.read = read; })) : Effect.succeed(memo.read), (taken) => {",
      ],
    ],
    package: "packages/sdk",
    test: "tests/tokens.test.ts",
    by: "one middleware reads its callers at each request",
  },
  {
    what: "a minted token holds 16 random bits",
    file: node,
    edits: [
      [
        minting('randomBytes(32).toString("hex")'),
        minting('randomBytes(2).toString("hex").repeat(16)'),
      ],
    ],
    package: "packages/sdk",
    test: "tests/tokens.test.ts",
    by: "mints its hop's prefix and 64 hex digits",
  },
  {
    what: "a minted token is 16 bytes",
    file: node,
    edits: [
      [
        minting('randomBytes(32).toString("hex")'),
        minting('randomBytes(16).toString("hex")'),
      ],
    ],
    package: "packages/sdk",
    test: "tests/tokens.test.ts",
    by: "mints its hop's prefix and 64 hex digits",
  },
  serving(
    "the control plane reads its tokens at startup",
    routes,
    'return requireToken("control plane", unrevoked(store)).layer;',
    'const cached = yield* unrevoked(store);\n\n              return requireToken("control plane", Effect.succeed(cached)).layer;',
    "a revoked token is refused from its next request"
  ),
  serving(
    "takes revoked tokens",
    tokens,
    "rows.filter(({ revokedAt }) => revokedAt === undefined)",
    "rows",
    "a revoked token is refused from its next request"
  ),
  serving(
    "list drops revoked tokens",
    tokens,
    "Effect.map(store.tokens, (rows) => rows.map(tokenOf))",
    "Effect.map(store.tokens, (rows) => rows.filter((row) => row.revokedAt === undefined).map(tokenOf))",
    "every token mints, lists and revokes tokens"
  ),
  serving(
    "the offline list drops revoked tokens",
    "apps/server/src/composition/token.ts",
    "(store) => store.tokens",
    "(store) => Effect.map(store.tokens, (rows) => rows.filter((row) => row.revokedAt === undefined))",
    "token list and revoke --config read and revoke",
    "tests/composition/token.test.ts"
  ),
  serving(
    "token list --config prints nothing",
    "apps/server/src/composition/token.ts",
    '(cells) => Console.log(cells.join("\\t")),',
    "() => Effect.void,",
    "token list and revoke --config read and revoke",
    "tests/composition/token.test.ts"
  ),
  serving(
    "token list --config prints no MINTED_BY",
    "apps/server/src/composition/token.ts",
    "tokenRows(rows.map(tokenOf)),",
    "tokenRows(rows.map((row) => tokenOf({ ...row, mintedBy: undefined }))),",
    "token list and revoke --config read and revoke",
    "tests/composition/token.test.ts"
  ),
  serving(
    "takes everyone while no token is minted",
    node,
    "return caller === undefined",
    "return caller === undefined && taken.length > 0",
    "with tokens and none minted yet"
  ),
  serving(
    "counts tokens: false as on",
    config,
    "tokens: decoded.tokens === true,",
    "tokens: decoded.tokens !== undefined,",
    "a listen address that is neither tailnet nor loopback",
    "tests/composition/config.test.ts"
  ),
];

const checkout = path.resolve(process.argv[2] ?? ".");
const survived: string[] = [];
let interrupted = false;

const listed = spawnSync(
  "git",
  [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--deduplicate",
  ],
  { cwd: checkout, encoding: "utf8" }
);

if (listed.error !== undefined || listed.status !== 0) {
  console.error(
    `couldn't list the checkout's files to copy: ${listed.error?.message ?? listed.stderr.trim()}`
  );
  process.exit(1);
}

const copy = mkdtempSync(path.join(tmpdir(), "clankerbox-weakenings-"));

process.on("exit", () => {
  rmSync(copy, { recursive: true, force: true });
});

process.on("SIGINT", () => {
  interrupted = true;
});

process.on("SIGTERM", () => {
  interrupted = true;
});

for (const name of listed.stdout.split("\0")) {
  const from = path.join(checkout, name);
  const to = path.join(copy, name);
  const found = lstatSync(from, { throwIfNoEntry: false });

  if (name !== "" && found !== undefined) {
    mkdirSync(path.dirname(to), { recursive: true });

    if (found.isSymbolicLink()) {
      symlinkSync(readlinkSync(from), to);
    } else {
      copyFileSync(from, to);
    }
  }
}

const installed = spawnSync(
  "vp",
  ["install", "--frozen-lockfile", "--offline"],
  { cwd: copy, encoding: "utf8" }
);

if (installed.error !== undefined || installed.status !== 0) {
  console.error(`${installed.stdout ?? ""}${installed.stderr ?? ""}`);
  console.error(
    `couldn't install the copy's dependencies from the store, which a vp install in the checkout fills: ${installed.error?.message ?? `exit ${installed.status ?? installed.signal}`}`
  );
  process.exit(1);
}

const vpTest = (pkg: string, test: string) => {
  const run = spawnSync("vp", ["test", test], {
    cwd: path.join(copy, pkg),
    encoding: "utf8",
  });

  const failures = stripVTControlCharacters(`${run.stdout}${run.stderr}`)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("FAIL "));

  return {
    run,
    tests: new Set(
      failures
        .filter((line) => line.includes(" > "))
        .map((line) => line.slice(line.indexOf(">") + 1).trim())
    ),
    files: failures.filter((line) => !line.includes(" > ")),
  };
};

for (const suite of new Map(
  weakenings.map((w) => [`${w.package}/${w.test}`, w])
).values()) {
  const { run } = vpTest(suite.package, suite.test);

  if (run.error !== undefined || run.status !== 0) {
    console.error(`${run.stdout ?? ""}${run.stderr ?? ""}`);
    console.error(
      `${suite.package}/${suite.test} doesn't pass on this checkout, so no weakening can be judged by it: ${run.error?.message ?? `exit ${run.status ?? run.signal}`}`
    );
    process.exit(1);
  }
}

for (const weakening of weakenings) {
  await setImmediate();

  if (interrupted) {
    survived.push("interrupted: the rest weren't run");
    break;
  }

  const file = path.join(copy, weakening.file);
  const original = readFileSync(file, "utf8");

  const lost = weakening.edits.find(
    ([from]) => original.split(from).length !== 2
  );

  if (lost !== undefined) {
    survived.push(
      `${weakening.what}: ${lost[0]} is no longer once in ${weakening.file}`
    );
    continue;
  }

  let planted = original;

  for (const [from, to] of weakening.edits) {
    planted = planted.replace(from, to);
  }

  writeFileSync(file, planted);

  const { run, tests, files } = vpTest(weakening.package, weakening.test);

  const refused =
    run.error === undefined &&
    run.status === 1 &&
    files.length === 0 &&
    [...tests].some((name) => name.includes(weakening.by));

  const passed = run.error === undefined && run.status === 0;

  let verdict = "BROKEN ";

  if (refused) {
    verdict = "refused";
  } else if (passed) {
    verdict = "PASSED ";
  }

  console.log(`${verdict}  ${weakening.what}`);

  for (const name of tests) {
    console.log(`           by ${name}`);
  }

  if (!refused && !passed) {
    console.log(
      `${run.stdout ?? ""}${run.stderr ?? ""}`.split("\n").slice(-40).join("\n")
    );
  }

  if (passed) {
    survived.push(weakening.what);
  } else if (!refused) {
    survived.push(
      `${weakening.what}: its run ended without "${weakening.by}" failing on an assertion, so it proves nothing (${run.error?.message ?? `exit ${run.status ?? run.signal}`}${files.length > 0 ? `; ${files.join("; ")}` : ""})`
    );
  }

  writeFileSync(file, original);
}

if (survived.length > 0) {
  console.error(`weakenings no test refuses:\n${survived.join("\n")}`);
  process.exitCode = 1;
}
