#!/usr/bin/env python3
"""
Script: Load-test the facility incident API
Purpose: Measure latency and error behaviour under a controlled arrival rate
Usage: ./bin/load-test.py [--url URL] [--stages 5:60,10:60] [--writes] [--json FILE]

Open loop, not closed loop. A closed-loop driver - N threads each sending the
next request as soon as the last one returns - cannot overload anything: when
the service slows down the driver slows down with it, and the latency it
reports is the latency of a system that is keeping up by definition. This
script instead schedules arrivals at a fixed rate and lets the queue grow if
the service cannot keep pace, which is what actually happens when real users
arrive.

Requests that cannot be dispatched because every worker is busy are counted as
`shed` rather than quietly delayed. A run with a non-zero shed count has found
the capacity limit, and the latency figures for that stage describe a system
already past it.

Everything is standard library, like `bin/seed-database.py`, so it runs on the
VDI and in CI with nothing to install.

--------------------------------------------------------------------------
Before pointing this at AWS
--------------------------------------------------------------------------
The workshop account is shared. Lambda concurrency is an account-wide pool, and
this service has no reservation, so an unbounded test can starve other
participants' functions. `--reserve N` sets a reserved concurrency on the
function for the duration of the run and restores it afterwards, which caps the
blast radius and guarantees the capacity being measured. Aurora here is
Serverless v2 capped at 4 ACU with auto-pause at 0, so the first request of a
run may include a cluster resume of several seconds - reported separately as
the warm-up rather than folded into the percentiles.
"""

import argparse
import http.client
import json
import random
import subprocess  # nosec B404 # used only to read local `terraform output`
import sys
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

SERVICE_PATH = "/api/facility-api"
DEFAULT_PASSWORD = "Workshop#2026"  # nosec B105 # demo credential, same as the seed script

# Refuse to generate more than this against a remote target without --force.
# Four ACUs and a 128 MB Lambda do not need much to saturate, and the account is
# shared with other participants.
REMOTE_RPS_CEILING = 25

# Percentiles worth reporting. p50 says what most people feel, p99 says what the
# unluckiest one in a hundred feels, and the gap between them is the story.
PERCENTILES = (50, 90, 95, 99)


# --------------------------------------------------------------------------
# Results
# --------------------------------------------------------------------------
@dataclass
class Sample:
    """One completed request."""

    scenario: str
    status: int
    seconds: float
    error: Optional[str] = None


@dataclass
class StageResult:
    """Everything measured during one constant-rate stage."""

    target_rps: float
    duration: float
    samples: list[Sample] = field(default_factory=list)
    shed: int = 0

    @property
    def achieved_rps(self) -> float:
        """
        Report the request rate actually completed.

        Returns:
            float: Completed requests per second.
        """
        return len(self.samples) / self.duration if self.duration else 0.0

    @property
    def failures(self) -> list[Sample]:
        """
        Collect the samples that did not return a 2xx.

        Returns:
            list[Sample]: Failed requests.
        """
        return [s for s in self.samples if not 200 <= s.status < 300]


def percentiles(values: list[float]) -> dict[int, float]:
    """
    Compute the reported percentiles of a latency series.

    Uses nearest-rank rather than an interpolating estimator: with a few hundred
    samples an interpolated p99 invents a number that no request actually
    experienced.

    Args:
        values: Latencies in seconds.

    Returns:
        dict[int, float]: Percentile to latency in milliseconds.
    """
    if not values:
        return {p: 0.0 for p in PERCENTILES}
    ordered = sorted(values)
    out = {}
    for p in PERCENTILES:
        rank = max(1, int(round(p / 100 * len(ordered))))
        out[p] = ordered[min(rank, len(ordered)) - 1] * 1000
    return out


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
class Client:
    """
    One persistent HTTP connection, owned by one worker thread.

    A fresh TCP and TLS handshake per request would put more time into
    connection setup than into the service under test, and would measure the
    driver rather than the API.
    """

    def __init__(self, base: str) -> None:
        """
        Prepare a connection to the service root.

        Args:
            base: Service root URL, for example `https://host/api/facility-api`.
        """
        parsed = urllib.parse.urlparse(base)
        self._host = parsed.netloc
        self._prefix = parsed.path.rstrip("/")
        self._https = parsed.scheme == "https"
        self._connection: Optional[http.client.HTTPConnection] = None

    def _connect(self) -> http.client.HTTPConnection:
        """
        Return the live connection, opening one if needed.

        Returns:
            http.client.HTTPConnection: The connection to use.
        """
        if self._connection is None:
            if self._https:
                self._connection = http.client.HTTPSConnection(self._host, timeout=60)
            else:
                self._connection = http.client.HTTPConnection(self._host, timeout=60)
        return self._connection

    def request(self, method: str, path: str, body: Any = None, token: Optional[str] = None) -> tuple[int, bytes]:
        """
        Send one request, reconnecting once if the connection was dropped.

        Args:
            method: HTTP method.
            path: Path below the service root.
            body: Optional JSON-serialisable body.
            token: Optional bearer token.

        Returns:
            tuple[int, bytes]: Status code and response body.
        """
        payload = json.dumps(body).encode() if body is not None else None
        headers = {"content-type": "application/json", "accept": "application/json"}
        if token:
            headers["authorization"] = f"Bearer {token}"

        for attempt in (1, 2):
            connection = self._connect()
            try:
                connection.request(method, f"{self._prefix}{path}", body=payload, headers=headers)
                response = connection.getresponse()
                return response.status, response.read()
            except (http.client.HTTPException, OSError):
                # A keep-alive connection the far side has closed fails on the
                # next write, not on the read. One reconnect distinguishes that
                # from a genuine failure of the service.
                self.close()
                if attempt == 2:
                    raise
        raise RuntimeError("unreachable")

    def close(self) -> None:
        """Drop the connection, so the next request opens a new one."""
        if self._connection is not None:
            try:
                self._connection.close()
            except Exception:  # nosec B110 # closing a broken socket is best-effort
                pass
            self._connection = None


# --------------------------------------------------------------------------
# Scenarios
# --------------------------------------------------------------------------
@dataclass
class Scenario:
    """One kind of request, and how often it happens."""

    name: str
    weight: int
    call: Callable[[Client, "World"], tuple[int, bytes]]


@dataclass
class Persona:
    """One signed-in user, and the incidents that user can actually see."""

    email: str
    token: str
    incident_ids: list[int]


@dataclass
class World:
    """Identifiers and tokens the scenarios need, gathered once before the run."""

    employee: Persona
    admin: Persona
    building_id: Optional[int]
    floor_id: Optional[int]
    password: str


def build_scenarios(include_writes: bool) -> list[Scenario]:
    """
    Describe the request mix.

    The weights approximate how the application is actually used: people look at
    lists and dashboards far more than they file incidents, and they sign in
    rarely. Login is included at a deliberately small share because it is by far
    the most expensive call - PBKDF2 at 240,000 iterations - and weighting it
    realistically keeps it from dominating a mix that is meant to represent
    browsing.

    Args:
        include_writes: Whether to include requests that create data.

    Returns:
        list[Scenario]: The weighted scenario mix.
    """
    def dashboard(client: Client, world: World) -> tuple[int, bytes]:
        return client.request("GET", "/dashboard/summary", token=world.admin.token)

    def incident_list(client: Client, world: World) -> tuple[int, bytes]:
        status = random.choice(["", "&status=OPEN", "&status=IN_PROGRESS"])  # nosec B311 # test traffic shaping, not security
        return client.request("GET", f"/incidents?limit=25{status}", token=world.admin.token)

    def incident_detail(client: Client, world: World) -> tuple[int, bytes]:
        # Read as the admin: an employee sees only the handful they reported, so
        # driving detail reads from their id pool would hit the same few rows
        # over and over and measure a warm cache rather than the query.
        incident_id = random.choice(world.admin.incident_ids)  # nosec B311
        return client.request("GET", f"/incidents/{incident_id}", token=world.admin.token)

    def duplicate_check(client: Client, world: World) -> tuple[int, bytes]:
        # The newest and most expensive read: a trigram and full-text scan over
        # every open incident. Worth its own share precisely because it is the
        # one whose cost is least obvious from the code.
        noun = random.choice(["projector", "air conditioning", "badge reader", "printer", "wifi"])  # nosec B311
        body = {"title": f"The {noun} in meeting room 3A is not working", "category": "AV_EQUIPMENT"}
        if world.building_id:
            body["building_id"] = world.building_id
        # As the employee, because that is who is filling in the report form.
        return client.request("POST", "/incidents/duplicate-check", body=body, token=world.employee.token)

    def related(client: Client, world: World) -> tuple[int, bytes]:
        incident_id = random.choice(world.admin.incident_ids)  # nosec B311
        return client.request("GET", f"/incidents/{incident_id}/related", token=world.admin.token)

    def hotspots(client: Client, world: World) -> tuple[int, bytes]:
        return client.request("GET", "/dashboard/hotspots", token=world.admin.token)

    def login(client: Client, world: World) -> tuple[int, bytes]:
        return client.request("POST", "/auth/login",
                              body={"email": world.employee.email, "password": world.password})

    def report(client: Client, world: World) -> tuple[int, bytes]:
        body = {
            "title": f"Load test {time.time():.3f} {random.randint(1000, 9999)}",  # nosec B311
            "description": "Created by bin/load-test.py.",
            "category": "OTHER",
            "priority": "LOW",
        }
        if world.building_id:
            body["building_id"] = world.building_id
        return client.request("POST", "/incidents", body=body, token=world.employee.token)

    scenarios = [
        Scenario("incident list", 30, incident_list),
        Scenario("incident detail", 20, incident_detail),
        Scenario("dashboard summary", 15, dashboard),
        Scenario("duplicate check", 15, duplicate_check),
        Scenario("related incidents", 10, related),
        Scenario("dashboard hotspots", 5, hotspots),
        Scenario("login", 5, login),
    ]
    if include_writes:
        scenarios.append(Scenario("report incident", 10, report))
    return scenarios


# --------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------
def run_stage(
    base: str,
    scenarios: list[Scenario],
    world: World,
    target_rps: float,
    duration: float,
    workers: int,
) -> StageResult:
    """
    Drive one constant arrival rate for a fixed wall-clock duration.

    Arrivals are scheduled against a clock rather than against the previous
    response, so a slow service produces a backlog instead of a slower driver.
    When no worker is free the request is shed and counted, because pretending
    it merely arrived late would hide the saturation point.

    Args:
        base: Service root URL.
        scenarios: The weighted scenario mix.
        world: Tokens and identifiers for the scenarios.
        target_rps: Requests per second to schedule.
        duration: Seconds to run for.
        workers: Size of the worker pool, and so the in-flight ceiling.

    Returns:
        StageResult: Samples and shed count for the stage.
    """
    result = StageResult(target_rps=target_rps, duration=duration)
    lock = threading.Lock()
    in_flight = threading.Semaphore(workers)
    local = threading.local()
    weights = [s.weight for s in scenarios]

    def send(scenario: Scenario) -> None:
        """
        Issue one request and record it.

        Args:
            scenario: The scenario to run.
        """
        try:
            client = getattr(local, "client", None)
            if client is None:
                client = Client(base)
                local.client = client
            started = time.perf_counter()
            try:
                status, _ = scenario.call(client, world)
                sample = Sample(scenario.name, status, time.perf_counter() - started)
            except Exception as exc:  # noqa: BLE001 - any failure is a data point
                sample = Sample(scenario.name, 0, time.perf_counter() - started, error=type(exc).__name__)
            with lock:
                result.samples.append(sample)
        finally:
            in_flight.release()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        started = time.perf_counter()
        sent = 0
        while True:
            elapsed = time.perf_counter() - started
            if elapsed >= duration:
                break
            # Where this request should have gone out, by the clock.
            due = sent / target_rps
            if due > elapsed:
                time.sleep(min(due - elapsed, duration - elapsed))
                continue
            if not in_flight.acquire(blocking=False):
                with lock:
                    result.shed += 1
                sent += 1
                continue
            pool.submit(send, random.choices(scenarios, weights=weights, k=1)[0])  # nosec B311
            sent += 1

    result.duration = time.perf_counter() - started
    return result


# --------------------------------------------------------------------------
# Setup
# --------------------------------------------------------------------------
def terraform_url() -> Optional[str]:
    """
    Read the deployed base URL from the Terraform outputs.

    Returns:
        Optional[str]: The CloudFront URL, or None when it cannot be read.
    """
    try:
        raw = subprocess.run(  # nosec B603 B607 # fixed argv, no shell, local tooling
            ["terraform", "output", "-raw", "api_base_url"],
            cwd="infra", capture_output=True, text=True, timeout=60, check=False,
        )
        url = raw.stdout.strip()
        return url if url.startswith("http") else None
    except Exception:  # noqa: BLE001
        return None


def prepare(base: str, password: str) -> World:
    """
    Sign in and collect the identifiers the scenarios need.

    Args:
        base: Service root URL.
        password: Shared password for the seeded accounts.

    Returns:
        World: Tokens and identifiers.

    Raises:
        SystemExit: When the service cannot be reached or has no seeded data.
    """
    client = Client(base)

    def login(email: str) -> str:
        status, body = client.request("POST", "/auth/login", body={"email": email, "password": password})
        if status != 200:
            sys.exit(f"Could not sign in as {email} (HTTP {status}). Has ./bin/seed-database.py been run?")
        return json.loads(body)["access_token"]

    def persona(email: str) -> Persona:
        """
        Sign in and record what that account can actually see.

        Ids are collected per persona rather than once as the admin. Handing an
        employee ids they cannot read makes a fifth of the run 404, which looks
        exactly like the service failing under load.

        Args:
            email: The account to sign in as.

        Returns:
            Persona: The signed-in user and their visible incident ids.
        """
        token = login(email)
        status, body = client.request("GET", "/incidents?limit=100", token=token)
        if status != 200:
            sys.exit(f"Could not list incidents as {email} (HTTP {status}).")
        return Persona(email, token, [i["id"] for i in json.loads(body)["items"]])

    employee = persona("dana.ruiz@acme.inc")
    admin = persona("admin@acme.inc")
    if not admin.incident_ids:
        sys.exit("No incidents found. Run ./bin/seed-database.py first.")

    admin_token = admin.token

    status, body = client.request("GET", "/buildings", token=admin_token)
    buildings = json.loads(body) if status == 200 else []
    building_id = buildings[0]["id"] if buildings else None
    floor_id = None
    if building_id:
        status, body = client.request("GET", f"/buildings/{building_id}/floors", token=admin_token)
        floors = json.loads(body) if status == 200 else []
        floor_id = floors[0]["id"] if floors else None

    client.close()
    return World(
        employee=employee,
        admin=admin,
        building_id=building_id,
        floor_id=floor_id,
        password=password,
    )


def set_reserved_concurrency(function: str, value: Optional[int]) -> bool:
    """
    Reserve, or release, concurrency on the Lambda for the duration of a run.

    A reservation is both a floor and a ceiling. The ceiling is the point here:
    without one, a load test draws from an account-wide pool shared with every
    other participant's functions.

    Args:
        function: Lambda function name.
        value: Concurrency to reserve, or None to remove the reservation.

    Returns:
        bool: True when the change was applied.
    """
    if value is None:
        args = ["aws", "lambda", "delete-function-concurrency", "--function-name", function]
    else:
        args = ["aws", "lambda", "put-function-concurrency", "--function-name", function,
                "--reserved-concurrent-executions", str(value)]
    done = subprocess.run(args, capture_output=True, text=True, check=False)  # nosec B603 B607 # fixed argv, no shell
    if done.returncode != 0:
        print(f"  ! could not change reserved concurrency: {done.stderr.strip().splitlines()[-1:] or ''}")
        return False
    return True


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------
def report_stage(result: StageResult) -> None:
    """
    Print one stage's results.

    Args:
        result: The measured stage.
    """
    latencies = [s.seconds for s in result.samples if s.status]
    pct = percentiles(latencies)
    failures = result.failures

    print(f"\n  {result.target_rps:g} req/s for {result.duration:.0f}s")
    print(f"    completed      {len(result.samples)} ({result.achieved_rps:.1f}/s achieved)")
    if result.shed:
        print(f"    SHED           {result.shed} - every worker was busy; this stage is past capacity")
    print(f"    latency ms     p50 {pct[50]:.0f}   p90 {pct[90]:.0f}   p95 {pct[95]:.0f}   p99 {pct[99]:.0f}"
          f"   max {max(latencies) * 1000:.0f}" if latencies else "    latency ms     -")
    if failures:
        by_status: dict[Any, int] = {}
        for sample in failures:
            key = sample.error or sample.status
            by_status[key] = by_status.get(key, 0) + 1
        share = 100 * len(failures) / len(result.samples)
        print(f"    FAILURES       {len(failures)} ({share:.1f}%): "
              + ", ".join(f"{k}={v}" for k, v in sorted(by_status.items(), key=str)))
    else:
        print("    failures       none")

    by_scenario: dict[str, list[float]] = {}
    for sample in result.samples:
        by_scenario.setdefault(sample.scenario, []).append(sample.seconds)
    print("    per scenario   " + "  ".join(
        f"{name}: p95 {percentiles(v)[95]:.0f}ms (n={len(v)})" for name, v in sorted(by_scenario.items())
    ))


def main() -> int:
    """
    Parse arguments and run the staged load test.

    Returns:
        int: Process exit code.
    """
    parser = argparse.ArgumentParser(description="Load-test the ACME facility incident API.")
    parser.add_argument("--url", help="Service root URL (default: Terraform api_base_url, else localhost:8000)")
    parser.add_argument("--stages", default="2:20,5:20,10:20",
                        help="Comma-separated rps:seconds stages (default: 2:20,5:20,10:20)")
    parser.add_argument("--workers", type=int, default=64, help="In-flight request ceiling (default: 64)")
    parser.add_argument("--warmup", type=float, default=5.0,
                        help="Seconds of traffic to send and discard first (default: 5)")
    parser.add_argument("--writes", action="store_true", help="Include incident creation in the mix")
    parser.add_argument("--password", default=DEFAULT_PASSWORD, help="Password for the seeded accounts")
    parser.add_argument("--reserve", type=int, metavar="N",
                        help="Reserve N concurrent executions on the Lambda for the run, then release it")
    parser.add_argument("--function", default="coding-workshop-facility-api-0922f9b2",
                        help="Lambda function name for --reserve")
    parser.add_argument("--json", metavar="FILE", help="Write the raw results to a JSON file")
    parser.add_argument("--force", action="store_true",
                        help=f"Allow more than {REMOTE_RPS_CEILING} req/s against a remote target")
    parser.add_argument("--dry-run", action="store_true", help="Print the plan and exit")
    args = parser.parse_args()

    base = args.url or terraform_url() or "http://127.0.0.1:8000"
    if not base.endswith(SERVICE_PATH):
        base = base.rstrip("/") + SERVICE_PATH

    try:
        stages = [(float(r), float(s)) for r, s in (part.split(":") for part in args.stages.split(","))]
    except ValueError:
        return print("--stages must look like 5:60,10:60 (requests per second : seconds)") or 2

    is_local = urllib.parse.urlparse(base).hostname in {"127.0.0.1", "localhost", "0.0.0.0"}  # nosec B104 # comparison, not a bind
    peak = max(r for r, _ in stages)
    if not is_local and peak > REMOTE_RPS_CEILING and not args.force:
        return print(
            f"Refusing {peak:g} req/s against {base}.\n"
            f"This account's Lambda concurrency is shared with other participants and Aurora is capped at 4 ACU.\n"
            f"Stay at or below {REMOTE_RPS_CEILING} req/s, or pass --force if you have agreed the rate."
        ) or 2

    total = sum(s for _, s in stages) + args.warmup
    print("=" * 62)
    print("  Load test")
    print("=" * 62)
    print(f"  target     {base}")
    print(f"  stages     {', '.join(f'{r:g} req/s for {s:.0f}s' for r, s in stages)}")
    print(f"  mix        {'reads and writes' if args.writes else 'reads only'}")
    print(f"  ceiling    {args.workers} requests in flight")
    print(f"  duration   about {total:.0f}s")
    if args.reserve:
        print(f"  reserving  {args.reserve} concurrent executions on {args.function}")
    if args.dry_run:
        print("\n  --dry-run: nothing was sent.")
        return 0

    reserved = False
    if args.reserve:
        reserved = set_reserved_concurrency(args.function, args.reserve)

    try:
        world = prepare(base, args.password)
        scenarios = build_scenarios(args.writes)
        print(f"\n  signed in: admin sees {len(world.admin.incident_ids)} incidents, "
              f"employee sees {len(world.employee.incident_ids)}")

        if args.warmup > 0:
            # Aurora here auto-pauses at zero capacity and the Lambda cold
            # starts, so the first seconds measure a resume rather than the
            # service. Sent and discarded.
            warm = run_stage(base, scenarios, world, target_rps=2, duration=args.warmup, workers=args.workers)
            warm_latencies = [s.seconds for s in warm.samples if s.status]
            if warm_latencies:
                print(f"  warm-up    {len(warm.samples)} requests, slowest {max(warm_latencies) * 1000:.0f}ms"
                      " (cold start and any Aurora resume, excluded below)")

        results = []
        for rps, seconds in stages:
            results.append(run_stage(base, scenarios, world, rps, seconds, args.workers))
            report_stage(results[-1])

        print("\n" + "=" * 62)
        worst = max(results, key=lambda r: percentiles([s.seconds for s in r.samples if s.status])[95])
        saturated = [r for r in results if r.shed or r.failures]
        if saturated:
            print(f"  Capacity limit reached at {saturated[0].target_rps:g} req/s.")
        else:
            print(f"  No saturation up to {max(r.target_rps for r in results):g} req/s.")
        print(f"  Worst p95 was {percentiles([s.seconds for s in worst.samples if s.status])[95]:.0f}ms"
              f" at {worst.target_rps:g} req/s.")
        print("=" * 62)

        if args.json:
            with open(args.json, "w", encoding="utf-8") as handle:
                json.dump([{
                    "target_rps": r.target_rps,
                    "duration": r.duration,
                    "achieved_rps": r.achieved_rps,
                    "shed": r.shed,
                    "count": len(r.samples),
                    "failures": len(r.failures),
                    "percentiles_ms": percentiles([s.seconds for s in r.samples if s.status]),
                    "by_scenario": {
                        name: {"count": len(v), "percentiles_ms": percentiles(v)}
                        for name, v in sorted({
                            s.scenario: [x.seconds for x in r.samples if x.scenario == s.scenario]
                            for s in r.samples
                        }.items())
                    },
                } for r in results], handle, indent=2)
            print(f"\n  Raw results written to {args.json}")

        return 1 if any(r.failures for r in results) else 0
    finally:
        if reserved:
            set_reserved_concurrency(args.function, None)
            print(f"  Released the concurrency reservation on {args.function}.")


if __name__ == "__main__":
    sys.exit(main())
