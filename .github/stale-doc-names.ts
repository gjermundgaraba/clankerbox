import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...args: string[]) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "ignore"],
  });

const lines = (text: string) => text.split("\n").filter((line) => line !== "");

const shown = (rev: string, file: string) => {
  try {
    return git("show", `${rev}:${file}`);
  } catch {
    return "";
  }
};

const isSource = (file: string) => /\.(?:ts|tsx|mts|sh|tla)$/u.test(file);

const words = (text: string) => text.match(/[A-Za-z_$][\w$]*/gu) ?? [];

const code = (text: string) =>
  text
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/(?<![:\w"'`])\/\/.*$/gmu, "")
    .replaceAll(/^\s*#(?!!).*$/gmu, "")
    .replaceAll(/^\s*\\\*.*$/gmu, "");

const declaresMember = (text: string, owner: string, member: string) =>
  new RegExp(`\\b${owner}\\b`, "u").test(text) &&
  new RegExp(`^\\s*(?:readonly\\s+)?${member}\\??\\s*[:(]`, "mu").test(text);

const base = git("merge-base", process.argv[2] ?? "origin/main", "HEAD").trim();
const tracked = lines(git("ls-files"));
const changed = lines(git("diff", "--name-only", "--no-renames", base, "HEAD"));

const sources = tracked
  .filter(isSource)
  .map((file) => code(readFileSync(file, "utf8")));

const now = new Set(sources.flatMap(words));
const before = changed.filter(isSource).map((file) => code(shown(base, file)));
const gone = new Set(before.flatMap(words).filter((word) => !now.has(word)));
const goneFiles = changed.filter((file) => !tracked.includes(file));

const memberGone = (span: string) => {
  const qualified =
    /^(?<owner>[A-Z][\w$]*)\.(?<member>[a-z_$][\w$]*)(?:\(.*\))?$/u.exec(span);

  const { owner, member } = qualified?.groups ?? {};

  return (
    owner !== undefined &&
    member !== undefined &&
    before.some((text) => declaresMember(text, owner, member)) &&
    !sources.some((text) => declaresMember(text, owner, member))
  );
};

const stale: string[] = [];

for (const doc of tracked.filter((file) => file.endsWith(".md"))) {
  const kept = new Set(shown(base, doc).split("\n"));
  let history = false;

  for (const [index, line] of readFileSync(doc, "utf8").split("\n").entries()) {
    if (/^#+ /u.test(line)) {
      history = /^#+ Upgrading from /u.test(line);
    }

    if (history || !kept.has(line)) {
      continue;
    }

    for (const { groups } of line.matchAll(/`(?<span>[^`\n]+)`/gu)) {
      const { span = "" } = groups ?? {};

      const name =
        /^(?:--[a-z][\w-]*|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?=\(|$)/u.exec(
          span
        )?.[0] ?? "";

      const cited =
        words(name).find((word) => gone.has(word)) ??
        goneFiles.find((file) => file === span || file.endsWith(`/${span}`)) ??
        (memberGone(span) ? span : undefined);

      if (cited !== undefined) {
        stale.push(`${doc}:${index + 1}: \`${span}\` names ${cited}`);
      }
    }
  }
}

if (stale.length > 0) {
  console.error(
    `This change removes names from the code that these unchanged doc lines still cite. Reword each line for the code as it is now, or drop it; an "Upgrading from" section may name what a release removed. Since ${base}:\n${stale.join("\n")}`
  );
  process.exitCode = 1;
}
