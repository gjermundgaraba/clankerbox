---------------------------- MODULE MachineAnswers ----------------------------
(***************************************************************************)
(* One made machine on a clankerbox host, the requests that move it, and   *)
(* the answers they get. Every action names the code it stands for; the    *)
(* skill's coverage table maps each one to its file and function.          *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Clients, Desires, MaxFaults, Ids

None == 0
Resting == {"waiting", "settled", "joining", "failed", "lost"}
Stepping == {"starting", "stopping", "pausing"}
Invoking == {"observing", "starting", "stopping", "pausing", "deleting", "joining"}
Src(s) == CASE s = "observing" -> "observe"
            [] s = "starting" -> "start"
            [] s = "stopping" -> "stop"
            [] s = "pausing" -> "pause"
            [] s = "deleting" -> "remove"
            [] s = "joining" -> "join"
Steps == {"start", "stop", "pause", "remove"}

VARIABLES
  vm,       \* what the runtime holds: running, stopped, paused or missing
  row,      \* the machine's row exists in the store
  sgen,     \* the row's generation
  sdes,     \* the row's desired
  st,       \* the actor's state (lifecycle.ts)
  ctx,      \* the actor's context, the fields of Life the answer reads
  cur,      \* the fiber of the current state's invoke, or None
  mbox,     \* the actor's mailbox, in order
  renewed,  \* the context object changed since the recheck took its snapshot
  fib,      \* the Effect fibers invokes run in
  own,      \* the fiber owning the machine's lease, or None
  share,    \* the fibers sharing it
  cl,       \* each request, from settledOn/remove to its answer
  rc,       \* the recheck loop
  faults    \* runtime failures so far

vars == <<vm, row, sgen, sdes, st, ctx, cur, mbox, renewed, fib, own, share,
          cl, rc, faults>>

Free == [src |-> "none", gen |-> 0, seen |-> "none", pc |-> "free",
         active |-> FALSE]
NewFib(src, c) == [src |-> src, gen |-> c.gen, seen |-> c.seen, pc |-> "start",
                   active |-> TRUE]
Ev(t, d, g, v, id) == [t |-> t, d |-> d, g |-> g, v |-> v, id |-> id]
Idle == [pc |-> "idle", d |-> "none", g |-> 0, sent |-> "none", res |-> "none",
         by |-> "none", vmAt |-> "none", other |-> FALSE]

(* reconcile.ts next, for a made machine, and lifecycle.ts decide *)
Next_(c) ==
  IF c.desired = "deleted" THEN "deleting"
  ELSE IF c.seen = "unknown" THEN "waiting"
  ELSE IF c.seen = "missing" THEN "lost"
  ELSE IF c.desired = "paused"
       THEN IF c.seen = "running" THEN "pausing" ELSE "settled"
  ELSE IF c.desired = "stopped"
       THEN IF c.seen = "stopped" THEN "settled" ELSE "stopping"
  ELSE IF c.seen = "running" /\ c.prepared THEN "settled" ELSE "starting"

Decide(c) ==
  IF Next_(c) = "settled" /\ c.seen = "running" /\ c.join THEN "joining"
  ELSE Next_(c)

(* lifecycle.ts wanted: a desire no newer than the context returns it as is *)
Wanted(c, e) ==
  IF e.g <= c.gen THEN c
  ELSE IF c.desired = "deleted" THEN [c EXCEPT !.gen = e.g, !.error = FALSE]
  ELSE [c EXCEPT !.desired = e.d, !.gen = e.g,
                 !.prepared = IF e.d = "running" THEN FALSE ELSE c.prepared,
                 !.error = FALSE]

Stay(c, renew) == [to |-> "stay", c |-> c, renew |-> renew]
Go(t, c, renew) == [to |-> t, c |-> c, renew |-> renew]

(* lifecycle.ts again, reread, failing *)
Again(c, e) == LET w == Wanted(c, e) IN Go("observing", w, w # c)
Reread(c, v) == Go("deciding", [c EXCEPT !.seen = v], TRUE)
Failing(c, g) ==
  IF g < c.gen THEN Go("observing", c, TRUE)
  ELSE Go("failed", [c EXCEPT !.error = TRUE], TRUE)

(* lifecycle.ts: each state's handler for one event *)
Handle(s, c, e) ==
  CASE e.t = "desire" ->
         (CASE s \in Resting -> Again(c, e)
            [] s \in Stepping ->
                 LET w == Wanted(c, e) IN
                 IF w.desired = c.desired THEN Stay(w, w # c)
                 ELSE Go("observing", w, TRUE)
            [] OTHER -> LET w == Wanted(c, e) IN Stay(w, w # c))
    [] e.t = "seen" ->
         (CASE s \in {"waiting", "settled", "lost"} -> Reread(c, e.v)
            [] s = "joining" ->
                 IF e.v \in {"running", "unknown"} THEN Stay(c, FALSE)
                 ELSE Reread(c, e.v)
            [] s = "failed" ->
                 IF c.desired = "deleted" THEN Reread(c, e.v) ELSE Stay(c, FALSE)
            [] OTHER -> Stay(c, FALSE))
    [] e.t = "done" ->
         (CASE s = "observing" -> Reread(c, e.v)
            [] s = "starting" ->
                 Go("observing", [c EXCEPT !.prepared = TRUE, !.join = TRUE], TRUE)
            [] s \in {"stopping", "pausing"} ->
                 Go("observing", [c EXCEPT !.prepared = FALSE], TRUE)
            [] s = "deleting" -> Go("removed", c, FALSE)
            [] s = "joining" -> Go("settled", [c EXCEPT !.join = FALSE], TRUE))
    [] e.t = "error" -> Failing(c, e.g)

(* lifecycle.ts answer: the first snapshot done, or resting at the generation *)
Satisfies(s, c, g) == s = "removed" \/ (s \in Resting /\ c.gen >= g)

(* machines.ts answered, and remove *)
Result(k, s, c) ==
  IF cl[k].d = "deleted"
  THEN IF s # "removed" /\ c.error THEN "error" ELSE "ok"
  ELSE IF s = "removed" \/ c.desired # cl[k].d THEN "superseded"
  ELSE IF s = "waiting" THEN "internal"
  ELSE IF s = "failed" THEN "error"
  ELSE IF s = "lost" THEN "missing"
  ELSE "ok"

By(k, s, c) ==
  IF Result(k, s, c) # "superseded" THEN "none"
  ELSE IF s = "removed" THEN "deleted" ELSE c.desired

Asked(k, d) == \E j \in Clients \ {k} : cl[j].pc # "idle" /\ cl[j].d = d

Answer(k, s, c) ==
  [cl[k] EXCEPT !.pc = "done", !.res = Result(k, s, c), !.by = By(k, s, c),
                !.vmAt = vm, !.other = Asked(k, By(k, s, c))]

AnswerAll(s, c) ==
  [k \in Clients |->
     IF cl[k].pc = "wait" /\ Satisfies(s, c, cl[k].g) THEN Answer(k, s, c)
     ELSE cl[k]]

FreeIds == {i \in Ids : fib[i].pc = "free"}

Purge(q, id) == SelectSeq(q, LAMBDA e : ~(e.t \in {"done", "error"} /\ e.id = id))

(* xstate leaving a state: @xstate/effect cancels its invoke's fiber, which  *)
(* drops that fiber's result, and the next state's invoke starts at once.   *)
Move(to, c, renew, rest) ==
  /\ st' = to
  /\ ctx' = c
  /\ renewed' = (renewed \/ renew)
  /\ cl' = AnswerAll(to, c)
  /\ IF to \in Invoking
     THEN \E i \in FreeIds :
            /\ fib' = [j \in Ids |->
                         IF j = i THEN NewFib(Src(to), c)
                         ELSE IF j = cur THEN [fib[j] EXCEPT !.active = FALSE]
                         ELSE fib[j]]
            /\ cur' = i
     ELSE /\ fib' = [j \in Ids |->
                       IF j = cur THEN [fib[j] EXCEPT !.active = FALSE]
                       ELSE fib[j]]
          /\ cur' = None
  /\ mbox' = IF cur # None THEN Purge(rest, cur) ELSE rest

(* a removed actor is done: its mailbox is never read again *)
Drained ==
  /\ mbox # <<>>
  /\ st = "removed"
  /\ mbox' = Tail(mbox)
  /\ UNCHANGED <<vm, row, sgen, sdes, st, ctx, cur, renewed, fib, own, share, cl, rc, faults>>

ActorStep ==
  /\ mbox # <<>>
  /\ st # "removed"
  /\ LET e == Head(mbox)
         h == Handle(st, ctx, e)
         to == IF h.to = "deciding" THEN Decide(h.c) ELSE h.to
     IN IF h.to = "stay"
        THEN /\ ctx' = h.c
             /\ renewed' = (renewed \/ h.renew)
             /\ mbox' = Tail(mbox)
             /\ cl' = AnswerAll(st, h.c)
             /\ UNCHANGED <<st, cur, fib>>
        ELSE Move(to, h.c, h.renew, Tail(mbox))
  /\ UNCHANGED <<vm, row, sgen, sdes, own, share, rc, faults>>

Deliver(i, t, v) ==
  mbox' = IF fib[i].active THEN Append(mbox, Ev(t, "none", fib[i].gen, v, i))
          ELSE mbox

(* machines.ts observeOne: a read under the machine's shared lease *)
ObserveLease(i) ==
  /\ fib[i].src = "observe" /\ fib[i].pc = "start" /\ fib[i].active
  /\ own = None
  /\ share' = share \cup {i}
  /\ fib' = [fib EXCEPT ![i].pc = "held"]
  /\ UNCHANGED <<vm, row, sgen, sdes, st, ctx, cur, mbox, renewed, own, cl, rc, faults>>

ObserveRead(i) ==
  /\ fib[i].src = "observe" /\ fib[i].pc = "held"
  /\ \E v \in {vm} \cup (IF faults < MaxFaults THEN {"unknown"} ELSE {}) :
       /\ faults' = IF v = "unknown" THEN faults + 1 ELSE faults
       /\ Deliver(i, "done", v)
  /\ share' = share \ {i}
  /\ fib' = [fib EXCEPT ![i] = Free]
  /\ UNCHANGED <<vm, row, sgen, sdes, st, ctx, cur, renewed, own, cl, rc>>

(* machines.ts owning: a step under the machine's owned lease *)
StepLease(i) ==
  /\ fib[i].src \in Steps /\ fib[i].pc = "start" /\ fib[i].active
  /\ own = None /\ share = {}
  /\ own' = i
  /\ fib' = [fib EXCEPT ![i].pc = "held"]
  /\ UNCHANGED <<vm, row, sgen, sdes, st, ctx, cur, mbox, renewed, share, cl, rc, faults>>

Applies(src) ==
  CASE src = "start" -> vm # "missing"
    [] src = "pause" -> vm \in {"running", "paused"}
    [] OTHER -> TRUE

Effect(src) ==
  CASE src = "start" -> "running"
    [] src = "stop" -> IF vm = "missing" THEN "missing" ELSE "stopped"
    [] src = "pause" -> "paused"
    [] src = "remove" -> "missing"

Release(i) ==
  /\ own' = None
  /\ fib' = [fib EXCEPT ![i] = Free]

(* the runtime call itself, which runs on once begun, cut short or not *)
StepApply(i) ==
  /\ fib[i].src \in Steps /\ fib[i].pc = "held"
  /\ IF Applies(fib[i].src)
     THEN /\ vm' = Effect(fib[i].src)
          /\ row' = (row /\ fib[i].src # "remove")
          /\ fib' = [fib EXCEPT ![i].pc = "applied"]
          /\ UNCHANGED <<own, mbox>>
     ELSE /\ Release(i)
          /\ Deliver(i, "error", "none")
          /\ UNCHANGED <<vm, row>>
  /\ UNCHANGED <<sgen, sdes, st, ctx, cur, renewed, share, cl, rc, faults>>

StepFail(i) ==
  /\ fib[i].src \in Steps /\ fib[i].pc = "held"
  /\ faults < MaxFaults
  /\ faults' = faults + 1
  /\ Release(i)
  /\ Deliver(i, "error", "none")
  /\ UNCHANGED <<vm, row, sgen, sdes, st, ctx, cur, renewed, share, cl, rc>>

(* a step interrupted before its runtime call begins *)
StepAbort(i) ==
  /\ fib[i].src \in Steps /\ fib[i].pc = "held" /\ ~fib[i].active
  /\ Release(i)
  /\ UNCHANGED <<vm, row, sgen, sdes, st, ctx, cur, mbox, renewed, share, cl, rc, faults>>

StepFinish(i) ==
  /\ fib[i].pc = "applied"
  /\ Release(i)
  /\ Deliver(i, "done", "none")
  /\ UNCHANGED <<vm, row, sgen, sdes, st, ctx, cur, renewed, share, cl, rc, faults>>

(* machines.ts steps.start: prepare fails after the VM started *)
PrepareFail(i) ==
  /\ fib[i].pc = "applied" /\ fib[i].src = "start"
  /\ faults < MaxFaults
  /\ faults' = faults + 1
  /\ Release(i)
  /\ Deliver(i, "error", "none")
  /\ UNCHANGED <<vm, row, sgen, sdes, st, ctx, cur, renewed, share, cl, rc>>

(* machines.ts steps.join with no tailnet: it answers at once *)
JoinDone(i) ==
  /\ fib[i].src = "join" /\ fib[i].pc = "start"
  /\ Deliver(i, "done", "none")
  /\ fib' = [fib EXCEPT ![i] = Free]
  /\ UNCHANGED <<vm, row, sgen, sdes, st, ctx, cur, renewed, own, share, cl, rc, faults>>

(* a fiber interrupted before it took its lease never runs *)
Gone(i) ==
  /\ fib[i].pc = "start" /\ ~fib[i].active /\ fib[i].src # "none"
  /\ fib' = [fib EXCEPT ![i] = Free]
  /\ UNCHANGED <<vm, row, sgen, sdes, st, ctx, cur, mbox, renewed, own, share, cl, rc, faults>>

Fiber(i) ==
  \/ ObserveLease(i) \/ ObserveRead(i)
  \/ StepLease(i) \/ StepApply(i) \/ StepFail(i) \/ StepAbort(i)
  \/ StepFinish(i) \/ PrepareFail(i) \/ JoinDone(i) \/ Gone(i)

(* machines.ts settledOn and remove, then sent: the store's desire *)
Pick(k) ==
  /\ cl[k].pc = "idle"
  /\ \E d \in Desires :
       IF d # "deleted" /\ ctx.desired = "deleted"
       THEN cl' = [cl EXCEPT ![k] = [@ EXCEPT !.pc = "done", !.d = d,
                     !.res = "superseded", !.by = "deleted", !.vmAt = vm,
                     !.other = Asked(k, "deleted")]]
       ELSE cl' = [cl EXCEPT ![k] = [@ EXCEPT !.pc = "rec", !.d = d]]
  /\ UNCHANGED <<vm, row, sgen, sdes, st, ctx, cur, mbox, renewed, fib, own, share, rc, faults>>

(* sqlite.ts desire: deleted stays deleted, and the generation always rises *)
Record(k) ==
  /\ cl[k].pc = "rec"
  /\ IF row
     THEN LET d == IF sdes = "deleted" THEN "deleted" ELSE cl[k].d IN
          /\ sgen' = sgen + 1
          /\ sdes' = d
          /\ cl' = [cl EXCEPT ![k] = [@ EXCEPT !.pc = "ask", !.g = sgen + 1,
                                               !.sent = d]]
     ELSE /\ cl' = [cl EXCEPT ![k] = [@ EXCEPT !.pc = "done", !.res = "notfound"]]
          /\ UNCHANGED <<sgen, sdes>>
  /\ UNCHANGED <<vm, row, st, ctx, cur, mbox, renewed, fib, own, share, rc, faults>>

(* lifecycle.ts ask *)
Ask(k) ==
  /\ cl[k].pc = "ask"
  /\ mbox' = Append(mbox, Ev("desire", cl[k].sent, cl[k].g, "none", None))
  /\ cl' = [cl EXCEPT ![k].pc = "asked"]
  /\ UNCHANGED <<vm, row, sgen, sdes, st, ctx, cur, renewed, fib, own, share, rc, faults>>

(* lifecycle.ts answer: waitFor reads the snapshot it starts on first *)
StartWait(k) ==
  /\ cl[k].pc = "asked"
  /\ cl' = [cl EXCEPT ![k] =
              IF Satisfies(st, ctx, cl[k].g) THEN Answer(k, st, ctx)
              ELSE [cl[k] EXCEPT !.pc = "wait"]]
  /\ UNCHANGED <<vm, row, sgen, sdes, st, ctx, cur, mbox, renewed, fib, own, share, rc, faults>>

Client(k) == Pick(k) \/ Record(k) \/ Ask(k) \/ StartWait(k)

(* machines.ts recheck: resting actors, one read without a lease, then a  *)
(* tell to each whose context is the one it saw. A recheck comes seconds   *)
(* apart, so it never finds an earlier tell still queued.                  *)
RcSnap ==
  /\ rc.pc = "idle"
  /\ st \in Resting /\ row
  /\ \A j \in 1..Len(mbox) : mbox[j].t # "seen"
  /\ rc' = [pc |-> "read", v |-> "none"]
  /\ renewed' = FALSE
  /\ UNCHANGED <<vm, row, sgen, sdes, st, ctx, cur, mbox, fib, own, share, cl, faults>>

RcRead ==
  /\ rc.pc = "read"
  /\ \E v \in {vm} \cup (IF faults < MaxFaults THEN {"unknown"} ELSE {}) :
       /\ rc' = [pc |-> "tell", v |-> v]
       /\ faults' = IF v = "unknown" THEN faults + 1 ELSE faults
  /\ UNCHANGED <<vm, row, sgen, sdes, st, ctx, cur, mbox, renewed, fib, own, share, cl>>

RcTell ==
  /\ rc.pc = "tell"
  /\ mbox' = IF ~renewed /\ st # "removed"
             THEN Append(mbox, Ev("seen", "none", 0, rc.v, None))
             ELSE mbox
  /\ rc' = [pc |-> "idle", v |-> "none"]
  /\ UNCHANGED <<vm, row, sgen, sdes, st, ctx, cur, renewed, fib, own, share, cl, faults>>

Recheck == RcSnap \/ RcRead \/ RcTell

Init ==
  /\ vm \in {"running", "stopped", "paused"}
  /\ row = TRUE
  /\ sgen = 1
  /\ sdes = vm
  /\ LET c0 == [desired |-> vm, gen |-> 1, prepared |-> FALSE, seen |-> vm,
                error |-> FALSE, join |-> FALSE]
         s0 == Decide(c0)
     IN /\ ctx = c0
        /\ st = s0
        /\ IF s0 \in Invoking
           THEN /\ cur = 1
                /\ fib = [i \in Ids |-> IF i = 1 THEN NewFib(Src(s0), c0) ELSE Free]
           ELSE /\ cur = None
                /\ fib = [i \in Ids |-> Free]
  /\ mbox = <<>>
  /\ renewed = FALSE
  /\ own = None
  /\ share = {}
  /\ cl = [k \in Clients |-> Idle]
  /\ rc = [pc |-> "idle", v |-> "none"]
  /\ faults = 0

Terminated ==
  /\ st = "removed" /\ mbox = <<>>
  /\ \A k \in Clients : cl[k].pc = "done"
  /\ \A i \in Ids : fib[i].pc = "free"
  /\ rc.pc = "idle"
  /\ UNCHANGED vars

Next ==
  \/ ActorStep
  \/ Drained
  \/ Terminated
  \/ \E i \in Ids : Fiber(i)
  \/ \E k \in Clients : Client(k)
  \/ Recheck

Spec ==
  /\ Init /\ [][Next]_vars
  /\ WF_vars(ActorStep \/ Drained)
  /\ \A i \in Ids : WF_vars(Fiber(i))
  /\ \A k \in Clients : WF_vars(Client(k))
  /\ WF_vars(Recheck)

-----------------------------------------------------------------------------
Matches(d, v) ==
  CASE d = "running" -> v = "running"
    [] d = "stopped" -> v = "stopped"
    [] d = "paused" -> v \in {"paused", "stopped"}
    [] d = "deleted" -> v = "missing"

(* A request that answers success finds the VM as it asked. *)
AnswerTrue ==
  \A k \in Clients :
    cl[k].pc = "done" /\ cl[k].res = "ok" => Matches(cl[k].d, cl[k].vmAt)

(* A Superseded names something else that another request asked for. *)
SupersededHonest ==
  \A k \in Clients :
    cl[k].res = "superseded" => cl[k].by # cl[k].d /\ cl[k].other

(* A machine resting settled holds the state the host last read. *)
RestTrue == st \in {"settled", "joining"} => vm = ctx.seen

(* A resting machine works toward what the store last recorded, once every *)
(* recorded desire has reached it. *)
StoreAgrees ==
  /\ st \in Resting
  /\ \A j \in 1..Len(mbox) : mbox[j].t # "desire"
  /\ \A k \in Clients : cl[k].pc # "ask"
  => ctx.desired = sdes /\ ctx.gen = sgen

(* Sanity of the model itself. *)
LeaseSound == own # None => share = {}
OneLiveInvoke == Cardinality({i \in Ids : fib[i].active}) <= 1
FiberRoom == st \in Invoking => cur # None

(* Every request gets an answer. *)
AllAnswered == <>(\A k \in Clients : cl[k].pc = "done")
=============================================================================
