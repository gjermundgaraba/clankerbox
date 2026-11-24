import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface Weakening {
  readonly what: string;
  readonly file: string;
  readonly edits: ReadonlyArray<readonly [from: string, to: string]>;
  readonly package: string;
  readonly test: string;
}

const node = "packages/sdk/src/node.ts";
const reach = "packages/sdk/src/reach.ts";
const client = "packages/sdk/src/client.ts";
const tokens = "apps/server/src/composition/tokens.ts";
const routes = "apps/server/src/composition/routes.ts";
const config = "apps/server/src/composition/config.ts";

const compare =
  "if (timingSafeEqual(presented, caller.hash) && found === undefined) {";

const mapped =
  "(leadingZeros && g5 === 0xff_ff && v4Reaches([g6 >> 8, g6 & 0xff]))";

const loopback = "(leadingZeros && g5 === 0 && g6 === 0 && g7 === 1)";

const comparing = (what: string, test: string): Weakening => ({
  what,
  file: node,
  edits: [[compare, `if ((${test}) && found === undefined) {`]],
  package: "packages/sdk",
  test: "tests/tokens.test.ts",
});

const reaching = (what: string, from: string, to: string): Weakening => ({
  what,
  file: reach,
  edits: [[from, to]],
  package: "packages/sdk",
  test: "tests/tokens.test.ts",
});

const serving = (
  what: string,
  file: string,
  from: string,
  to: string,
  test = "tests/composition/routes.test.ts"
): Weakening => ({
  what,
  file,
  edits: [[from, to]],
  package: "apps/server",
  test,
});

const sum = (bytes: string) => `${bytes}.reduce((a, b) => a + b, 0)`;

const bits = (bytes: string) =>
  `${bytes}.reduce((a, b) => a + b.toString(2).replaceAll("0", "").length, 0)`;

const weakenings: readonly Weakening[] = [
  comparing(
    "compares only the first 4 bytes",
    "timingSafeEqual(presented.subarray(0, 4), caller.hash.subarray(0, 4))"
  ),
  comparing(
    "skips byte 16",
    "timingSafeEqual(Buffer.concat([presented.subarray(0, 16), presented.subarray(17)]), Buffer.concat([caller.hash.subarray(0, 16), caller.hash.subarray(17)]))"
  ),
  comparing(
    "compares only bytes 0 and 31",
    "presented[0] === caller.hash[0] && presented[31] === caller.hash[31]"
  ),
  comparing(
    "compares only the last 4 bytes",
    "timingSafeEqual(presented.subarray(28), caller.hash.subarray(28))"
  ),
  comparing(
    "compares bytes 0-30 and the low bit of 31",
    "timingSafeEqual(presented.subarray(0, 31), caller.hash.subarray(0, 31)) && ((presented[31] ?? 0) & 1) === ((caller.hash[31] ?? 0) & 1)"
  ),
  comparing(
    "compares the bytes' sums",
    `${sum("presented")} === ${sum("caller.hash")}`
  ),
  comparing(
    "compares the bits set",
    `${bits("presented")} === ${bits("caller.hash")}`
  ),
  comparing(
    "compares the bytes in any order",
    "Buffer.from([...presented].toSorted()).equals(Buffer.from([...caller.hash].toSorted()))"
  ),
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
  },
  serving(
    "the control plane reads its tokens at startup",
    routes,
    'return requireToken("control plane", unrevoked(store)).layer;',
    'const cached = yield* unrevoked(store);\n\n              return requireToken("control plane", Effect.succeed(cached)).layer;'
  ),
  serving(
    "takes revoked tokens",
    tokens,
    "rows.filter(({ revokedAt }) => revokedAt === undefined)",
    "rows"
  ),
  serving(
    "list drops revoked tokens",
    tokens,
    "Effect.map(store.tokens, (rows) => rows.map(tokenOf))",
    "Effect.map(store.tokens, (rows) => rows.filter((row) => row.revokedAt === undefined).map(tokenOf))"
  ),
  serving(
    "the offline list drops revoked tokens",
    "apps/server/src/composition/token.ts",
    "(store) => store.tokens",
    "(store) => Effect.map(store.tokens, (rows) => rows.filter((row) => row.revokedAt === undefined))",
    "tests/composition/token.test.ts"
  ),
  serving(
    "takes everyone while no token is minted",
    node,
    "return caller === undefined",
    "return caller === undefined && taken.length > 0"
  ),
  serving(
    "counts tokens: false as on",
    config,
    "tokens: decoded.tokens === true,",
    "tokens: decoded.tokens !== undefined,",
    "tests/composition/config.test.ts"
  ),
];

const checkout = path.resolve(process.argv[2] ?? ".");
const survived: string[] = [];

for (const weakening of weakenings) {
  const file = path.join(checkout, weakening.file);
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

  try {
    const run = spawnSync("vp", ["test", weakening.test], {
      cwd: path.join(checkout, weakening.package),
      encoding: "utf8",
    });

    const refused = run.status !== 0;

    const failing = new Set(
      `${run.stdout}${run.stderr}`
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("FAIL "))
        .map((line) => line.slice(line.indexOf(">") + 1).trim())
    );

    console.log(`${refused ? "refused" : "PASSED "}  ${weakening.what}`);

    for (const name of failing) {
      console.log(`           by ${name}`);
    }

    if (!refused) {
      survived.push(weakening.what);
    }
  } finally {
    writeFileSync(file, original);
  }
}

if (survived.length > 0) {
  console.error(`weakenings no test refuses:\n${survived.join("\n")}`);
  process.exitCode = 1;
}
