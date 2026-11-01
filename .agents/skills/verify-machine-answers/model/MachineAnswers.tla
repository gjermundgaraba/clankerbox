---------------------------- MODULE MachineAnswers ----------------------------
(***************************************************************************)
(* One machine, from its create to its delete, across the control plane,   *)
(* a host, the network between them, and clients that wait by reading the  *)
(* row. The control plane may crash, the host may restart, the link may    *)
(* partition, and a delivery may repeat, arrive late or be lost. Every     *)
(* action names the code it stands for; the skill's coverage table maps    *)
(* each one to its file and function. Every write of the row is the        *)
(* chart's, through Row: Chart.tla is generated from it.                   *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences, Chart

CONSTANTS Clients, Creator, Desires,
          MaxFaults, MaxCrashes, MaxPartitions, MaxRestarts, MaxDrops, MaxOps

None == "none"
Everyone == Clients \cup {Creator}
NoOp == [id |-> 0, kind |-> None, boot |-> 0]
NoRun == [id |-> 0, kind |-> None, status |-> None, pc |-> None]
Absent == [state |-> "absent", desired |-> None, prepared |-> FALSE, err |-> FALSE,
           op |-> NoOp]

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

Idle == [pc |-> "idle", d |-> None, res |-> None, by |-> None, vmAt |-> None,
         other |-> FALSE]

(* chart.ts applied: what the chart writes for an event, whose key is the   *)
(* row's leaf, wish and flags. Chart.tla lists only the writes that change  *)
(* the row, so a key it lacks is an event the chart leaves unhandled.       *)
Flag(b) == IF b THEN "1" ELSE "0"
Key(r, e) ==
  r.state \o "|" \o r.desired \o "|" \o Flag(r.prepared) \o "|" \o Flag(r.err)
    \o "|" \o e
To(r, e) ==
  IF Key(r, e) \in Keys
  THEN Table[Key(r, e)]
  ELSE [state |-> r.state, desired |-> r.desired, prepared |-> r.prepared,
        err |-> r.err]
Row(r, e, op) ==
  LET t == To(r, e) IN
  IF t.state = "gone"
  THEN Absent
  ELSE [state |-> t.state, desired |-> t.desired, prepared |-> t.prepared,
        err |-> t.err, op |-> op]

Phase(r) == IF r.state = "absent" THEN None ELSE PhaseOf[r.state]
IsStep(s) == s # "gone" /\ StepOf[s] # "none"

(* machine-chart.ts wants: which steps what is asked now still wants *)
Wants(r) == r.desired \in Wanted[r.op.kind]

(* What a success answer promises of the VM, for each request *)
Matches(d, v) ==
  CASE d = "running" -> v = "running"
    [] d = "stopped" -> v = "stopped"
    [] d = "paused" -> v \in {"paused", "stopped"}
    [] d = "deleted" -> v = "missing"

(* machine-view.ts phaseShown: a read that can't reach the VM shows         *)
(* waiting; a client's read goes over the same link as the loop's.          *)
Shown == IF ~linked /\ Phase(row) # "failed" THEN "waiting" ELSE Phase(row)

Asked(k, d) == \E j \in Everyone \ {k} : cl[j].pc # "idle" /\ cl[j].d = d

Finish(k, res, by) ==
  cl' = [cl EXCEPT ![k] = [@ EXCEPT !.pc = "done", !.res = res, !.by = by,
                                    !.vmAt = vm, !.other = Asked(k, by)]]

(* machines.ts born, through store.insertMachine *)
Create ==
  /\ up /\ row.state = "absent" /\ cl[Creator].pc = "idle"
  /\ row' = [state |-> "making.due", desired |-> "running", prepared |-> FALSE,
             err |-> FALSE, op |-> NoOp]
  /\ script' = TRUE
  /\ cl' = [cl EXCEPT ![Creator] = [@ EXCEPT !.pc = "wait", !.d = "running"]]
  /\ UNCHANGED <<up, read, known, linked, net, cut, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED worldVars

(* machines.ts asked and remove, through the chart's ask and delete: a      *)
(* failed create has no machine to ask for, its row goes with a delete, and *)
(* a delete has no way back.                                                *)
Request(k) ==
  /\ up /\ cl[k].pc = "idle"
  /\ \E d \in Desires :
       LET e == IF d = "deleted" THEN "delete" ELSE "ask:" \o d IN
       IF row.state = "absent"
       THEN /\ cl' = [cl EXCEPT ![k] = [@ EXCEPT !.pc = "done", !.d = d,
                                                 !.res = "notfound"]]
            /\ UNCHANGED row
       ELSE IF row.state \in FailedCreate /\ d # "deleted"
       THEN /\ cl' = [cl EXCEPT ![k] = [@ EXCEPT !.pc = "done", !.d = d,
                                                 !.res = "notfound"]]
            /\ UNCHANGED row
       ELSE IF row.state = Undone
       THEN /\ row' = Row(row, e, NoOp)
            /\ cl' = [cl EXCEPT ![k] = [@ EXCEPT !.pc = "done", !.d = d,
                                                 !.res = "ok",
                                                 !.vmAt = vm]]
       ELSE IF row.desired = "deleted" /\ d # "deleted"
       THEN /\ cl' = [cl EXCEPT ![k] = [@ EXCEPT !.pc = "done", !.d = d,
                                                 !.res = "superseded",
                                                 !.by = "deleted", !.vmAt = vm,
                                                 !.other = Asked(k, "deleted")]]
            /\ UNCHANGED row
       ELSE /\ row' = Row(row, e, row.op)
            /\ cl' = [cl EXCEPT ![k] = [@ EXCEPT !.pc = "wait", !.d = d]]
  /\ UNCHANGED <<up, script, read, known, linked, net, cut, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED worldVars

(* client.ts machineRest and machineGone: a poll of getMachine that finds a *)
(* rest, or no row, and answerOf, what the rest says of the request         *)
Answer(k) ==
  /\ up /\ cl[k].pc = "wait"
  /\ IF row.state = "absent"
     THEN IF cl[k].d = "deleted" THEN Finish(k, "ok", None)
          ELSE Finish(k, "superseded", "deleted")
     ELSE /\ row.op.id = 0 \/ Shown = "waiting"
          /\ Shown \in Resting \cup {"waiting"}
          /\ IF cl[k].d = "deleted"
             THEN Finish(k, IF Shown = "waiting" THEN "saved" ELSE "error",
                         None)
             ELSE IF row.desired # cl[k].d
             THEN Finish(k, "superseded", row.desired)
             ELSE IF Shown = "waiting" THEN Finish(k, "saved", None)
             ELSE IF Shown = "failed" THEN Finish(k, "error", None)
             ELSE IF Shown = "lost" THEN Finish(k, "missing", None)
             ELSE Finish(k, "ok", None)
  /\ UNCHANGED <<row, up, script, read, known, linked, net, cut, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED worldVars

(* machines.ts looking, through machine-view.ts stateOf: read the VM, with  *)
(* no operation in flight. A read over the link also teaches the control    *)
(* plane the host's boot.                                                   *)
Read ==
  /\ up /\ row.state # "absent" /\ row.op.id = 0 /\ read = None
  /\ \E v \in (IF linked THEN {vm} ELSE {"unknown"})
              \cup (IF faults < MaxFaults THEN {"unknown"} ELSE {}) :
       /\ read' = v
       /\ faults' = IF v = "unknown" /\ linked THEN faults + 1 ELSE faults
  /\ known' = IF linked THEN boot ELSE known
  /\ UNCHANGED <<row, up, script, linked, net, cut, cl, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED <<crashes, partitions, restarts, drops>>

(* machines.ts looking, through store.advance: the chart's read event       *)
(* decides a rest, the next step, or no write, as for a failed machine,     *)
(* which rests until the next request, or a read that failed. A failed      *)
(* delete runs again at each recheck. A write into a leaf with a step       *)
(* begins its operation.                                                    *)
Decide ==
  /\ up /\ row.state # "absent" /\ row.op.id = 0 /\ read # None
  /\ read' = None
  /\ LET e == "read:" \o read
         to == To(row, e).state
     IN IF IsStep(to)
        THEN /\ nextOp <= MaxOps
             /\ row' = Row(row, e, [id |-> nextOp, kind |-> StepOf[to],
                                    boot |-> known])
             /\ nextOp' = nextOp + 1
        ELSE /\ row' = Row(row, e, NoOp)
             /\ UNCHANGED nextOp
  /\ UNCHANGED <<up, script, known, linked, net, cut, cl>>
  /\ UNCHANGED hostVars /\ UNCHANGED worldVars

(* operations.ts poll, with steps.ts machineStep: an operation carries the *)
(* setup only from memory.                                                  *)
CanSend(r) == r.op.kind # "make" \/ script

Delivery(r) == [id |-> r.op.id, kind |-> r.op.kind, boot |-> r.op.boot]

Send ==
  /\ up /\ row.state # "absent" /\ row.op.id # 0
  /\ CanSend(row)
  /\ row.op.id > high \/ boot # row.op.boot
  /\ Delivery(row) \notin net
  /\ net' = net \cup {Delivery(row)}
  /\ UNCHANGED <<row, up, script, read, known, linked, cut, cl, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED worldVars

(* operations.ts poll, cut when a later request no longer wants the step *)
Cut ==
  /\ up /\ linked /\ row.state # "absent" /\ row.op.id # 0 /\ ~Wants(row)
  /\ row.op.id \notin cut
  /\ cut' = cut \cup {row.op.id}
  /\ UNCHANGED <<row, up, script, read, known, linked, net, cl, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED worldVars

(* An operation whose host holds no report of it has restarted since it was *)
(* sent, or never had it, with no setup left to send it again. A make is    *)
(* undone, and the remove's higher sequence fences it should it still come. *)
(* machines.ts following, after operations.ts poll: store the report by    *)
(* ID, then operations.ts collect.                                          *)
Collect ==
  /\ up /\ linked /\ row.state # "absent" /\ row.op.id # 0
  /\ LET id == row.op.id
         held == runs.id = id
     IN \/ /\ held /\ runs.status = "done"
           /\ row' = Row(row, "reported:done", NoOp)
           /\ runs' = NoRun
        \/ /\ held /\ runs.status = "failed"
           /\ row' = Row(row, "reported:failed", NoOp)
           /\ runs' = NoRun
        \/ /\ held /\ runs.status = "cancelled"
           /\ row' = Row(row, "reported:cancelled", NoOp)
           /\ runs' = NoRun
        \/ /\ ~held
           /\ boot # row.op.boot \/ (id > high /\ ~CanSend(row))
           /\ row' = Row(row, "lost", NoOp)
           /\ UNCHANGED runs
  /\ known' = boot
  /\ UNCHANGED <<up, script, read, linked, net, cut, cl, nextOp>>
  /\ UNCHANGED <<vm, boot, high, applied>> /\ UNCHANGED worldVars

(* The host's operations.ts run: the same ID is the same operation, a lower *)
(* sequence is refused, and a higher one cuts short what still runs. A      *)
(* delivery dies with the host process it was sent to.                      *)
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

(* The host's operations.ts perform: each step of each kind, on the runtime *)
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

(* The host's operations.ts cancel: it stops the step between its runtime  *)
(* calls.                                                                   *)
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
  /\ row.state = "absent" /\ net = {}
  /\ \A k \in Everyone : cl[k].pc = "done"
  /\ UNCHANGED vars

Next ==
  \/ Create \/ \E k \in Clients : Request(k)
  \/ \E k \in Everyone : Answer(k)
  \/ Read \/ Decide \/ Send \/ Cut \/ Collect
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
  row.state # "absent" /\ Phase(row) = "settled" /\ row.op.id = 0
    => Matches(row.desired, vm)

(* A failed create, once undone, and a deleted machine leave no VM, however *)
(* late an old delivery arrives.                                            *)
NoOrphan == row.state = "absent" \/ row.state = Undone => vm = "missing"

(* Duplicate delivery runs an operation once. *)
OnceOnly == \A i \in 1..MaxOps : applied[i] <= 1

(* The store's row says what it did: a failed row names its failure. *)
FailedSays ==
  row.state # "absent" /\ Phase(row) = "failed" /\ row.op.id = 0 => row.err

(* An operation is in flight exactly while the row's leaf has a step. *)
OpIsState == row.state # "absent" => (row.op.id # 0 <=> IsStep(row.state))

(* Every request gets an answer. *)
AllAnswered == <>(\A k \in Everyone : cl[k].pc = "done")
=============================================================================
