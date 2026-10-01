// q-sea-min: one multi-role entry point, dispatching on argv[2] (cli|server|host).
// Each role touches the node: modules the real binary needs, then exits.
const { isSea } = require("node:sea");

const base = () => ({ node: process.version, platform: `${process.platform}-${process.arch}`, isSea: isSea(), execPath: process.execPath });
const print = (value) => process.stdout.write(JSON.stringify(value) + "\n");

const roles = {
  cli() {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("create table t (k text primary key, v integer)");
    db.prepare("insert into t values (?, ?)").run("a", 42);
    const row = db.prepare("select v, sqlite_version() as version from t where k = ?").get("a");
    db.close();
    print({ role: "cli", ...base(), sqlite: row });
  },
  async server() {
    const http = require("node:http");
    const server = http.createServer((req, res) => res.end("pong"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const body = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    await new Promise((resolve) => server.close(resolve));
    print({ role: "server", ...base(), port, body });
  },
  host() {
    // Re-exec this binary in another role, as a systemd/launchd unit would run `process.execPath host`.
    const { execFileSync } = require("node:child_process");
    const child = JSON.parse(execFileSync(process.execPath, ["cli"], { encoding: "utf8" }));
    const shell = execFileSync("/bin/sh", ["-c", "echo sh-ok"], { encoding: "utf8" }).trim();
    print({ role: "host", ...base(), child: { role: child.role, isSea: child.isSea, execPath: child.execPath, sqlite: child.sqlite.version }, shell });
  },
};

const arg = process.argv[2];
if (arg === "--version") {
  print({ version: "0.0.0-q-sea-min", ...base() });
} else if (arg === "--help") {
  process.stdout.write("usage: clankerbox cli|server|host|--help|--version\n");
} else if (Object.hasOwn(roles, arg)) {
  Promise.resolve(roles[arg]()).catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exit(1);
  });
} else {
  process.stderr.write("usage: clankerbox cli|server|host|--help|--version\n");
  process.exit(2);
}
