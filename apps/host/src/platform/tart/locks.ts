import { Result } from "effect";

/** The program that reads the locks, macOS's own Perl, which can ask `fcntl` what Node can't. */
export const reader = "/usr/bin/perl";

// https://github.com/openai/tart/blob/2.41.1/Sources/tart/PIDLock.swift#L36
// macOS's `struct flock` is `off_t l_start, l_len; pid_t l_pid; short l_type, l_whence` (sys/fcntl.h).
const script = [
  "use strict;",
  "use Fcntl qw(:DEFAULT :seek);",
  "for my $path (@ARGV) {",
  "  my $fh;",
  "  if (!open($fh, '<', $path)) {",
  `    print(($!{ENOENT} ? "none" : "error $!"), "\\t$path\\n");`,
  "    next;",
  "  }",
  "  my $lock = pack('q q l s s', 0, 0, 0, F_RDLCK, SEEK_SET);",
  `  if (!fcntl($fh, F_GETLK, $lock)) { print "error $!\\t$path\\n"; next; }`,
  "  my (undef, undef, $pid) = unpack('q q l s s', $lock);",
  `  print "$pid\\t$path\\n";`,
  "}",
  `print "end\\n";`,
].join("\n");

export const readerArguments = (
  paths: readonly string[]
): readonly string[] => ["-e", script, "--", ...paths];

/**
 * Each path's lock holder from the reader's output, in the order of `paths`, 0 where none holds
 * it or the file is gone, or why the output isn't the whole answer for `paths`: an `fcntl` that
 * failed, or a line missing.
 */
export const holders = (
  paths: readonly string[],
  output: string
): Result.Result<readonly number[], string> => {
  const lines = output.split("\n");

  if (lines.length !== paths.length + 2 || lines.at(-2) !== "end") {
    return Result.fail(
      `it answered ${lines.length - 1} lines for ${paths.length} paths, with no end`
    );
  }

  const read: number[] = [];

  for (const [at, path] of paths.entries()) {
    const [holder = "", named] = (lines[at] ?? "").split("\t");

    if (named !== path) {
      return Result.fail(
        `it answered ${JSON.stringify(lines[at])} for ${path}`
      );
    }

    if (holder !== "none" && !/^\d+$/u.test(holder)) {
      return Result.fail(`${path}: ${holder}`);
    }

    read.push(holder === "none" ? 0 : Number(holder));
  }

  return Result.succeed(read);
};
