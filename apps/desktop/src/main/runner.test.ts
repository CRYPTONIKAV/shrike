import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Place, RunStatus } from "@shrike/schema";
import { detectUrl, exitHint, liveUrlOf, portTaken, reapOrphans, Runner, shiftExpectedPlaces, trackGroups } from "./runner.ts";
import { startTimeOf } from "./platform.ts";

/** A killed group can linger a moment on Linux while its children are reaped. */
async function groupGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(-pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test("detectUrl prefers Vite's Local: line", () => {
  assert.deepEqual(detectUrl("  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m"), { url: "http://localhost:5173/", local: true });
  assert.deepEqual(detectUrl("Server on http://127.0.0.1:3001."), { url: "http://127.0.0.1:3001", local: false });
  assert.equal(detectUrl("no url here"), undefined);
});

test("runner starts a dev command, detects the URL, injects env and stops the group", async () => {
  const root = mkdtempSync(join(tmpdir(), "shrike-run-"));
  writeFileSync(
    join(root, "server.mjs"),
    `import http from "node:http";
const s = http.createServer((q, r) => r.end("ok")).listen(0, "127.0.0.1", () => {
  console.log("env", process.env.SHRIKE_TOKEN, process.env.NODE_OPTIONS);
  console.log("  Local: http://localhost:" + s.address().port + "/");
});`,
  );
  const register = join(root, "register.mjs");
  writeFileSync(register, "");
  const states: RunStatus["state"][] = [];
  let out = "";
  const r = new Runner({ onStatus: (s) => states.push(s.state), onOutput: (c) => (out += c) });
  await r.start({ root, name: "t", frontend: "vite-react", devCommand: "node server.mjs & node server.mjs; wait", routes: [], processes: [], expectedPlaces: [] }, { nodeAgentRegister: register, ingestUrl: "http://127.0.0.1:1", token: "tok" });
  const deadline = Date.now() + 15000;
  while (r.status.state === "starting" && Date.now() < deadline) await new Promise((res) => setTimeout(res, 100));
  assert.equal(r.status.state, "running", out);
  assert.match(r.status.url ?? "", /^http:\/\/localhost:\d+\/$/);
  assert.match(out, /env tok --import=file:\/\/.*register\.mjs --enable-source-maps/);
  const pid = r.status.processes![0]!.pid!;
  await r.stop();
  assert.equal(r.status.state, "stopped");
  assert.ok(await groupGone(pid));
  assert.deepEqual(states.filter((s, i) => s !== states[i - 1]), ["starting", "running", "stopped"]);
});

test("#54 a live project runs at its live URL with no process; a project with a dev command stays local", async () => {
  const live = { root: tmpdir(), name: "live", devCommand: "", routes: [], processes: [{ name: "app", command: "" }], expectedPlaces: [], liveUrl: "https://live.test/" };
  assert.equal(liveUrlOf(live), "https://live.test/");
  assert.equal(liveUrlOf({ ...live, devCommand: "npm run dev", processes: [{ name: "app", command: "npm run dev" }] }), undefined);
  assert.equal(liveUrlOf({ ...live, liveUrl: undefined }), undefined);
  const states: RunStatus[] = [];
  const r = new Runner({ onStatus: (s) => states.push(s), onOutput: () => {} });
  assert.deepEqual(r.startLive("https://live.test/"), { state: "running", url: "https://live.test/" });
  assert.equal(r.status.processes, undefined);
  await r.stop();
  assert.deepEqual(states.map((s) => s.state), ["running", "stopped"]);
});

test("runner reports a failing command with its last lines", async () => {
  const r = new Runner({ onStatus: () => {}, onOutput: () => {} });
  await r.start({ root: tmpdir(), name: "t", devCommand: "echo boom-output; exit 3", routes: [], processes: [], expectedPlaces: [] }, { nodeAgentRegister: "/x.mjs", ingestUrl: "http://127.0.0.1:1", token: "t" });
  while (r.status.state === "starting") await new Promise((res) => setTimeout(res, 50));
  assert.equal(r.status.state, "error");
  assert.match(r.status.error ?? "", /exited with code 3\.[\s\S]*\nboom-output/);
});

test("errorTail keeps Node's error line, not the stack frames after it", async () => {
  const { errorTail } = await import("./runner.ts");
  const out = ["file:///p/api.js:1", 'throw new Error("api config missing")', "^", "", "Error: api config missing: set DATABASE_URL", "    at file:///p/api.js:1:7", "    at ModuleJob.run (node:internal/modules/esm/module_job:1:1)", "", "Node.js v24.9.0"];
  assert.equal(errorTail(out), "Error: api config missing: set DATABASE_URL");
  assert.equal(errorTail(["boom-output"]), "boom-output");
});

test("portTaken names a port another program already answers on", async () => {
  const http = await import("node:http");
  const s = http.createServer((_q, r) => r.end("x")).listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const busy = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  try {
    assert.equal(await portTaken(["http://127.0.0.1:1", busy], 0), busy);
    assert.equal(await portTaken(["http://127.0.0.1:1", undefined], 0), undefined);
  } finally {
    s.close();
  }
});

async function freePort(): Promise<number> {
  const net = await import("node:net");
  const s = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

const until = async (what: string, fn: () => boolean, ms = 15000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((res) => setTimeout(res, 100));
  }
};

test("several processes: per-process env, output and state; a declared outside one runs plain; Stop kills every group", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "shrike-run-"));
  const [webPort, payPort] = [await freePort(), await freePort()];
  const srv = (port: number) => `require("http").createServer((q, r) => r.end("ok")).listen(${port}, "127.0.0.1", () => console.log("up", process.env.SHRIKE_SERVICE, process.env.NODE_OPTIONS ?? "plain"))`;
  const quiet = `console.log("worker", process.env.SHRIKE_SERVICE); setInterval(() => {}, 1000)`;
  const register = join(root, "register.mjs");
  writeFileSync(register, "");
  const per: Record<string, string> = {};
  let merged = "";
  const r = new Runner({ onStatus: () => {}, onOutput: (c) => (merged += c), onProcessOutput: (p, c) => (per[p] = (per[p] ?? "") + c) });
  t.after(() => r.killNow());
  await r.start(
    {
      root,
      name: "t",
      devCommand: "unused",
      appUrl: `http://localhost:${webPort}`,
      routes: [],
      processes: [
        { name: "web", command: `node -e '${srv(webPort)}'` },
        { name: "worker", command: `node -e '${quiet}'`, cwd: "." },
        { name: "pay", command: `node -e '${srv(payPort)}'`, url: `http://127.0.0.1:${payPort}` },
      ],
      expectedPlaces: [],
      declaredPlaces: { [`localhost:${payPort}`]: { kind: "outside", name: "Pay double" } },
    },
    { nodeAgentRegister: register, ingestUrl: "http://127.0.0.1:1", token: "tok" },
  );
  await until("running", () => r.status.state !== "starting");
  assert.equal(r.status.state, "running", merged);
  assert.equal(r.status.url, `http://localhost:${webPort}`);
  assert.deepEqual(r.status.processes!.map((p) => `${p.name}:${p.state}`), ["web:running", "worker:running", "pay:running"]);
  assert.match(per.web!, /up web --import=file:.*register\.mjs/);
  assert.match(per.worker!, /worker worker/);
  assert.match(per.pay!, /up pay plain/);
  assert.match(merged, /^\[web\] up web/m);
  assert.match(merged, /^\[pay\] \$ node/m);
  r.setInstrumented("service:worker");
  assert.equal(r.status.processes![1]!.instrumented, true);
  assert.equal(r.status.instrumented, true);
  const pids = r.status.processes!.map((p) => p.pid!);
  await r.stop();
  assert.equal(r.status.state, "stopped");
  for (const pid of pids) assert.ok(await groupGone(pid));
});

test("backend-only: no page to wait for; a process failing after start marks only itself; one failing while starting fails the run; Run again restarts cleanly", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "shrike-run-"));
  const port = await freePort();
  const project = {
    root,
    name: "api",
    devCommand: "unused",
    routes: [],
    processes: [
      { name: "api", command: `node -e 'require("http").createServer((q, r) => r.end("ok")).listen(${port})'`, url: `http://localhost:${port}` },
      { name: "flaky", command: "sleep 2; echo dying; exit 4" },
      { name: "seed", command: "echo seeded" },
    ],
    expectedPlaces: [],
  };
  writeFileSync(join(root, "register.mjs"), "");
  const env = { nodeAgentRegister: join(root, "register.mjs"), ingestUrl: "http://127.0.0.1:1", token: "t" };
  const r = new Runner({ onStatus: () => {}, onOutput: () => {} });
  t.after(() => r.killNow());
  await r.start(project, env);
  await until("running", () => r.status.state !== "starting");
  assert.equal(r.status.state, "running");
  assert.equal(r.status.url, undefined);
  assert.equal(r.status.processes![2]!.state, "stopped", "a one-shot that exits 0 is done, not broken");
  await until("flaky exits", () => r.status.processes![1]!.state === "error", 8000);
  assert.equal(r.status.state, "running", "the API is still up");
  assert.match(r.status.processes![1]!.error ?? "", /^The "flaky" process exited with code 4\.[\s\S]*\ndying$/);
  await r.stop();

  const broken = { ...project, processes: [project.processes[0]!, { name: "crash", command: "echo nope; exit 2" }] };
  await r.start(broken, env);
  await until("crash", () => r.status.state !== "starting");
  assert.equal(r.status.state, "error");
  assert.match(r.status.error ?? "", /^The "crash" process exited with code 2\./);
  const oldPid = r.status.processes![0]!.pid!;
  await until("the rest stopped", () => r.status.processes![0]!.state === "stopped");
  assert.equal(r.status.state, "error", "still says why");
  assert.ok(await groupGone(oldPid), "a failed start frees the other ports");
  await r.start(project, env);
  assert.equal(r.status.state, "starting");
  await until("running again", () => r.status.state !== "starting");
  assert.equal(r.status.state, "running");
  await r.stop();
  assert.equal(r.status.state, "stopped");
  assert.equal(await (await import("./runner.ts")).responds(`http://localhost:${port}`), false);
});

test("Run refuses when a process's port is already taken", async () => {
  const http = await import("node:http");
  const s = http.createServer((_q, res) => res.end("x")).listen(0, "127.0.0.1");
  await new Promise((res) => s.once("listening", res));
  const url = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  try {
    const r = new Runner({ onStatus: () => {}, onOutput: () => {} });
    const st = await r.start({ root: tmpdir(), name: "t", devCommand: "x", routes: [], processes: [{ name: "api", command: "true", url }], expectedPlaces: [] }, { nodeAgentRegister: "/x.mjs", ingestUrl: "http://127.0.0.1:1", token: "t" });
    assert.equal(st.state, "error");
    assert.match(st.error ?? "", /^Port \d+ is already in use/);
    assert.equal(st.processes, undefined);
  } finally {
    s.close();
  }
});

test("W2: port offset shifts local URLs and env, so two runs of one project sit side by side", async (t) => {
  const { portEnv, shiftUrl } = await import("./runner.ts");
  assert.equal(shiftUrl("http://localhost:5180", 100), "http://localhost:5280");
  assert.equal(shiftUrl("http://127.0.0.1:4100/health", 200), "http://127.0.0.1:4300/health");
  assert.equal(shiftUrl("https://api.stripe.com:443/x", 100), "https://api.stripe.com:443/x");
  assert.deepEqual(portEnv({ appUrl: "http://localhost:5173", processes: [{ name: "pay-ments", command: "x", url: "http://localhost:4199/health" }, { name: "w", command: "y" }] }, "http://localhost:3001", 100), {
    SHRIKE_PORT_OFFSET: "100",
    APP_PORT: "5273",
    SERVER_PORT: "3101",
    PAY_MENTS_PORT: "4299",
  });

  const http = await import("node:http");
  const probe = http.createServer().listen(0, "127.0.0.1");
  await new Promise((res) => probe.once("listening", res));
  const port = (probe.address() as { port: number }).port;
  probe.close();
  const root = mkdtempSync(join(tmpdir(), "shrike-off-"));
  writeFileSync(join(root, "s.mjs"), `import http from "node:http"; http.createServer((q, r) => r.end(process.env.SHRIKE_PORT_OFFSET + " " + process.env.API_PORT)).listen(Number(process.env.PORT), "127.0.0.1");`);
  const project = { root, name: "t", devCommand: "x", routes: [], processes: [{ name: "api", command: "node s.mjs", url: `http://127.0.0.1:${port}/` }], expectedPlaces: [] };
  const env = { nodeAgentRegister: join(root, "none.mjs"), ingestUrl: "http://127.0.0.1:1", token: "t" };
  writeFileSync(env.nodeAgentRegister, "");
  const a = new Runner({ onStatus: () => {}, onOutput: () => {} });
  const b = new Runner({ onStatus: () => {}, onOutput: () => {} });
  b.offsetFor = () => 100;
  t.after(() => Promise.all([a.stop(), b.stop()]));
  await a.start(project, env);
  await b.start(project, env);
  const deadline = Date.now() + 15000;
  while ((a.status.state === "starting" || b.status.state === "starting") && Date.now() < deadline) await new Promise((res) => setTimeout(res, 100));
  assert.equal(a.status.state, "running");
  assert.equal(b.status.state, "running");
  assert.equal(b.status.processes?.[0]?.url, `http://127.0.0.1:${port + 100}/`);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), `0 ${port}`);
  assert.equal(await (await fetch(`http://127.0.0.1:${port + 100}/`)).text(), `100 ${port + 100}`);
  assert.equal(await portTaken([`http://127.0.0.1:${port}/`], 0), undefined, "a port held by one of Shrike's own runs isn't another program");
});

test("the project's .env reaches each process (the shell's env and Shrike win); a blank command is refused in plain words", async () => {
  const root = mkdtempSync(join(tmpdir(), "shrike-env-"));
  writeFileSync(join(root, ".env"), "GREETING=from-root\nDB_HOST=root-db\nHOME=nope\n");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(root, "api"));
  writeFileSync(join(root, "api", ".env"), 'DB_HOST="api-db" # comment\n');
  let out = "";
  const r = new Runner({ onStatus: () => {}, onOutput: (c) => (out += c) });
  const proj = { root, name: "t", devCommand: "", routes: [], expectedPlaces: [] };
  const env = { nodeAgentRegister: "/x.mjs", ingestUrl: "http://127.0.0.1:1", token: "t" };
  await r.start({ ...proj, processes: [{ name: "api", command: 'echo "$GREETING $DB_HOST $HOME"', cwd: "api" }] }, env);
  while (r.status.state === "starting") await new Promise((res) => setTimeout(res, 50));
  assert.match(out, new RegExp(`from-root api-db ${process.env.HOME}`));
  const refused = await r.start({ ...proj, processes: [{ name: "app", command: " " }] }, env);
  assert.equal(refused.state, "error");
  assert.match(refused.error ?? "", /doesn't know how to start your app\. Open Setup/);
});

test("OpenTelemetry SDKs in recorded processes export to Shrike; a project's own exporter settings win", async () => {
  const root = mkdtempSync(join(tmpdir(), "shrike-otel-"));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(root, "own"));
  writeFileSync(join(root, "own", ".env"), "OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318\n");
  let out = "";
  const r = new Runner({ onStatus: () => {}, onOutput: (c) => (out += c) });
  const show = 'echo "$OTEL_EXPORTER_OTLP_ENDPOINT|$OTEL_EXPORTER_OTLP_PROTOCOL|$OTEL_EXPORTER_OTLP_HEADERS|$OTEL_SERVICE_NAME|$OTEL_TRACES_EXPORTER|$OTEL_METRICS_EXPORTER"';
  await r.start(
    { root, name: "t", devCommand: "", routes: [], expectedPlaces: [], processes: [{ name: "py", command: show }, { name: "own", command: show, cwd: "own" }] },
    { nodeAgentRegister: "/x.mjs", ingestUrl: "http://127.0.0.1:9", token: "tok" },
  );
  while (r.status.state === "starting") await new Promise((res) => setTimeout(res, 50));
  assert.match(out, /\[py\] http:\/\/127\.0\.0\.1:9\|http\/protobuf\|x-shrike-token=tok\|py\|otlp\|none/);
  assert.match(out, /\[own\] http:\/\/collector:4318\|\|\|\|\|/);
  await r.stop();
});

test("python-agent goes first on PYTHONPATH, before the project's own; a declared outside process runs plain", async () => {
  const root = mkdtempSync(join(tmpdir(), "shrike-py-"));
  writeFileSync(join(root, ".env"), "PYTHONPATH=/proj/lib:/agent\n");
  let out = "";
  const r = new Runner({ onStatus: () => {}, onOutput: (c) => (out += c) });
  const show = 'echo "path=$PYTHONPATH"';
  await r.start(
    { root, name: "t", devCommand: "", routes: [], expectedPlaces: [], processes: [{ name: "py", command: show }, { name: "fake", command: show, url: "http://localhost:4999" }], declaredPlaces: { "localhost:4999": { kind: "outside", name: "Fake" } } },
    { nodeAgentRegister: "/x.mjs", pythonAgent: "/agent", ingestUrl: "http://127.0.0.1:9", token: "tok" },
  );
  while (r.status.state === "starting") await new Promise((res) => setTimeout(res, 50));
  assert.match(out, /\[py\] path=\/agent:\/proj\/lib\r?\n/);
  assert.match(out, /\[fake\] path=\/proj\/lib:\/agent\r?\n/);
  await r.stop();
});

test("a command not found in a project with no node_modules says to install first", async () => {
  const root = mkdtempSync(join(tmpdir(), "shrike-noinstall-"));
  const r = new Runner({ onStatus: () => {}, onOutput: () => {} });
  await r.start({ root, name: "t", devCommand: "nest-not-installed start --watch", routes: [], processes: [], expectedPlaces: [] }, { nodeAgentRegister: "/x.mjs", ingestUrl: "http://127.0.0.1:1", token: "t" });
  while (r.status.state === "starting") await new Promise((res) => setTimeout(res, 50));
  assert.match(r.status.error ?? "", /exited with code 127\.[\s\S]*packages aren't installed\. Run your install command \(like npm install\) in the project folder/);
});

test("lastProblem finds the child's real error past a bare `Error:` and stack frames", async () => {
  const { lastProblem } = await import("./runner.ts");
  const out = ["> dev:serve", "[remix-serve] http://localhost:13005", "Could not reach Remix dev server at http://localhost:3001/ping (400)", "", "/p/dev.js:34", "    throw Error(await response.text());", "Error: ", "    at Object.broadcastDevReady (/p/dev.js:34:11)"];
  assert.equal(lastProblem(out), "Could not reach Remix dev server at http://localhost:3001/ping (400)");
  assert.equal(lastProblem(["listening", "ready"]), undefined);
});

test("R3 services: added one at a time, one exiting leaves the others, stopService kills that group, stop kills the rest", async () => {
  const root = mkdtempSync(join(tmpdir(), "shrike-svc-"));
  writeFileSync(join(root, "a.mjs"), `setInterval(() => {}, 1000); console.log("a up", process.env.SHRIKE_SERVICE, process.env.PC_DISABLE_TUI, process.env.NODE_OPTIONS ?? "plain");`);
  const env = { nodeAgentRegister: join(root, "a.mjs"), ingestUrl: "http://127.0.0.1:1", token: "t" };
  const project = { root, name: "t", devCommand: "", routes: [], processes: [], expectedPlaces: [], declaredPlaces: { "localhost:9": { kind: "outside" as const, name: "Pay double" } } };
  const r = new Runner({ onStatus: () => {}, onOutput: () => {} });
  const a = await r.startService(project, { name: "a", command: "node a.mjs & node a.mjs; wait", instrument: false }, env);
  await r.startService(project, { name: "pay", command: "node a.mjs", url: "http://localhost:9/health" }, env); // declared outside: plain
  await r.startService(project, { name: "boom", command: "echo boom-out; exit 4" }, env);
  await assert.rejects(r.startService(project, { name: "a", command: "node a.mjs" }, env), /already running/);
  await assert.rejects(r.startService(project, { name: "x", command: "true", cwd: "../.." }, env), /outside the project/);
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((res) => setTimeout(res, 50));
  };
  await until(() => r.services().find((s) => s.name === "boom")?.state === "error" && !!r.serviceTail("a")?.some((l) => l.startsWith("a up")));
  assert.equal(r.status.state, "starting");
  assert.equal(r.services().find((s) => s.name === "a")!.state, "starting");
  assert.match(r.services().find((s) => s.name === "boom")!.error ?? "", /exited with code 4\.[\s\S]*boom-out/);
  assert.ok(r.serviceTail("a")!.some((l) => l === "a up a true plain"));
  await until(() => !!r.serviceTail("pay")?.some((l) => l.startsWith("a up")));
  assert.ok(r.serviceTail("pay")!.some((l) => l === "a up pay true plain"), r.serviceTail("pay")!.join("\n"));
  r.markRunning("http://127.0.0.1:1/");
  assert.equal(r.status.state, "running");
  assert.equal(await r.stopService("a"), true);
  assert.ok(await groupGone(a.pid!));
  assert.equal(r.services().find((s) => s.name === "a")!.state, "stopped");
  assert.equal(await r.stopService("a"), false);
  const b = await r.startService(project, { name: "b", command: "node a.mjs", instrument: false }, env);
  await r.stop();
  assert.ok(await groupGone(b.pid!));
  assert.equal(r.status.state, "stopped");
});

test("a service's URL comes only from this computer's addresses in its output (not Nix's download host)", async () => {
  const root = mkdtempSync(join(tmpdir(), "shrike-svc-url-"));
  const env = { nodeAgentRegister: join(root, "x.mjs"), ingestUrl: "http://127.0.0.1:1", token: "t" };
  const project = { root, name: "t", devCommand: "", routes: [], processes: [], expectedPlaces: [] };
  const r = new Runner({ onStatus: () => {}, onOutput: () => {} });
  await r.startService(project, { name: "infra", command: "echo 'copying path from https://cache.nixos.org'; sleep 1; echo 'ready on http://localhost:5433'; sleep 5", instrument: false }, env);
  await new Promise((done) => setTimeout(done, 600));
  assert.equal(r.services()[0]!.url, undefined);
  await new Promise((done) => setTimeout(done, 1200));
  assert.equal(r.services()[0]!.url, "http://localhost:5433");
  await r.stop();
});

test("reliability: plain reasons for a taken port and a question nobody can answer", () => {
  const port = /^\nPort (\d+) is already in use by another program\./;
  assert.match(exitHint(["Error: listen EADDRINUSE: address already in use :::3000", "    at Server.setupListenHandle", "  code: 'EADDRINUSE',", "  port: 3000"]), port);
  assert.equal(port.exec(exitHint(["Error: listen EADDRINUSE: address already in use 127.0.0.1:5391", "  code: 'EADDRINUSE',"]))![1], "5391");
  assert.equal(port.exec(exitHint(["ERROR:    [Errno 48] error while attempting to bind on address ('127.0.0.1', 8000): address already in use"]))![1], "8000");
  assert.equal(port.exec(exitHint(["listen tcp :8080: bind: address already in use"]))![1], "8080");
  assert.equal(port.exec(exitHint(["error when starting dev server:", "Error: Port 5173 is already in use"]))![1], "5173");
  assert.match(exitHint(["OSError: [Errno 98] Address already in use"]), /^\nIts port is already in use/);
  assert.match(exitHint(["Something is already running on port 3000.", "Would you like to run the app on another port instead? › (Y/n)"]), /stopped to ask a question/);
  assert.equal(exitHint(["TypeError: x is not a function"]), "");
});

test("reliability: a port held by something that isn't a web server counts as taken", async () => {
  const srv = createServer((s) => s.destroy()).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const url = `http://localhost:${(srv.address() as { port: number }).port}`;
  try {
    assert.equal(await portTaken([url], 0), url);
  } finally {
    srv.close();
  }
});

test("reliability: the next launch ends process groups a killed Shrike left running, and nobody else's", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "shrike-reap-"));
  const file = join(dir, "process-groups.json");
  trackGroups(file);
  const r = new Runner({ onStatus: () => {}, onOutput: () => {} });
  await r.start({ root: dir, name: "t", devCommand: "sleep 300 & sleep 300; wait", routes: [], processes: [], expectedPlaces: [] }, { nodeAgentRegister: "/x.mjs", ingestUrl: "http://127.0.0.1:1", token: "t" });
  const pid = r.status.processes![0]!.pid!;
  await until("the group to be saved", () => existsSync(file) && pid in JSON.parse(readFileSync(file, "utf8")));
  // A stranger: a live group whose leader's start time doesn't match what was saved (a reused pid).
  const other = spawn("sh", ["-c", "sleep 300 & sleep 300; wait"], { detached: true, stdio: "ignore" });
  const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  writeFileSync(file, JSON.stringify({ ...saved, [other.pid!]: "Thu Jan  1 00:00:00 1970" }));
  try {
    assert.equal(await reapOrphans(file), 1);
    assert.ok(await groupGone(pid));
    assert.ok(await startTimeOf(other.pid!), "the stranger keeps running");
    assert.ok(!existsSync(file));
  } finally {
    process.kill(-other.pid!, "SIGKILL");
    r.killNow();
  }
});

test("shiftExpectedPlaces moves local ports by the worktree offset (#17)", () => {
  const places: Place[] = [
    { id: "client:http://localhost:5173", kind: "client", name: "WEB", detail: "localhost:5173" },
    { id: "service:api", kind: "service", name: "API", detail: "localhost:5174" },
    { id: "service:localhost:5175", kind: "service", name: "DB", detail: "localhost:5175" },
    { id: "outside:api.stripe.com", kind: "outside", name: "STRIPE", detail: "api.stripe.com" },
    { id: "data:sqlite:events.db", kind: "data", name: "SQLITE · events.db" },
  ];
  const shifted = shiftExpectedPlaces(places, 100);
  assert.deepStrictEqual(shifted[0], { id: "client:http://localhost:5273", kind: "client", name: "WEB", detail: "localhost:5273" });
  assert.deepStrictEqual(shifted[1], { id: "service:api", kind: "service", name: "API", detail: "localhost:5274" });
  assert.deepStrictEqual(shifted[2], { id: "service:localhost:5275", kind: "service", name: "DB", detail: "localhost:5275" });
  assert.deepStrictEqual(shifted[3], places[3]);
  assert.deepStrictEqual(shifted[4], places[4]);
  // Main (offset 0) is unchanged.
  assert.deepStrictEqual(shiftExpectedPlaces(places, 0), places);
});
