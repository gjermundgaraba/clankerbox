---------------------------- MODULE MachineAnswers ----------------------------
EXTENDS Naturals, FiniteSets, Sequences, Chart

CONSTANTS Clients, Creator, Desires, Drifts, LandsLate,
          MaxFaults, MaxCrashes, MaxPartitions, MaxRestarts, MaxDrops, MaxOps

None == "none"
Everyone == Clients \cup {Creator}
NoOp == [id |-> 0, kind |-> None, boot |-> 0]
NoRun == [id |-> 0, kind |-> None, status |-> None, pc |-> None,
          prepared |-> FALSE]
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
  drops,      \* deliveries lost so far
  drift,      \* none; unread once the VM stops by itself, until a read that
              \* saw it is decided; then read
  late,       \* none; out once a make's call may yet land; then landed
  sent        \* a sweep on its way to the host names the instance retired

vars == <<row, up, script, read, known, linked, vm, boot, high, runs, net, cut,
          applied, cl, nextOp, faults, crashes, partitions, restarts,
          drops, drift, late, sent>>

hostVars == <<vm, boot, high, runs, applied>>
worldVars == <<faults, crashes, partitions, restarts, drops, drift, late, sent>>

Idle == [pc |-> "idle", d |-> None, res |-> None, by |-> None, vmAt |-> None,
         other |-> FALSE, excused |-> FALSE, pre |-> "none"]

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

Wants(r) == r.desired \in Wanted[r.op.kind]

Matches(d, v) ==
  CASE d = "running" -> v = "running"
    [] d = "stopped" -> v = "stopped"
    [] d = "paused" -> v \in {"paused", "stopped"}
    [] d = "deleted" -> v = "missing"

Shown == IF ~linked /\ Phase(row) # "failed" THEN "waiting" ELSE Phase(row)

Asked(k, d) == \E j \in Everyone \ {k} : cl[j].pc # "idle" /\ cl[j].d = d

Orphaned == (row.state = "absent" \/ row.state = Undone) /\ vm # "missing"

Landed == late = "landed" /\ vm # "missing"

Excused(k) == (drift = "unread" /\ cl[k].pre = "none") \/ Landed

Finish(k, res, by) ==
  cl' = [cl EXCEPT ![k] = [@ EXCEPT !.pc = "done", !.res = res, !.by = by,
                                    !.vmAt = vm, !.other = Asked(k, by),
                                    !.excused = Excused(k)]]

Create ==
  /\ up /\ row.state = "absent" /\ cl[Creator].pc = "idle"
  /\ row' = [state |-> "making.due", desired |-> "running", prepared |-> FALSE,
             err |-> FALSE, op |-> NoOp]
  /\ script' = TRUE
  /\ cl' = [cl EXCEPT ![Creator] = [@ EXCEPT !.pc = "wait", !.d = "running"]]
  /\ UNCHANGED <<up, read, known, linked, net, cut, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED worldVars

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
                                                 !.vmAt = vm,
                                                 !.excused = Landed]]
       ELSE IF row.desired = "deleted" /\ d # "deleted"
       THEN /\ cl' = [cl EXCEPT ![k] = [@ EXCEPT !.pc = "done", !.d = d,
                                                 !.res = "superseded",
                                                 !.by = "deleted", !.vmAt = vm,
                                                 !.other = Asked(k, "deleted")]]
            /\ UNCHANGED row
       ELSE /\ row' = Row(row, e, row.op)
            /\ cl' = [cl EXCEPT ![k] = [@ EXCEPT !.pc = "wait", !.d = d,
                                                 !.pre = drift]]
  /\ UNCHANGED <<up, script, read, known, linked, net, cut, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED worldVars

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

Read ==
  /\ up /\ row.state # "absent" /\ row.op.id = 0 /\ read = None
  /\ \E v \in (IF linked THEN {vm} ELSE {"unknown"})
              \cup (IF faults < MaxFaults THEN {"unknown"} ELSE {}) :
       /\ read' = v
       /\ faults' = IF v = "unknown" /\ linked THEN faults + 1 ELSE faults
  /\ known' = IF linked THEN boot ELSE known
  /\ UNCHANGED <<row, up, script, linked, net, cut, cl, nextOp>>
  /\ UNCHANGED hostVars
  /\ UNCHANGED <<crashes, partitions, restarts, drops, drift, late, sent>>

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
  /\ drift' = IF drift = "unread" /\ read = vm THEN "read" ELSE drift
  /\ UNCHANGED <<up, script, known, linked, net, cut, cl>>
  /\ UNCHANGED hostVars
  /\ UNCHANGED <<faults, crashes, partitions, restarts, drops, late, sent>>

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

Cut ==
  /\ up /\ linked /\ row.state # "absent" /\ row.op.id # 0 /\ ~Wants(row)
  /\ row.op.id \notin cut
  /\ cut' = cut \cup {row.op.id}
  /\ UNCHANGED <<row, up, script, read, known, linked, net, cl, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED worldVars

Collect ==
  /\ up /\ linked /\ row.state # "absent" /\ row.op.id # 0
  /\ LET id == row.op.id
         held == runs.id = id
     IN \/ /\ held /\ runs.status = "done"
           /\ row' = Row(row, IF runs.prepared THEN "reported:prepared"
                                               ELSE "reported:done", NoOp)
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

Deliver ==
  /\ linked
  /\ \E m \in net :
       /\ net' = net \ {m}
       /\ IF m.boot = boot /\ m.id > high
          THEN /\ high' = m.id
               /\ runs' = [id |-> m.id, kind |-> m.kind, status |-> "running",
                           pc |-> "begin", prepared |-> FALSE]
          ELSE UNCHANGED <<high, runs>>
  /\ UNCHANGED <<row, up, script, read, known, linked, vm, boot, cut, applied,
                 cl, nextOp>>
  /\ UNCHANGED worldVars

Repeat ==
  /\ linked
  /\ \E m \in net :
       /\ m.boot = boot /\ m.id > high
       /\ high' = m.id
       /\ runs' = [id |-> m.id, kind |-> m.kind, status |-> "running",
                   pc |-> "begin", prepared |-> FALSE]
  /\ UNCHANGED <<row, up, script, read, known, linked, vm, boot, net, cut,
                 applied, cl, nextOp>>
  /\ UNCHANGED worldVars

Lose ==
  /\ drops < MaxDrops
  /\ \E m \in net : net' = net \ {m}
  /\ drops' = drops + 1
  /\ UNCHANGED <<row, up, script, read, known, linked, cut, cl, nextOp>>
  /\ UNCHANGED hostVars
  /\ UNCHANGED <<faults, crashes, partitions, restarts, drift, late, sent>>

Ran(id) == applied' = [applied EXCEPT ![id] = @ + 1]

Lands ==
  LandsLate /\ late = "none" /\ runs.kind = "make" /\ runs.pc = "begin"

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
            /\ \E p \in BOOLEAN :
                 runs' = [runs EXCEPT !.status = "done", !.prepared = p]
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

HostFail ==
  /\ runs.id # 0 /\ runs.status = "running"
  /\ faults < MaxFaults
  /\ faults' = faults + 1
  /\ runs' = [runs EXCEPT !.status = "failed"]
  /\ late' = IF Lands THEN "out" ELSE late
  /\ UNCHANGED <<row, up, script, read, known, linked, vm, boot, high, net, cut,
                 applied, cl, nextOp>>
  /\ UNCHANGED <<crashes, partitions, restarts, drops, drift, sent>>

HostCancel ==
  /\ runs.id # 0 /\ runs.status = "running" /\ runs.id \in cut
  /\ runs' = [runs EXCEPT !.status = "cancelled"]
  /\ UNCHANGED <<row, up, script, read, known, linked, vm, boot, high, net, cut,
                 applied, cl, nextOp>>
  /\ UNCHANGED worldVars

Crash ==
  /\ up /\ crashes < MaxCrashes
  /\ up' = FALSE
  /\ crashes' = crashes + 1
  /\ script' = FALSE
  /\ read' = None
  /\ UNCHANGED <<row, known, linked, net, cut, cl, nextOp>>
  /\ UNCHANGED hostVars
  /\ UNCHANGED <<faults, partitions, restarts, drops, drift, late, sent>>

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
  /\ UNCHANGED hostVars
  /\ UNCHANGED <<faults, crashes, restarts, drops, drift, late, sent>>

Heal ==
  /\ ~linked
  /\ linked' = TRUE
  /\ UNCHANGED <<row, up, script, read, known, net, cut, cl, nextOp>>
  /\ UNCHANGED hostVars /\ UNCHANGED worldVars

HostRestart ==
  /\ restarts < MaxRestarts
  /\ restarts' = restarts + 1
  /\ boot' = boot + 1
  /\ high' = 0
  /\ runs' = NoRun
  /\ late' = IF runs.status = "running" /\ Lands THEN "out" ELSE late
  /\ UNCHANGED <<row, up, script, read, known, linked, vm, net, cut, applied, cl,
                 nextOp>>
  /\ UNCHANGED <<faults, crashes, partitions, drops, drift, sent>>

Drift ==
  /\ Drifts /\ drift = "none" /\ vm = "running"
  /\ vm' = "stopped"
  /\ drift' = "unread"
  /\ UNCHANGED <<row, up, script, read, known, linked, boot, high, runs, net,
                 cut, applied, cl, nextOp>>
  /\ UNCHANGED <<faults, crashes, partitions, restarts, drops, late, sent>>

LandLate ==
  /\ late = "out" /\ vm = "missing"
  /\ vm' = "running"
  /\ late' = "landed"
  /\ UNCHANGED <<row, up, script, read, known, linked, boot, high, runs, net,
                 cut, applied, cl, nextOp>>
  /\ UNCHANGED <<faults, crashes, partitions, restarts, drops, drift, sent>>

\* The store retired the one instance once its row, after the create, no longer
\* holds it: the row went or rests undone. No row takes it again.
Retired == cl[Creator].pc # "idle" /\ row.state \in {"absent", Undone}

SweepRead ==
  /\ up /\ ~sent /\ Retired
  /\ sent' = TRUE
  /\ UNCHANGED <<row, up, script, read, known, linked, net, cut, cl, nextOp>>
  /\ UNCHANGED hostVars
  /\ UNCHANGED <<faults, crashes, partitions, restarts, drops, drift, late>>

Sweep ==
  /\ linked /\ sent /\ runs.id = 0 /\ vm # "missing"
  /\ vm' = "missing"
  /\ sent' = FALSE
  /\ UNCHANGED <<row, up, script, read, known, linked, boot, high, runs, net,
                 cut, applied, cl, nextOp>>
  /\ UNCHANGED <<faults, crashes, partitions, restarts, drops, drift, late>>

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
  /\ drift = "none"
  /\ late = "none"
  /\ sent = FALSE

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
  \/ Drift \/ LandLate \/ SweepRead \/ Sweep
  \/ Terminated

Spec ==
  /\ Init /\ [][Next]_vars
  /\ WF_vars(Create)
  /\ \A k \in Clients : WF_vars(Request(k))
  /\ \A k \in Everyone : WF_vars(Answer(k))
  /\ WF_vars(Read) /\ WF_vars(Decide) /\ WF_vars(Send) /\ WF_vars(Cut)
  /\ WF_vars(Collect) /\ WF_vars(Deliver) /\ WF_vars(HostStep)
  /\ WF_vars(HostCancel) /\ WF_vars(Revive) /\ WF_vars(Heal)
  /\ WF_vars(SweepRead) /\ WF_vars(Sweep)

-----------------------------------------------------------------------------
AnswerTrue ==
  \A k \in Everyone :
    cl[k].pc = "done" /\ cl[k].res = "ok"
      => Matches(cl[k].d, cl[k].vmAt) \/ cl[k].excused

SupersededHonest ==
  \A k \in Everyone :
    cl[k].res = "superseded" => cl[k].by # cl[k].d /\ cl[k].other

RestTrue ==
  row.state # "absent" /\ Phase(row) = "settled" /\ row.op.id = 0
    => Matches(row.desired, vm) \/ drift = "unread"

NoOrphan == Orphaned => late = "landed"

EventuallyNoOrphan == Orphaned ~> vm = "missing"

WantsRunning ==
  row.desired = "running" /\ row.state \notin FailedCreate \cup {"absent"}

RunsWhenWanted ==
  WantsRunning
    ~> \/ vm = "running" \/ ~WantsRunning \/ Phase(row) = "lost"
       \/ Phase(row) = "failed" /\ faults > 0

OnceOnly == \A i \in 1..MaxOps : applied[i] <= 1

FailedSays ==
  row.state # "absent" /\ Phase(row) = "failed" /\ row.op.id = 0 => row.err

OpIsState == row.state # "absent" => (row.op.id # 0 <=> IsStep(row.state))

AllAnswered == <>(\A k \in Everyone : cl[k].pc = "done")
=============================================================================
