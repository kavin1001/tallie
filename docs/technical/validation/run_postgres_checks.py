"""Run real PostgreSQL contention checks in an isolated temporary container.

Requires Docker and the already-local postgres:17-alpine image; never pulls.
No ports are published, no user directory is mounted, networking is disabled.
The temporary data directory is tmpfs. Only the created container is removed.
This validates selected database primitives, not provider contracts or a full app.
"""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
import json
import subprocess
import time
import uuid


IMAGE = "postgres:17-alpine"
CHECK_DIR = Path(__file__).resolve().parent


def run(args, **kwargs):
    return subprocess.run(args, text=True, capture_output=True, **kwargs)


class DisposablePostgres:
    def __init__(self):
        self.name = "peer-payments-design-validation-" + uuid.uuid4().hex[:12]
        self.container_id = None

    def start(self):
        image = run(["docker", "image", "inspect", IMAGE])
        if image.returncode:
            raise RuntimeError("Required local image missing; no image was pulled")
        result = run([
            "docker", "run", "--detach", "--rm", "--name", self.name,
            "--network", "none", "--memory", "256m",
            "--tmpfs", "/var/lib/postgresql/data:rw,size=128m",
            "--env", "POSTGRES_HOST_AUTH_METHOD=trust", IMAGE,
        ])
        if result.returncode:
            raise RuntimeError(result.stderr)
        self.container_id = result.stdout.strip()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            # initdb briefly starts a temporary server which also passes
            # pg_isready. Wait for entrypoint to exec the final PID 1 server.
            pid_one = run(["docker", "exec", self.container_id, "cat", "/proc/1/comm"])
            result = run(["docker", "exec", self.container_id, "pg_isready", "-U", "postgres"])
            if result.returncode == 0 and pid_one.stdout.strip() == "postgres":
                return
            time.sleep(0.2)
        raise RuntimeError("Temporary PostgreSQL did not become ready")

    def command(self, application="validation"):
        return [
            "docker", "exec", "--env", f"PGAPPNAME={application}", "-i", self.container_id,
            "psql", "-U", "postgres", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1",
        ]

    def sql(self, statement, check=True, application="validation"):
        result = run(self.command(application), input=statement, timeout=12)
        if check and result.returncode:
            raise AssertionError(result.stderr)
        return result

    def sleeping_transaction(self, application, statement):
        process = subprocess.Popen(
            self.command(application), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True,
        )
        process.stdin.write("BEGIN;\n" + statement + "\nSELECT pg_sleep(2);\nCOMMIT;\n")
        process.stdin.close()
        process.stdin = None
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            # Application names are fixed internal constants, not user input.
            result = self.sql(
                "SELECT count(*) FROM pg_stat_activity "
                f"WHERE application_name='{application}' AND wait_event='PgSleep';"
            )
            if result.stdout.strip() == "1":
                return process
            if process.poll() is not None:
                raise AssertionError(process.communicate())
            time.sleep(0.03)
        process.kill()
        raise AssertionError("Failed to observe first transaction holding its lock")

    def close(self):
        if not self.container_id:
            return True
        result = run(["docker", "rm", "--force", self.container_id], timeout=15)
        if result.returncode:
            raise RuntimeError("Cleanup failed for owned container " + self.container_id + ": " + result.stderr)
        exists = run(["docker", "container", "inspect", self.container_id])
        return exists.returncode != 0


def main():
    pg = DisposablePostgres()
    evidence = {
        "purpose": "Design validation; not production or provider certification",
        "run_at_utc": datetime.now(timezone.utc).isoformat(),
        "checks": [],
    }

    def passed(name, detail):
        evidence["checks"].append({"name": name, "result": "passed", "detail": detail})
        print("PASS:", name, flush=True)

    try:
        pg.start()
        evidence["postgres_version"] = pg.sql("SELECT version();").stdout.strip()
        evidence["isolation"] = pg.sql("SHOW transaction_isolation;").stdout.strip()
        evidence["container_isolation"] = "network none; no published ports; tmpfs data; no host mounts"
        pg.sql((CHECK_DIR / "postgres_invariants.sql").read_text())

        owner = pg.sleeping_transaction("guard_owner", """
            INSERT INTO execution_guards
              VALUES ('g1', 'share-maya', 1, 'collect', 'natural', 'unknown', NULL, NULL);
        """)
        start = time.monotonic()
        contender = pg.sql("""
            INSERT INTO execution_guards
              VALUES ('g2', 'share-maya', 2, 'refund', 'external', 'external_open', NULL, NULL);
        """, check=False)
        waited = time.monotonic() - start
        stdout, stderr = owner.communicate(timeout=8)
        assert owner.returncode == 0, stderr
        assert contender.returncode != 0 and "one_active_guard_per_share_account" in contender.stderr
        assert waited > 0.5, "Second transaction did not wait for the uncommitted conflicting row"
        passed("cross-revision and cross-direction guard under contention", f"Second transaction waited {waited:.2f}s, then failed unique constraint")

        for phase in ("unknown", "held", "processing", "canceling", "external_reported"):
            pg.sql(f"UPDATE execution_guards SET phase='{phase}' WHERE id='g1';")
            result = pg.sql("""
                INSERT INTO execution_guards
                  VALUES ('g-compete', 'share-maya', 99, 'collect', 'natural', 'open', NULL, NULL);
            """, check=False)
            assert result.returncode != 0 and "one_active_guard_per_share_account" in result.stderr
        bad_release = pg.sql("UPDATE execution_guards SET released_at=now(), phase='closed' WHERE id='g1';", check=False)
        assert bad_release.returncode != 0 and "check constraint" in bad_release.stderr
        passed("uncertain and external phases retain guard", "Five blocking phases tested; release without evidence rejected")

        pg.sql("""
            BEGIN;
            UPDATE execution_guards SET released_at=now(), phase='closed', release_evidence='canonical_cancel_snapshot'
              WHERE id='g1';
            INSERT INTO execution_guards
              VALUES ('g3','share-maya',2,'collect','natural','open',NULL,NULL);
            INSERT INTO execution_guards
              VALUES ('g-leo','share-leo',1,'collect','natural','open',NULL,NULL);
            COMMIT;
        """)
        assert pg.sql("SELECT count(*) FROM execution_guards WHERE released_at IS NULL;").stdout.strip() == "2"
        passed("confirmed release permits replacement and independent shares", "One active guard per share; Maya revision 2 and Leo revision 1 coexist")

        owner = pg.sleeping_transaction("idempotency_owner", """
            SELECT reserve_operation('op1','maya','fulfill','key1','hash-A');
        """)
        contender = pg.sql("SELECT reserve_operation('op2','maya','fulfill','key1','hash-A');")
        stdout, stderr = owner.communicate(timeout=8)
        assert owner.returncode == 0, stderr
        assert contender.stdout.strip() == "op1", contender.stdout
        conflict = pg.sql("SELECT reserve_operation('op3','maya','fulfill','key1','hash-B');", check=False)
        assert conflict.returncode != 0 and "IDEMPOTENCY_PAYLOAD_CONFLICT" in conflict.stderr
        assert pg.sql("SELECT count(*) FROM operations;").stdout.strip() == "1"
        passed("concurrent idempotency returns one immutable operation", "Matching payload returns op1; changed payload rejected; one row")

        pg.sql("SELECT reserve_operation('direct1','maya','send','send-key1','same-payment','consent1');")
        replay = pg.sql("SELECT reserve_operation('direct2','maya','send','send-key2','same-payment','consent1');", check=False)
        assert replay.returncode != 0 and "operations_consent_id_key" in replay.stderr
        assert pg.sql("SELECT count(*) FROM operations WHERE consent_id='consent1';").stdout.strip() == "1"
        passed("one consent cannot execute twice with different keys", "Direct transfer replay rejected by independent consent uniqueness")

        duplicate_sql = """
            INSERT INTO inbox VALUES ('natural','sandbox','payer','evt-1','payload-A')
            ON CONFLICT DO NOTHING;
            INSERT INTO canonical_movements VALUES ('natural','sandbox','payment-1',2600)
            ON CONFLICT DO NOTHING;
        """
        with ThreadPoolExecutor(max_workers=4) as workers:
            results = list(workers.map(lambda _: pg.sql(duplicate_sql), range(8)))
        assert all(result.returncode == 0 for result in results)
        assert pg.sql("SELECT count(*) FROM inbox;").stdout.strip() == "1"
        pg.sql("""
            INSERT INTO inbox VALUES ('natural','sandbox','requester','evt-2','payload-B') ON CONFLICT DO NOTHING;
            INSERT INTO canonical_movements VALUES ('natural','sandbox','payment-1',2600) ON CONFLICT DO NOTHING;
        """)
        assert pg.sql("SELECT count(*) FROM inbox;").stdout.strip() == "2"
        assert pg.sql("SELECT count(*) FROM canonical_movements;").stdout.strip() == "1"
        passed("duplicate inbox delivery and two connected-account views", "Eight concurrent deliveries => one inbox row; second actor view preserved; one canonical movement")

        pg.sql("""
            BEGIN;
            SELECT reserve_operation('op-abort','leo','fulfill','key-abort','hash-Z');
            INSERT INTO outbox VALUES ('cmd-abort','op-abort','fulfill');
            ROLLBACK;
        """)
        assert pg.sql("SELECT count(*) FROM operations WHERE id='op-abort';").stdout.strip() == "0"
        assert pg.sql("SELECT count(*) FROM outbox WHERE id='cmd-abort';").stdout.strip() == "0"
        pg.sql("""
            BEGIN;
            SELECT reserve_operation('op-commit','leo','fulfill','key-commit','hash-Z');
            INSERT INTO outbox VALUES ('cmd-commit','op-commit','fulfill');
            COMMIT;
        """)
        assert pg.sql("SELECT count(*) FROM operations JOIN outbox ON operations.id=outbox.operation_id;").stdout.strip() == "1"
        passed("operation and outbox are atomic", "Rollback leaves neither record; commit persists both")
    finally:
        evidence["owned_container_removed"] = pg.close()
        output = CHECK_DIR / "postgres-results.json"
        output.write_text(json.dumps(evidence, indent=2) + "\n")
        print("Evidence:", output)
        print("Owned container removed:", evidence["owned_container_removed"])


if __name__ == "__main__":
    main()
