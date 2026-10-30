---------------------------- MODULE MachineAnswers ----------------------------
(***************************************************************************)
(* One machine, from its create to its delete, across the control plane,   *)
(* a host, the network between them, and clients that wait by reading the  *)
(* row. The control plane may crash, the host may restart, the link may    *)
(* partition, and a delivery may repeat, arrive late or be lost. Every     *)
(* action names the code it stands for; the skill's coverage table maps    *)
(* each one to its file and function.                                      *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Clients, Creator, Desires,
          MaxFaults, MaxCrashes, MaxPartitions, MaxRestarts, MaxDrops, MaxOps

None == "none"
Everyone == Clients \cup {Creator}
Resting == {"waiting", "settled", "failed", "lost"}
NoOp == [id |-> 0, kind |-> None, gen |-> 0, boot |-> 0]
NoRun == [id |-> 0, kind |-> None, status |-> None, pc |-> None]
Absent == [stage |-> "absent", desired |-> None, gen |-> 0, prepared |-> FALSE,
           phase |-> None, err |-> FALSE, op |-> NoOp]

VARIABLES
  row,        \* the store's row and the operation in flight, or None
  up,         \* the control plane runs
  script,     \* the control plane holds the setup in memory
  read,       \* the state the machine's loop last read, or None
  known,      \* the host boot the control plane last learned
  linked,     \* the control plane can reach the host
  vm,         \* what the runtime holds
  boot,       \* the host process's number
  high,       \* the highest sequence the host has seen this boot
  runs,       \* the operation the host runs or keeps, or None
  net,        \* deliveries of operations: lost, repeated or late
  cut,        \* cancels on their way to the host
  applied,    \* how often each operation changed the VM, for OnceOnly
  cl,         \* each request, from its call to its answer
  nextOp,     \* the next operation's ID and sequence
  faults,     \* runtime failures so far
  crashes,    \* control plane crashes so far
  partitions, \* partitions so far
  restarts,   \* host restarts so far
  drops       \* deliveries lost so far

vars == <<row, up, script, read, known, linked, vm, boot, high, runs, net, cut,
          applied, cl, nextOp, faults, crashes, partitions, restarts,
          drops>>

hostVars == <<vm, boot, high, runs, applied>>
worldVars == <<faults, crashes, partitions, restarts, drops>>

Idle == [pc |-> "idle", d |-> None, g |-> 0, res |-> None, by |-> None,
         vmAt |-> None, other |-> FALSE]

(* reconcile.ts next *)
Next_(r, seen) ==
  IF r.desired = "deleted" THEN "deleting"
  ELSE IF r.stage = "undoing" THEN "deleting"
  ELSE IF r.stage = "undone" THEN "failed"
  ELSE IF r.stage = "making" THEN "creating"
  ELSE IF seen = "unknown" THEN "waiting"
  ELSE IF seen = "missing" THEN "lost"
  ELSE IF r.desired = "paused"
       THEN IF seen = "running" THEN "pausing" ELSE "settled"
  ELSE IF r.desired = "stopped"
       THEN IF seen = "stopped" THEN "settled" ELSE "stopping"
  ELSE IF seen = "running" /\ r.prepared THEN "settled" ELSE "starting"

KindOf(s) ==
  CASE s = "creating" -> "make"
    [] s = "starting" -> "start"
    [] s = "stopping" -> "stop"
    [] s = "pausing" -> "pause"
    [] s = "deleting" -> "remove"

PhaseOf(k) ==
  CASE k = "make" -> "creating"
    [] k = "start" -> "starting"
    [] k = "stop" -> "stopping"
    [] k = "pause" -> "pausing"
    [] k = "remove" -> "deleting"

(* reconcile.ts cuts: which request stops which step short *)
Cuts(r) ==
  CASE r.op.kind = "make" -> r.desired = "deleted"
    [] r.op.kind = "start" -> r.desired # "running"
    [] r.op.kind = "stop" -> r.desired # "stopped"
    [] r.op.kind = "pause" -> r.desired # "paused"
    [] OTHER -> FALSE

(* the client's wait, in client.ts *)
Matches(d, v) ==
  CASE d = "running" -> v = "running"
    [] d = "stopped" -> v = "stopped"
    [] d = "paused" -> v \in {"paused", "stopped"}
    [] d = "deleted" -> v = "missing"

Asked(k, d) == \E j \in Everyone \ {k} : cl[j].pc # "idle" /\ cl[j].d = d

Finish(k, res, by) ==
  cl' = [cl EXCEPT ![k] = [@ EXCEPT !.pc = "done", !.res = res, !.by = by,
                                    !.vmAt = vm, !.other = Asked(k, by)]]

(* sqlite.ts insertMachine, from machines.ts create *)
Create ==
  /\ up /\ row.stage = "absent" /\ cl[Creator].pc = "idle"
  /\ row' = [stage |-> "making", desired |-> "running", gen |-> 1,
             prepared |-> FALSE, phase |-> "observing", err |-> FALSE,
             op |-> NoOp]
  /\ script' = TRUE
  /\ cl' = [cl EXCEPT ![Creator] = [@ EXCEPT !.pc = "wait", !.d = "running",
                                             !.g = 1]]
  /\ UNCHANGED <<up, read, known, linked, net, cut, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED worldVars

(* machines.ts request and the store's desire: deleted stays deleted, a      *)
(* failed create has no machine to ask for, and its row goes with a delete   *)
Request(k) ==
  /\ up /\ cl[k].pc = "idle"
  /\ \E d \in Desires :
       IF row.stage = "absent"
       THEN /\ cl' = [cl EXCEPT ![k] = [@ EXCEPT !.pc = "done", !.d = d,
                                                 !.res = "notfound"]]
            /\ UNCHANGED row
       ELSE IF row.stage \in {"undoing", "undone"} /\ d # "deleted"
       THEN /\ cl' = [cl EXCEPT ![k] = [@ EXCEPT !.pc = "done", !.d = d,
                                                 !.res = "notfound"]]
            /\ UNCHANGED row
       ELSE IF row.stage = "undone" /\ row.op.id = 0
       THEN /\ row' = Absent
            /\ cl' = [cl EXCEPT ![k] = [@ EXCEPT !.pc = "done", !.d = d,
                                                 !.res = "ok",
                                                 !.vmAt = vm]]
       ELSE IF row.desired = "deleted" /\ d # "deleted"
       THEN /\ cl' = [cl EXCEPT ![k] = [@ EXCEPT !.pc = "done", !.d = d,
                                                 !.res = "superseded",
                                                 !.by = "deleted", !.vmAt = vm,
                                                 !.other = Asked(k, "deleted")]]
            /\ UNCHANGED row
       ELSE /\ row' = [row EXCEPT
                        !.desired = d,
                        !.gen = @ + 1,
                        !.phase = "observing",
                        !.err = FALSE,
                        !.prepared = IF d = "running" THEN FALSE ELSE @]
            /\ cl' = [cl EXCEPT ![k] = [@ EXCEPT !.pc = "wait", !.d = d,
                                                 !.g = row.gen + 1]]
  /\ UNCHANGED <<up, script, read, known, linked, net, cut, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED worldVars

(* client.ts wait: a poll of getMachine that finds a rest, or no row *)
Answer(k) ==
  /\ up /\ cl[k].pc = "wait"
  /\ IF row.stage = "absent"
     THEN IF cl[k].d = "deleted" THEN Finish(k, "ok", None)
          ELSE Finish(k, "superseded", "deleted")
     ELSE /\ row.op.id = 0 \/ row.phase = "waiting"
          /\ row.phase \in Resting
          /\ IF cl[k].d = "deleted"
             THEN Finish(k, IF row.phase = "waiting" THEN "saved" ELSE "error",
                         None)
             ELSE IF row.desired # cl[k].d
             THEN Finish(k, "superseded", row.desired)
             ELSE IF row.phase = "waiting" THEN Finish(k, "saved", None)
             ELSE IF row.phase = "failed" THEN Finish(k, "error", None)
             ELSE IF row.phase = "lost" THEN Finish(k, "missing", None)
             ELSE Finish(k, "ok", None)
  /\ UNCHANGED <<row, up, script, read, known, linked, net, cut, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED worldVars

(* machines.ts advance: read the VM, with no operation in flight. A read    *)
(* over the link also teaches the control plane the host's boot.             *)
Read ==
  /\ up /\ row.stage # "absent" /\ row.op.id = 0 /\ read = None
  /\ \E v \in (IF linked THEN {vm} ELSE {"unknown"})
              \cup (IF faults < MaxFaults THEN {"unknown"} ELSE {}) :
       /\ read' = v
       /\ faults' = IF v = "unknown" /\ linked THEN faults + 1 ELSE faults
  /\ known' = IF linked THEN boot ELSE known
  /\ UNCHANGED <<row, up, script, linked, net, cut, cl, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED <<crashes, partitions, restarts, drops>>

(* machines.ts advance: rest, or begin the next step. A failed machine rests *)
(* until the next request; a failed delete runs again at each recheck.       *)
Decide ==
  /\ up /\ row.stage # "absent" /\ row.op.id = 0 /\ read # None
  /\ read' = None
  /\ LET t == Next_(row, read) IN
     IF row.phase = "failed" /\ row.stage = "made" /\ row.desired # "deleted"
     THEN UNCHANGED <<row, nextOp>>
     ELSE IF t \in Resting
     THEN /\ row' = [row EXCEPT !.phase = t]
          /\ UNCHANGED nextOp
     ELSE /\ nextOp <= MaxOps
          /\ row' = [row EXCEPT
                       !.phase = t,
                       !.op = [id |-> nextOp, kind |-> KindOf(t),
                               gen |-> row.gen, boot |-> known]]
          /\ nextOp' = nextOp + 1
  /\ UNCHANGED <<up, script, known, linked, net, cut, cl>>
  /\ UNCHANGED hostVars /\ UNCHANGED worldVars

(* machines.ts send: an operation carries the setup only from memory *)
CanSend(r) == r.op.kind # "make" \/ script

Delivery(r) == [id |-> r.op.id, kind |-> r.op.kind, boot |-> r.op.boot]

Send ==
  /\ up /\ row.stage # "absent" /\ row.op.id # 0
  /\ CanSend(row)
  /\ row.op.id > high \/ boot # row.op.boot
  /\ Delivery(row) \notin net
  /\ net' = net \cup {Delivery(row)}
  /\ UNCHANGED <<row, up, script, read, known, linked, cut, cl, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED worldVars

(* machines.ts cancel, when a later request cuts the step short *)
Cut ==
  /\ up /\ linked /\ row.stage # "absent" /\ row.op.id # 0 /\ Cuts(row)
  /\ row.op.id \notin cut
  /\ cut' = cut \cup {row.op.id}
  /\ UNCHANGED <<row, up, script, read, known, linked, net, cl, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED worldVars

(* What finishing an operation writes to the row: machines.ts settle *)
Failing(r) ==
  IF r.op.kind = "make"
  THEN [r EXCEPT !.stage = "undoing", !.err = TRUE, !.op = NoOp,
                 !.phase = "observing"]
  ELSE IF r.op.gen < r.gen
  THEN [r EXCEPT !.op = NoOp, !.phase = "observing"]
  ELSE [r EXCEPT !.err = TRUE, !.op = NoOp, !.phase = "failed"]

Done(r) ==
  CASE r.op.kind = "make" ->
         [r EXCEPT !.stage = "made", !.prepared = FALSE, !.op = NoOp,
                   !.phase = "observing"]
    [] r.op.kind = "start" ->
         [r EXCEPT !.prepared = TRUE, !.op = NoOp, !.phase = "observing"]
    [] r.op.kind \in {"stop", "pause"} ->
         [r EXCEPT !.prepared = FALSE, !.op = NoOp, !.phase = "observing"]
    [] r.op.kind = "remove" ->
         IF r.desired = "deleted" THEN Absent
         ELSE [r EXCEPT !.stage = "undone", !.op = NoOp, !.phase = "failed",
                        !.err = TRUE]

(* An operation whose host holds no report of it: restarted since it was    *)
(* sent, or never reached, with no setup left to send it again. A make is   *)
(* undone, and the remove's higher sequence fences it should it still come. *)
Lost(r) ==
  IF r.op.kind = "make"
  THEN [r EXCEPT !.stage = "undoing", !.err = TRUE, !.op = NoOp,
                 !.phase = "observing"]
  ELSE [r EXCEPT !.op = NoOp, !.phase = "observing"]

(* machines.ts follow: collect the report by ID *)
Collect ==
  /\ up /\ linked /\ row.stage # "absent" /\ row.op.id # 0
  /\ LET id == row.op.id
         held == runs.id = id
     IN \/ /\ held /\ runs.status = "done"
           /\ row' = Done(row)
           /\ runs' = NoRun
        \/ /\ held /\ runs.status = "failed"
           /\ row' = Failing(row)
           /\ runs' = NoRun
        \/ /\ held /\ runs.status = "cancelled"
           /\ row' = [row EXCEPT !.op = NoOp, !.phase = "observing"]
           /\ runs' = NoRun
        \/ /\ ~held
           /\ boot # row.op.boot \/ (id > high /\ ~CanSend(row))
           /\ row' = Lost(row)
           /\ UNCHANGED runs
  /\ known' = boot
  /\ UNCHANGED <<up, script, read, linked, net, cut, cl, nextOp>>
  /\ UNCHANGED <<vm, boot, high, applied>> /\ UNCHANGED worldVars

(* machines.ts follow: a host it can't reach rests the row at waiting, with *)
(* the operation still in flight, and a report from it takes that back.      *)
Stall ==
  /\ up /\ ~linked /\ row.stage # "absent" /\ row.op.id # 0
  /\ row.phase # "waiting"
  /\ row' = [row EXCEPT !.phase = "waiting"]
  /\ UNCHANGED <<up, script, read, known, linked, net, cut, cl, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED worldVars

Unstall ==
  /\ up /\ linked /\ row.stage # "absent" /\ row.op.id # 0
  /\ row.phase = "waiting"
  /\ row' = [row EXCEPT !.phase = PhaseOf(row.op.kind)]
  /\ UNCHANGED <<up, script, read, known, linked, net, cut, cl, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED worldVars

(* operations.ts run: the same ID is the same operation, a lower sequence   *)
(* is refused, and a higher one cuts short what still runs. A delivery dies *)
(* with the host process it was sent to.                                    *)
Deliver ==
  /\ linked
  /\ \E m \in net :
       /\ net' = net \ {m}
       /\ IF m.boot = boot /\ m.id > high
          THEN /\ high' = m.id
               /\ runs' = [id |-> m.id, kind |-> m.kind, status |-> "running",
                           pc |-> "begin"]
          ELSE UNCHANGED <<high, runs>>
  /\ UNCHANGED <<row, up, script, read, known, linked, vm, boot, cut, applied,
                 cl, nextOp>>
  /\ UNCHANGED worldVars

(* The same delivery twice: it stays in flight after the host took it *)
Repeat ==
  /\ linked
  /\ \E m \in net :
       /\ m.boot = boot /\ m.id > high
       /\ high' = m.id
       /\ runs' = [id |-> m.id, kind |-> m.kind, status |-> "running",
                   pc |-> "begin"]
  /\ UNCHANGED <<row, up, script, read, known, linked, vm, boot, net, cut,
                 applied, cl, nextOp>>
  /\ UNCHANGED worldVars

Lose ==
  /\ drops < MaxDrops
  /\ \E m \in net : net' = net \ {m}
  /\ drops' = drops + 1
  /\ UNCHANGED <<row, up, script, read, known, linked, cut, cl, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED <<faults, crashes, partitions, restarts>>

Ran(id) == applied' = [applied EXCEPT ![id] = @ + 1]

(* operations.ts perform: each step of each kind, on the runtime *)
HostStep ==
  /\ runs.id # 0 /\ runs.status = "running"
  /\ LET k == runs.kind IN
     CASE k = "make" /\ runs.pc = "begin" ->
            IF vm = "missing"
            THEN /\ vm' = "running"
                 /\ runs' = [runs EXCEPT !.pc = "setup"]
                 /\ Ran(runs.id)
            ELSE /\ runs' = [runs EXCEPT !.status = "failed"]
                 /\ UNCHANGED <<vm, applied>>
       [] k = "make" ->
            /\ runs' = [runs EXCEPT !.status = "done"]
            /\ UNCHANGED <<vm, applied>>
       [] k = "start" ->
            IF vm = "missing"
            THEN /\ runs' = [runs EXCEPT !.status = "failed"]
                 /\ UNCHANGED <<vm, applied>>
            ELSE /\ vm' = "running"
                 /\ runs' = [runs EXCEPT !.status = "done"]
                 /\ Ran(runs.id)
       [] k = "stop" ->
            /\ vm' = IF vm = "missing" THEN vm ELSE "stopped"
            /\ runs' = [runs EXCEPT !.status = "done"]
            /\ Ran(runs.id)
       [] k = "pause" ->
            IF vm \in {"running", "paused"}
            THEN /\ vm' = "paused"
                 /\ runs' = [runs EXCEPT !.status = "done"]
                 /\ Ran(runs.id)
            ELSE /\ runs' = [runs EXCEPT !.status = "failed"]
                 /\ UNCHANGED <<vm, applied>>
       [] k = "remove" ->
            /\ vm' = "missing"
            /\ runs' = [runs EXCEPT !.status = "done"]
            /\ Ran(runs.id)
  /\ UNCHANGED <<row, up, script, read, known, linked, boot, high, net, cut, cl,
                 nextOp>>
  /\ UNCHANGED worldVars

(* A setup that fails, or a step the runtime refuses *)
HostFail ==
  /\ runs.id # 0 /\ runs.status = "running"
  /\ faults < MaxFaults
  /\ faults' = faults + 1
  /\ runs' = [runs EXCEPT !.status = "failed"]
  /\ UNCHANGED <<row, up, script, read, known, linked, vm, boot, high, net, cut,
                 applied, cl, nextOp>>
  /\ UNCHANGED <<crashes, partitions, restarts, drops>>

(* operations.ts cancel: it stops the step between its runtime calls *)
HostCancel ==
  /\ runs.id # 0 /\ runs.status = "running" /\ runs.id \in cut
  /\ runs' = [runs EXCEPT !.status = "cancelled"]
  /\ UNCHANGED <<row, up, script, read, known, linked, vm, boot, high, net, cut,
                 applied, cl, nextOp>>
  /\ UNCHANGED worldVars

(* The control plane's process ends: memory goes, the store and every       *)
(* delivery already on its way stay.                                        *)
Crash ==
  /\ up /\ crashes < MaxCrashes
  /\ up' = FALSE
  /\ crashes' = crashes + 1
  /\ script' = FALSE
  /\ read' = None
  /\ UNCHANGED <<row, known, linked, net, cut, cl, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED <<faults, partitions, restarts, drops>>

Revive ==
  /\ ~up
  /\ up' = TRUE
  /\ UNCHANGED <<row, script, read, known, linked, net, cut, cl, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED worldVars

Partition ==
  /\ linked /\ partitions < MaxPartitions
  /\ linked' = FALSE
  /\ partitions' = partitions + 1
  /\ UNCHANGED <<row, up, script, read, known, net, cut, cl, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED <<faults, crashes, restarts, drops>>

Heal ==
  /\ ~linked
  /\ linked' = TRUE
  /\ UNCHANGED <<row, up, script, read, known, net, cut, cl, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED worldVars

(* The host's process ends: its operations go with it, and VMs stay *)
HostRestart ==
  /\ restarts < MaxRestarts
  /\ restarts' = restarts + 1
  /\ boot' = boot + 1
  /\ high' = 0
  /\ runs' = NoRun
  /\ UNCHANGED <<row, up, script, read, known, linked, vm, net, cut, applied, cl,
                 nextOp>>
  /\ UNCHANGED <<faults, crashes, partitions, drops>>

Init ==
  /\ row = Absent
  /\ up = TRUE
  /\ script = FALSE
  /\ read = None
  /\ known = 1
  /\ linked = TRUE
  /\ vm = "missing"
  /\ boot = 1
  /\ high = 0
  /\ runs = NoRun
  /\ net = {}
  /\ cut = {}
  /\ applied = [i \in 1..MaxOps |-> 0]
  /\ cl = [k \in Everyone |-> Idle]
  /\ nextOp = 1
  /\ faults = 0
  /\ crashes = 0
  /\ partitions = 0
  /\ restarts = 0
  /\ drops = 0

Terminated ==
  /\ row.stage = "absent" /\ net = {}
  /\ \A k \in Everyone : cl[k].pc = "done"
  /\ UNCHANGED vars

Next ==
  \/ Create \/ \E k \in Clients : Request(k)
  \/ \E k \in Everyone : Answer(k)
  \/ Read \/ Decide \/ Send \/ Cut \/ Collect \/ Stall \/ Unstall
  \/ Deliver \/ Repeat \/ Lose
  \/ HostStep \/ HostFail \/ HostCancel
  \/ Crash \/ Revive \/ Partition \/ Heal \/ HostRestart
  \/ Terminated

Spec ==
  /\ Init /\ [][Next]_vars
  /\ WF_vars(Create)
  /\ \A k \in Clients : WF_vars(Request(k))
  /\ \A k \in Everyone : WF_vars(Answer(k))
  /\ WF_vars(Read) /\ WF_vars(Decide) /\ WF_vars(Send) /\ WF_vars(Cut)
  /\ WF_vars(Collect) /\ WF_vars(Deliver) /\ WF_vars(HostStep)
  /\ WF_vars(HostCancel) /\ WF_vars(Revive) /\ WF_vars(Heal)
  /\ WF_vars(Unstall)

-----------------------------------------------------------------------------
(* A request that answers success finds the VM as it asked. *)
AnswerTrue ==
  \A k \in Everyone :
    cl[k].pc = "done" /\ cl[k].res = "ok" => Matches(cl[k].d, cl[k].vmAt)

(* A Superseded names something else that another request asked for. *)
SupersededHonest ==
  \A k \in Everyone :
    cl[k].res = "superseded" => cl[k].by # cl[k].d /\ cl[k].other

(* A row resting settled, at rest with no operation, holds the VM it says. *)
RestTrue ==
  row.stage # "absent" /\ row.phase = "settled" /\ row.op.id = 0
    => Matches(row.desired, vm)

(* A failed create, once undone, and a deleted machine leave no VM, however *)
(* late an old delivery arrives.                                            *)
NoOrphan == row.stage = "absent" \/ row.stage = "undone" => vm = "missing"

(* Duplicate delivery runs an operation once. *)
OnceOnly == \A i \in 1..MaxOps : applied[i] <= 1

(* The store's row says what it did: a failed row names its failure. *)
FailedSays ==
  row.stage # "absent" /\ row.phase = "failed" /\ row.op.id = 0 => row.err

(* Every request gets an answer. *)
AllAnswered == <>(\A k \in Everyone : cl[k].pc = "done")
=============================================================================
