import { Config, Option } from "effect";

/**
 * One job of Amp's orb provider, as `amp orb provider` passes it to the dispatch program in its
 * environment: `ORB_OPERATION`, `ORB_ID`, and on a spawn the image, the orb's token, the Amp URL
 * when it isn't the default, the orb type the thread chose, and the project snapshot to boot from
 * or to save, each unset when the job has none.
 */
export interface Job {
  readonly operation: "spawn" | "pause" | "delete";
  readonly id: string;
  readonly image: Option.Option<string>;
  readonly token: Option.Option<string>;
  readonly ampUrl: Option.Option<string>;
  readonly type: Option.Option<string>;
  readonly snapshot: Option.Option<string>;
}

const given = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map(Option.filter((value) => value !== ""))
  );

export const job: Config.Config<Job> = Config.all({
  operation: Config.Literals(["spawn", "pause", "delete"], "ORB_OPERATION"),
  id: Config.NonEmptyString("ORB_ID"),
  image: given("ORB_IMAGE"),
  token: given("ORB_TOKEN"),
  ampUrl: given("AMP_URL"),
  type: given("ORB_TYPE"),
  snapshot: given("ORB_SNAPSHOT_ID"),
});
