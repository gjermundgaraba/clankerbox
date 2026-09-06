"""Executable retained-lifecycle policy spike; NO Orchard/Tart/Vetu integration.

The SQLite ledger stands in for durable desired state and deletion tombstones.
The fake runtime stands in for verified ownership metadata, inventory, and
stop/start-existing operations. Runtime adoption deliberately cold-restarts a
surviving process: disk continuity is tested, uninterrupted uptime is not.
"""
import sqlite3


class Worker:
    def __init__(self, path, owner, runtime, capacity=(4, 8192, 2)):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS vm (
            uid TEXT PRIMARY KEY, owner TEXT NOT NULL, desired TEXT NOT NULL,
            cpu INTEGER NOT NULL, memory INTEGER NOT NULL, slots INTEGER NOT NULL,
            reserved INTEGER NOT NULL DEFAULT 0)""")
        self.owner, self.runtime, self.capacity = owner, runtime, capacity
        self.attached = set()

    def rows(self):
        return self.db.execute("SELECT * FROM vm ORDER BY uid").fetchall()

    def register(self, uid, resources=(2, 4096, 1)):
        """Import an already created, stopped, explicitly owned disk for this spike."""
        disk = self.runtime.disks[uid]
        if disk["owner"] != self.owner or disk["running"]:
            raise ValueError("ownership mismatch or disk not stopped")
        if any(value <= 0 for value in resources):
            raise ValueError("resources must be positive")
        with self.db:
            self.db.execute("INSERT INTO vm VALUES (?,?,'stopped',?,?,?,0)",
                            (uid, self.owner, *resources))

    def request(self, uid, desired):
        if desired not in ("running", "stopped", "delete"):
            raise ValueError("invalid desired state")
        row = self.db.execute("SELECT * FROM vm WHERE uid=?", (uid,)).fetchone()
        if row is None or row["owner"] != self.owner:
            raise ValueError("unknown VM or wrong owner")
        if row["desired"] == "delete" and desired != "delete":
            raise ValueError("deletion already requested")
        with self.db:
            self.db.execute("UPDATE vm SET desired=? WHERE uid=?", (desired, uid))

    def reserved(self, uid, value):
        with self.db:
            self.db.execute("UPDATE vm SET reserved=? WHERE uid=?", (value, uid))

    def stop(self, uid):
        self.runtime.stop(uid)  # Must raise on error and wait for actual process exit.
        if self.runtime.disks[uid]["running"]:
            raise RuntimeError("stop has not completed")
        self.reserved(uid, 0)

    def reconcile(self, controller_online=True):
        if not controller_online:
            return  # An outage is neither a stop nor a deletion request.
        rows = self.rows()
        known = {row["uid"] for row in rows}
        # Unaccounted processes prohibit new admissions, without deleting them.
        unknown_active = any(d["running"] for uid, d in self.runtime.disks.items()
                             if uid not in known)
        for row in rows:
            uid = row["uid"]
            if row["owner"] != self.owner:
                raise ValueError("worker identity mismatch")
            disk = self.runtime.disks.get(uid)
            if disk is None:
                if row["desired"] == "delete":
                    with self.db:
                        self.db.execute("DELETE FROM vm WHERE uid=?", (uid,))
                    continue
                raise RuntimeError("owned disk missing; refusing fresh replacement")
            if disk["owner"] != self.owner:
                raise ValueError("disk ownership mismatch")
            if uid not in self.attached:
                # Rebuild runtime tracking without cloning or changing identity.
                self.stop(uid)
                self.attached.add(uid)
            if row["desired"] in ("stopped", "delete"):
                self.stop(uid)
                if row["desired"] == "delete":
                    self.runtime.delete(uid)
                    with self.db:
                        self.db.execute("DELETE FROM vm WHERE uid=?", (uid,))
                    self.attached.discard(uid)
        for row in self.rows():
            uid = row["uid"]
            if row["desired"] != "running" or self.runtime.disks[uid]["running"]:
                continue
            if unknown_active:
                raise RuntimeError("unaccounted running VM blocks admission")
            used = self.db.execute("SELECT coalesce(sum(cpu),0), coalesce(sum(memory),0), "
                                   "coalesce(sum(slots),0) FROM vm WHERE reserved=1 AND uid!=?",
                                   (uid,)).fetchone()
            requested = (row["cpu"], row["memory"], row["slots"])
            if any(u + r > c for u, r, c in zip(used, requested, self.capacity)):
                raise RuntimeError("capacity unavailable; resume stays queued")
            self.reserved(uid, 1)  # Commit reservation before attempting launch.
            self.runtime.start_existing(uid)

    def shutdown(self):
        # Shutdown owns process quiescence, never disk deletion. Desired state stays.
        for row in self.rows():
            if row["owner"] != self.owner:
                raise ValueError("worker identity mismatch")
            disk = self.runtime.disks.get(row["uid"])
            if disk is not None:
                if disk["owner"] != self.owner:
                    raise ValueError("disk ownership mismatch")
                self.stop(row["uid"])


class FakeRuntime:
    def __init__(self):
        self.disks, self.commands = {}, []
        self.stop_error = self.start_error = self.delete_error = False

    def stop(self, uid):
        self.commands.append(("stop", uid))
        if self.stop_error:
            raise RuntimeError("injected stop failure")
        self.disks[uid]["running"] = False

    def start_existing(self, uid):
        self.commands.append(("start-existing", uid))
        if self.start_error:
            raise RuntimeError("injected start failure")
        self.disks[uid]["running"] = True

    def delete(self, uid):
        self.commands.append(("delete", uid))
        if self.delete_error:
            raise RuntimeError("injected delete failure")
        if self.disks[uid]["running"]:
            raise RuntimeError("cannot delete a running disk")
        del self.disks[uid]
