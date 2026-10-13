/** How sizes, decode failures and file failures read in a message or a table cell. */
import { Match, type PlatformError, Predicate, type Schema, SchemaIssue } from "effect";

export const mibPerGib = 1024;

/**
 * A RAM size, exactly, as a size flag takes one: GiB when it is whole or half GiB, `32G` or
 * `1.5G`, and MiB when it isn't, `512M` or `1500M`.
 */
export const formatMib = (mib: number): string =>
  mib >= mibPerGib && mib % (mibPerGib / 2) === 0 ? `${mib / mibPerGib}G` : `${mib}M`;

/** A disk size, in its whole GiB, as a size flag takes one: `60G`. */
export const formatGib = (gib: number): string => `${gib}G`;

/**
 * Where a decode failed, as a JSON path: `hosts[0].id`. `names` gives a top-level field the
 * name its caller knows it by.
 */
const jsonPath = (
  path: ReadonlyArray<PropertyKey>,
  names: ReadonlyMap<PropertyKey, string> | undefined,
): string =>
  path
    .map((key, index) => {
      if (Number.isInteger(key)) {
        return `[${String(key)}]`;
      }

      return index === 0 ? (names?.get(key) ?? String(key)) : `.${String(key)}`;
    })
    .join("");

const flatten = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) =>
    Match.value(issue).pipe(
      Match.tag("MissingKey", () => "missing"),
      Match.tag("UnexpectedKey", () => "not a known field"),
      Match.orElse(SchemaIssue.defaultLeafHook),
    ),
});

/**
 * Everything a decode refused, on one line, each under its JSON path: `cpu: missing; ram: not a
 * known field`. `names` renames top-level fields, as when a flag set each: `--cpu: missing`.
 */
export const describeIssues = (
  error: Schema.SchemaError,
  names?: ReadonlyMap<PropertyKey, string>,
): string =>
  flatten(error.issue)
    .issues.map(({ path = [], message }) => {
      const keys = path.map((segment) =>
        Predicate.isPropertyKey(segment) ? segment : segment.key,
      );

      return keys.length === 0 ? message : `${jsonPath(keys, names)}: ${message}`;
    })
    .join("; ");

/**
 * Why a file couldn't be read, without the platform call that met it. Node describes a failure
 * only in its cause, so what has no wording here reads as the system's own.
 */
export const describeFileError = ({ reason }: PlatformError.PlatformError): string => {
  if (Predicate.isTagged(reason, "NotFound")) {
    return "no such file or directory";
  }

  if (Predicate.isTagged(reason, "PermissionDenied")) {
    return "permission denied";
  }

  return reason.description ?? (reason.cause instanceof Error ? reason.cause.message : reason._tag);
};
