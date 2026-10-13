import { Match, type PlatformError, Predicate, type Schema, SchemaIssue } from "effect";

export const mibPerGib = 1024;

/** Exactly, as a size flag takes it: `32G`, `1.5G`, `512M`, `1500M`. */
export const formatMib = (mib: number): string =>
  mib >= mibPerGib && mib % (mibPerGib / 2) === 0 ? `${mib / mibPerGib}G` : `${mib}M`;

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

/** On one line: `cpu: missing; ram: not a known field`. `names` renames top-level fields. */
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
 * Node describes a failure only in its cause, so what has no wording here reads as the system's
 * own.
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
