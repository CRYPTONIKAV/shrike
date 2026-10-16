import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Place, ProcessSpec, ProjectInfo, RunStatus } from "@shrike/schema";
import { readEnv } from "@shrike/scanner";
import { isWin, killTree, spawnShell, startTimeOf } from "./platform.ts";
import { nodeAgentOk } from "./start/tools.ts";

const MAX_LINES = 2000;
const READY_TIMEOUT_MS = 45_000;
const QUIET_READY_MS = 1000; // a process with no URL counts as up once it has lived this long
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const URL_RE = /https?:\/\/[^\s'"<>]+/;
// No terminal behind Shrike's processes: TUIs (process-compose) and browser openers (vite --open, CRA) must stay quiet.
export const NO_TTY_ENV = { PC_DISABLE_TUI: "true", BROWSER: "none" };

export interface RunnerOptions {
  onStatus(s: RunStatus): void;
  onOutput(chunk: string): void; // merged stream of every process ("run:output")
  onProcessOutput?(process: string, chunk: string): void; // per process ("process:output")
}

export interface RunEnv {
  nodeAgentRegister: string; // absolute path of register.mjs
  pythonAgent?: string; // folder holding python-agent's sitecustomize.py
  ingestUrl: string;
  token: string;
  serverUrl?: string; // API server that must also answer before the app counts as running
}

type ProcState = NonNullable<RunStatus["processes"]>[number];

export interface ServiceInfo {
  name: string;
  command: string;
  cwd?: string;
  url?: string;
  state: ProcState["state"];
  pid?: number;
  exitCode?: number | null;
  error?: string;
  startedAt: number;
}

interface Proc {
  managed?: boolean; // R3: started by the start agent (start_service); one exiting never stops the others
  exitCode?: number | null;
  stopRequested?: boolean;
  spec: ProcessSpec;
  cwd: string;
  root: string;
  child: ChildProcess;
  state: ProcState["state"];
  startedAt: number;
  born: number; // performance.now() at spawn
  url?: string;
  instrumented?: boolean;
  error?: string;
  lines: string[];
  partial: string;
  atLineStart: boolean;
  exited: Promise<void>;
}

export function detectUrl(line: string): { url: string; local: boolean } | undefined {
  const clean = line.replace(ANSI, "");
  const m = clean.match(URL_RE);
  if (!m) return undefined;
  const url = m[0].replace(/[.,)\]]+$/, "");
  return { url, local: /Local:/i.test(clean) && /^https?:\/\/localhost[:/]/.test(url) };
}

const hostOf = (url: string | undefined): string | undefined => {
  try {
    return url ? new URL(url).host.replace(/^127\.0\.0\.1(?=:|$)/, "localhost") : undefined;
  } catch {
    return undefined;
  }
};

const LOOPBACK_PORT = /^(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])):(\d{1,5})(?=[/?#]|$)/;

/** W2: a local URL with its port moved by `offset` (main checkout 0, each worktree +100). Other URLs as they are. */
export function shiftUrl(url: string | undefined, offset: number): string | undefined {
  return url && offset ? url.replace(LOOPBACK_PORT, (_m, h: string, p: string) => `${h}:${Number(p) + offset}`) : url;
}

const portOf = (url: string | undefined) => (url ? LOOPBACK_PORT.exec(url)?.[2] : undefined);

/** #17: expected lane places read from main-checkout files name main's ports. In a
 * worktree every local port moves by `offset`, so shift each place's `detail`
 * (`localhost:5173`) and any embedded local URL in its `id`
 * (`client:http://localhost:5173`) the same way `shiftPlaces` shifts declared
 * places. Non-local details and ids without a URL pass through untouched. Pure. */
export function shiftExpectedPlaces(places: readonly Place[], offset: number): Place[] {
  if (!offset) return [...places];
  return places.map((p) => {
    const detail = p.detail ? (shiftUrl(`http://${p.detail}`, offset)?.slice("http://".length) ?? p.detail) : p.detail;
    const id = shiftPlaceId(p.id, offset);
    return detail === p.detail && id === p.id ? p : { ...p, id, ...(detail === undefined ? {} : { detail }) };
  });
}

/** Shift a place id's port: an embedded local URL (`client:http://localhost:5173`)
 * via `shiftUrl`, else a trailing bare loopback host (`service:localhost:5173`). */
function shiftPlaceId(id: string, offset: number): string {
  const viaUrl = id.replace(/https?:\/\/[^\s]+/, (u) => shiftUrl(u, offset) ?? u);
  if (viaUrl !== id) return viaUrl;
  const bare = /(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})$/.exec(id);
  return bare ? `${id.slice(0, -bare[0].length)}${bare[1]}:${Number(bare[2]) + offset}` : id;
}

/** W2: every known port, shifted, as env vars: APP_PORT (appUrl), SERVER_PORT (serverUrl), <NAME>_PORT per process, SHRIKE_PORT_OFFSET. */
export function portEnv(project: Pick<ProjectInfo, "appUrl" | "processes">, serverUrl: string | undefined, offset: number): Record<string, string> {
  const env: Record<string, string> = { SHRIKE_PORT_OFFSET: String(offset) };
  const put = (key: string, url: string | undefined) => {
    const port = portOf(shiftUrl(url, offset));
    if (port) env[key] = port;
  };
  put("APP_PORT", project.appUrl);
  put("SERVER_PORT", serverUrl);
  for (const p of project.processes ?? []) put(`${p.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PORT`, p.url);
  return env;
}

/** A process's OpenTelemetry SDK (.NET, Python, Go, Java) exports its traces to Shrike's /v1/traces. Its own exporter settings win. */
export function addOtelEnv(env: NodeJS.ProcessEnv, service: string, ingestUrl: string, token: string): void {
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return;
  const ours: Record<string, string> = {
    OTEL_EXPORTER_OTLP_ENDPOINT: ingestUrl,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_HEADERS: `x-shrike-token=${token}`,
    OTEL_SERVICE_NAME: service,
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_LOGS_EXPORTER: "none",
    OTEL_BSP_SCHEDULE_DELAY: "200", // steps show up while the user still looks, not 5 s later
    // Shrike's readiness checks carry x-shrike-internal; recording the header lets the store drop them (Python, Java names).
    OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST: "x-shrike-internal",
    OTEL_INSTRUMENTATION_HTTP_SERVER_CAPTURE_REQUEST_HEADERS: "x-shrike-internal",
  };
  for (const [k, v] of Object.entries(ours)) env[k] ??= v;
}

/** python-agent: its folder goes first on PYTHONPATH, so Python 3.12+ loads its sitecustomize.py (which runs the user's own after it). Harmless for Node. */
export function addPythonAgent(env: NodeJS.ProcessEnv, dir: string | undefined): void {
  if (!dir) return;
  const rest = (env.PYTHONPATH ?? "").split(delimiter).filter((p) => p && p !== dir);
  env.PYTHONPATH = [dir, ...rest].join(delimiter);
}

// Runs with a live process; portTaken doesn't count their ports as "another program" (a worktree's run, W2).
const live = new Set<Runner>();

// Every live process group and when its leader started, kept in a file so the next launch can end what a force-quit or crashed Shrike left behind.
const groups = new Map<number, string>();
let groupsFile: string | undefined;
export const trackGroups = (file: string): void => void (groupsFile = file);
function saveGroups(): void {
  if (!groupsFile) return;
  try {
    writeFileSync(`${groupsFile}.tmp`, JSON.stringify(Object.fromEntries(groups)));
    renameSync(`${groupsFile}.tmp`, groupsFile);
  } catch {}
}
function noteGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || isWin || !groupsFile) return; // ponytail: Windows has no process groups to find again; taskkill /T needs the living parent
  void startTimeOf(pid).then((t) => {
    if (t && child.exitCode === null && child.signalCode === null) groups.set(pid, t), saveGroups();
  });
  child.once("close", () => groups.delete(pid) && saveGroups());
}

/** Ends the process groups a previous Shrike left running. A group counts only when its leader still has the start time we saved,
 * or the leader is gone and the group lives on (a pid can't be reused while its group exists), so nobody else's process is touched. */
export async function reapOrphans(file: string): Promise<number> {
  let saved: Record<string, unknown>;
  try {
    saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return 0;
  }
  let n = 0;
  for (const [key, started] of Object.entries(saved ?? {})) {
    const pid = Number(key);
    if (!Number.isInteger(pid) || pid <= 1 || typeof started !== "string") continue;
    const now = await startTimeOf(pid);
    if (now === started || (now === undefined && groupAlive(pid))) {
      killTree(pid, "SIGTERM");
      setTimeout(() => killTree(pid, "SIGKILL"), 1500).unref();
      n++;
    }
  }
  rmSync(file, { force: true });
  return n;
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false; // ESRCH gone, EPERM not ours
  }
}

/** #54: a live project (a live URL and nothing to start) opens that URL instead of running a dev command. */
export const liveUrlOf = (project: Pick<ProjectInfo, "liveUrl" | "processes" | "devCommand">): string | undefined =>
  project.liveUrl && !project.devCommand.trim() && !project.processes.some((p) => p.command.trim()) ? project.liveUrl : undefined;

export class Runner {
  status: RunStatus = { state: "idle" };
  offsetFor: (root: string) => number = () => 0; // W2: port offset of the worktree at `root`; shifts every local port
  urls: string[] = []; // what the current run listens on, shifted
  private opts: RunnerOptions;
  private procs: Proc[] = [];
  private stopping = false;
  private gen = 0;
  private pageUrl?: string;
  private firstUrl?: string;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
  }

  private alive(): Proc[] {
    return this.procs.filter((p) => p.state === "starting" || p.state === "running");
  }

  private set(s: Omit<RunStatus, "processes">): void {
    if (this.alive().length) live.add(this);
    else live.delete(this);
    this.status = {
      ...s,
      ...(this.procs.length
        ? { processes: this.procs.map((p) => ({ name: p.spec.name, state: p.state, pid: p.child.pid, url: p.url, instrumented: p.instrumented, error: p.error })) }
        : {}),
    };
    this.opts.onStatus(this.status);
  }

  private refresh(): void {
    const { processes: _, ...rest } = this.status;
    this.set(rest);
  }

  /** placeId "service:<name>" marks that process; without it only the run as a whole. `url`: where it listens, when its output didn't say. */
  setInstrumented(placeId?: string, url?: string): void {
    if (!this.alive().length) return;
    const p = placeId?.startsWith("service:") ? this.procs.find((q) => q.spec.name === placeId.slice(8)) : undefined;
    if (p && url && !p.url) p.url = url;
    if (p && !p.instrumented) p.instrumented = true;
    else if (this.status.instrumented) return;
    this.set({ ...this.status, instrumented: true });
  }

  /** Don't start: say why. */
  refuse(error: string): RunStatus {
    if (!this.alive().length) this.set({ state: "error", error });
    return this.status;
  }

  async start(project: ProjectInfo, env: RunEnv): Promise<RunStatus> {
    if (this.alive().length) {
      if (this.status.state === "starting" || this.status.state === "running") return this.status;
      await this.stop(); // one process failed, the rest still run: start over cleanly
    }
    const off = this.offsetFor(project.root);
    const specs = project.processes?.length ? project.processes : [{ name: "app", command: project.devCommand }];
    const blank = specs.find((s) => !s.command.trim());
    if (blank) return this.refuse(`Shrike doesn't know how to start ${specs.length > 1 ? `the "${blank.name}" process` : "your app"}. Open Setup and type the command you use, like npm run dev.`);
    const wanted = [...new Set(specs.map((s) => shiftUrl(s.url, off)))];
    const others = new Set([...live].filter((r) => r !== this).flatMap((r) => r.urls.map(portOf)));
    const clash = wanted.map(portOf).find((p) => p && others.has(p));
    if (clash) return this.refuse(`Port ${clash} is already used by another of your runs in Shrike (a worktree), so this one can't start there. Stop that run first.`);
    const taken = await portTaken(wanted);
    if (taken) return this.refuse(`Port ${new URL(taken).port || new URL(taken).host} is already in use by another program, so Shrike can't see your app there. Stop that program, then press Run again.`);

    // The project's .env (and the process folder's), as `source .env` would: the shell's own env and Shrike's settings win.
    const rootEnv = await readEnv(project.root, [".env"]);
    const dotenvs = await Promise.all(specs.map(async (s) => (s.cwd ? { ...rootEnv, ...(await readEnv(resolve(project.root, s.cwd), [".env"])) } : rootEnv)));
    const agentOk = await nodeAgentOk(project.root); // Node older than 18.19 won't start at all with --import in NODE_OPTIONS
    const gen = ++this.gen;
    this.procs = [];
    this.stopping = false;
    this.pageUrl = shiftUrl(project.appUrl, off);
    this.firstUrl = undefined;
    const serverUrl = shiftUrl(env.serverUrl, off);
    this.urls = [...specs.map((s) => shiftUrl(s.url, off)), this.pageUrl, serverUrl].filter((u): u is string => !!u);
    const base: NodeJS.ProcessEnv = { ...process.env };
    delete base.ELECTRON_RENDERER_URL;
    delete base.ELECTRON_RUN_AS_NODE;
    const ours = `--import=${pathToFileURL(env.nodeAgentRegister).href} --enable-source-maps`;
    Object.assign(base, { SHRIKE_INGEST_URL: env.ingestUrl, SHRIKE_TOKEN: env.token, SHRIKE_PROJECT_ROOT: project.root, FORCE_COLOR: "1", ...NO_TTY_ENV, ...portEnv(project, env.serverUrl, off) });

    for (const spec of specs) {
      // ponytail: a process whose URL is declared "outside" (a test double for a real API) runs without the recorder, so its lane stays outside.
      // Firebase emulators too: the CLI is Node, but the database lane comes from the page.
      const plain = project.declaredPlaces?.[hostOf(spec.url) ?? ""]?.kind === "outside" || /\bemulators:start\b/.test(spec.command);
      const url = shiftUrl(spec.url, off);
      const childEnv: NodeJS.ProcessEnv = { ...dotenvs[specs.indexOf(spec)], ...base, SHRIKE_SERVICE: spec.name, ...(portOf(url) ? { PORT: portOf(url) } : {}) };
      if (!plain) {
        if (agentOk) childEnv.NODE_OPTIONS = base.NODE_OPTIONS ? `${base.NODE_OPTIONS} ${ours}` : ours;
        addOtelEnv(childEnv, spec.name, env.ingestUrl, env.token);
        addPythonAgent(childEnv, env.pythonAgent);
      }
      const cwd = resolve(project.root, spec.cwd ?? ".");
      const rel = relative(project.root, cwd);
      if (rel.startsWith("..") || isAbsolute(rel)) return this.fail(`The "${spec.name}" process folder is outside the project: ${spec.cwd}`);
      let child: ChildProcess;
      try {
        child = spawnShell(spec.command, { cwd, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        return this.fail(`Couldn't start "${spec.command}": ${(err as Error).message}`);
      }
      let done!: () => void;
      const p: Proc = { spec, cwd, root: project.root, child, state: "starting", startedAt: Date.now(), born: performance.now(), url, lines: [], partial: "", atLineStart: true, exited: new Promise((r) => (done = r)) };
      this.procs.push(p);
      noteGroup(child);
      child.stdout?.on("data", (b: Buffer) => this.emitOutput(p, b.toString("utf8")));
      child.stderr?.on("data", (b: Buffer) => this.emitOutput(p, b.toString("utf8")));
      child.once("error", (err) => this.emitOutput(p, `\r\n${err.message}\r\n`));
      child.once("close", (code, signal) => {
        done();
        if (gen === this.gen) this.onExit(p, code, signal);
      });
    }
    this.set({ state: "starting", url: this.pageUrl });
    for (const p of this.procs) this.emitOutput(p, `$ ${p.spec.command}\r\n`);
    void this.waitReady(gen, project, serverUrl);
    return this.status;
  }

  private async fail(error: string): Promise<RunStatus> {
    await this.stop();
    this.set({ state: "error", error });
    return this.status;
  }

  private onExit(p: Proc, code: number | null, signal: NodeJS.Signals | null): void {
    p.exitCode = code;
    if (p.managed) {
      // R3: the start agent reads why (service_logs) and fixes it; the other services keep running.
      p.state = this.stopping || p.stopRequested || code === 0 ? "stopped" : "error";
      if (p.state === "error") p.error = `The "${p.spec.name}" service ${signal ? `was stopped by ${signal}` : `exited with code ${code}`}.${errorTail(p.lines) ? `\n${errorTail(p.lines)}` : ""}${exitHint([...p.lines, p.partial])}`;
      return this.refresh();
    }
    const wasRunning = this.status.state === "running";
    // One process of several that finishes cleanly (a seed or cron script) is done, not broken.
    if (this.stopping || (code === 0 && (wasRunning || this.procs.length > 1))) p.state = "stopped";
    else {
      const tail = errorTail(p.lines);
      const why = signal ? `was stopped by ${signal}` : `exited with code ${code}`;
      const who = this.procs.length === 1 ? "Your dev command" : `The "${p.spec.name}" process`;
      p.state = "error";
      p.error = `${who} ${why}.${tail ? `\n${tail}` : ""}${exitHint([...p.lines, p.partial])}${code === 127 && ![p.cwd, p.root].some((d) => existsSync(join(d, "node_modules"))) ? `\nYour project's packages aren't installed. Run your install command (like npm install) in ${p.spec.cwd ?? "the project folder"}, then press Run.` : ""}`;
      // Once up, one failing process of several shows on that process only (O4); while starting it fails the run and stops the rest, so their ports are free for Run.
      if (!this.stopping && !(wasRunning && this.alive().length)) {
        this.set({ ...this.status, state: "error", error: p.error });
        if (!wasRunning) void this.stop(true);
        return;
      }
    }
    if (this.alive().length) return this.refresh();
    if (this.status.state === "error") return this.refresh();
    this.set({ state: "stopped" });
  }

  private emitOutput(p: Proc, chunk: string): void {
    this.opts.onProcessOutput?.(p.spec.name, chunk);
    if (this.procs.length < 2) this.opts.onOutput(chunk);
    else {
      let out = "";
      for (const piece of chunk.split(/(?<=\n)/)) {
        if (p.atLineStart) out += `[${p.spec.name}] `;
        out += piece;
        p.atLineStart = piece.endsWith("\n");
      }
      this.opts.onOutput(out);
    }
    const parts = (p.partial + chunk).split(/\r?\n/);
    p.partial = parts.pop() ?? "";
    for (const line of parts) this.onLine(p, line);
    if (p.partial.length > 8192) {
      this.onLine(p, p.partial);
      p.partial = "";
    }
  }

  private onLine(p: Proc, line: string): void {
    p.lines.push(line);
    if (p.lines.length > MAX_LINES * 2) p.lines.splice(0, p.lines.length - MAX_LINES); // in batches: one splice per line pinned a core on a flooding command
    if (this.status.state !== "starting") return;
    const found = detectUrl(line);
    // Only this computer's URLs say where a service listens (Nix prints https://cache.nixos.org while it downloads).
    if (!found || !/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?=[:/]|$)/.test(found.url)) return;
    this.firstUrl ??= found.url;
    if (!p.url) {
      p.url = found.url;
      this.refresh();
    }
    if (found.local && !this.pageUrl) {
      this.pageUrl = found.url;
      this.set({ ...this.status, url: found.url });
    }
  }

  private async waitReady(gen: number, project: ProjectInfo, serverUrl?: string): Promise<void> {
    const deadline = performance.now() + READY_TIMEOUT_MS; // monotonic: a clock jump (wake from sleep, NTP) mustn't end or stretch the wait
    const needPage = !!(project.appUrl || project.frontend);
    const live = () => gen === this.gen && this.status.state === "starting";
    while (live()) {
      let changed = false;
      for (const p of this.procs) {
        if (p.state !== "starting") continue;
        // node-agent's hello comes before user code runs, so a URL-less process must also live a moment.
        const up = p.url ? await responds(p.url) : performance.now() - p.born >= QUIET_READY_MS;
        if (up && live() && p.state === "starting") {
          p.state = "running";
          changed = true;
        }
      }
      if (!live()) return;
      if (changed) this.refresh();
      // Old single-command behaviour: any URL the command printed may be the page.
      const page = needPage ? (this.pageUrl ?? (this.procs.length === 1 ? this.firstUrl : undefined)) : undefined;
      const pageUp = !needPage || (!!page && (await responds(page)));
      const serverUp = !serverUrl || (await responds(serverUrl));
      if (!live()) return;
      if (pageUp && serverUp && this.procs.every((p) => p.state === "running" || p.state === "stopped")) return this.set({ ...this.status, state: "running", url: page });
      if (performance.now() > deadline) {
        const slow = this.procs.find((p) => p.state === "starting");
        const error =
          needPage && !page
            ? "Couldn't find your app's URL in the dev command output within 45 seconds. Open Setup and type your app's address."
            : needPage && !pageUp
              ? this.procs.length === 1 && this.firstUrl && portOf(this.firstUrl) !== portOf(page)
                ? `Your dev command says your app is at ${this.firstUrl}, but Shrike expected it at ${page}. Open Setup and change your app's address to match.`
                : `Your app didn't respond at ${page} within 45 seconds. Check the Terminal tab.`
              : slow
                ? `The "${slow.spec.name}" process didn't respond at ${slow.url} within 45 seconds. Check the Terminal tab.`
                : `Your API didn't respond at ${serverUrl} within 45 seconds. Check the Terminal tab.`;
        const why = this.procs.map((p) => lastProblem(p.lines)).findLast(Boolean);
        this.set({ ...this.status, state: "error", error: why ? `${error}\nThe last error it printed: ${why}` : error });
        return void this.stop(true);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // ---- R3: the start agent's executor. Services are added one at a time and live until Stop, not until the agent run ends. ----

  /** Start one long-running service of `project` (start_service). `instrument`: inject node-agent (Node services). */
  async startService(project: ProjectInfo, spec: ProcessSpec & { instrument?: boolean }, env: RunEnv): Promise<ServiceInfo> {
    const live = this.procs.find((p) => p.spec.name === spec.name && (p.state === "starting" || p.state === "running"));
    if (live) throw new Error(`The "${spec.name}" service is already running. Stop it first with stop_service.`);
    const cwd = resolve(project.root, spec.cwd ?? ".");
    const rel = relative(project.root, cwd);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`The "${spec.name}" folder is outside the project: ${spec.cwd}`);
    if (!this.procs.some((p) => p.managed)) {
      this.procs = this.procs.filter((p) => p.state === "starting" || p.state === "running");
      this.pageUrl = undefined;
    }
    this.procs = this.procs.filter((p) => p.spec.name !== spec.name);
    const rootEnv = await readEnv(project.root, [".env"]);
    const dotenv = spec.cwd ? { ...rootEnv, ...(await readEnv(cwd, [".env"])) } : rootEnv;
    const base: NodeJS.ProcessEnv = { ...process.env };
    delete base.ELECTRON_RENDERER_URL;
    delete base.ELECTRON_RUN_AS_NODE;
    const port = portOf(spec.url);
    // Same port vars as start() (W2), so a project's declared ports and worktree shifts hold for Claude-started services too.
    const childEnv: NodeJS.ProcessEnv = { ...dotenv, ...base, ...portEnv(project, env.serverUrl, this.offsetFor(project.root)), SHRIKE_INGEST_URL: env.ingestUrl, SHRIKE_TOKEN: env.token, SHRIKE_PROJECT_ROOT: project.root, SHRIKE_SERVICE: spec.name, FORCE_COLOR: "1", ...NO_TTY_ENV, ...(port ? { PORT: port } : {}) };
    // Same as start(): a service at a host declared "outside" (a test double for a real API) runs without the recorder.
    const outside = Object.entries(project.declaredPlaces ?? {}).some(([k, d]) => d.kind === "outside" && hostOf(shiftUrl(`http://${k}`, this.offsetFor(project.root))) === hostOf(spec.url));
    if (spec.instrument !== false && !outside) {
      const ours = `--import=${pathToFileURL(env.nodeAgentRegister).href} --enable-source-maps`;
      if (await nodeAgentOk(project.root)) childEnv.NODE_OPTIONS = base.NODE_OPTIONS ? `${base.NODE_OPTIONS} ${ours}` : ours;
      addOtelEnv(childEnv, spec.name, env.ingestUrl, env.token);
      addPythonAgent(childEnv, env.pythonAgent);
    }
    const child = spawnShell(spec.command, { cwd, env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let done!: () => void;
    const p: Proc = { managed: true, spec, cwd, root: project.root, child, state: "starting", startedAt: Date.now(), born: performance.now(), url: spec.url, lines: [], partial: "", atLineStart: true, exited: new Promise((r) => (done = r)) };
    this.procs.push(p);
    noteGroup(child);
    this.stopping = false;
    const gen = this.gen;
    child.stdout?.on("data", (b: Buffer) => this.emitOutput(p, b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => this.emitOutput(p, b.toString("utf8")));
    child.once("error", (err) => this.emitOutput(p, `\r\n${err.message}\r\n`));
    child.once("close", (code, signal) => {
      done();
      if (gen === this.gen) this.onExit(p, code, signal);
    });
    this.emitOutput(p, `$ ${spec.command}\r\n`);
    this.urls = [...new Set([...this.urls, ...(spec.url ? [spec.url] : [])])];
    if (this.status.state !== "running") this.set({ state: "starting" });
    else this.refresh();
    return this.serviceInfo(p);
  }

  private serviceInfo(p: Proc): ServiceInfo {
    return { name: p.spec.name, command: p.spec.command, cwd: p.spec.cwd, url: p.url, state: p.state, pid: p.child.pid, exitCode: p.exitCode, error: p.error, startedAt: p.startedAt };
  }

  services(): ServiceInfo[] {
    return this.procs.filter((p) => p.managed).map((p) => this.serviceInfo(p));
  }

  /** The service's last `n` output lines, colours removed. */
  serviceTail(name: string, n = 200): string[] | undefined {
    const p = this.procs.findLast((q) => q.spec.name === name);
    return p && [...p.lines, ...(p.partial ? [p.partial] : [])].slice(-n).map((l) => l.replace(ANSI, ""));
  }

  /** Stop one service and its whole process group. False when it wasn't running. */
  async stopService(name: string): Promise<boolean> {
    const p = this.procs.find((q) => q.spec.name === name && (q.state === "starting" || q.state === "running"));
    if (!p?.child.pid) return false;
    const pid = p.child.pid;
    p.stopRequested = true;
    killTree(pid, "SIGTERM");
    const timer = setTimeout(() => killTree(pid, "SIGKILL"), 3000);
    await p.exited;
    clearTimeout(timer);
    killTree(pid, "SIGKILL");
    p.state = "stopped";
    this.refresh();
    return true;
  }

  /** A service answered its health check. */
  markService(name: string, url?: string): void {
    const p = this.procs.find((q) => q.spec.name === name && q.state === "starting");
    if (!p) return;
    p.state = "running";
    if (url && !p.url) p.url = url;
    this.refresh();
  }

  /** #54: a live site has no dev command: running at once, at `url`. The loopback checks in start() are for local runs only. */
  startLive(url: string): RunStatus {
    if (this.alive().length) return this.status;
    this.procs = [];
    this.urls = [];
    this.pageUrl = url;
    this.set({ state: "running", url });
    return this.status;
  }

  /** R3: every service is healthy (and the page answers): the dock switches to the live app. */
  markRunning(url?: string): void {
    for (const p of this.procs) if (p.managed && p.state === "starting") p.state = "running";
    this.pageUrl = url;
    if (url) this.urls = [...new Set([...this.urls, url])];
    this.set({ state: "running", url, instrumented: this.status.instrumented });
  }

  /** The start agent gave up: say why, keep its services for a look (Stop ends them). */
  markFailed(error: string): void {
    const { processes: _, ...rest } = this.status;
    this.set({ ...rest, state: this.alive().length && rest.state === "running" ? "running" : "error", error });
  }

  /** keepError: a failed start stops what's left but keeps saying why. */
  async stop(keepError = false): Promise<RunStatus> {
    const procs = this.alive();
    if (!procs.length) {
      if (this.status.state === "starting" || this.status.state === "running") this.set({ state: "stopped" });
      return this.status;
    }
    this.stopping = true;
    for (const p of procs) if (p.child.pid) killTree(p.child.pid, "SIGTERM");
    const timer = setTimeout(() => procs.forEach((p) => p.child.pid && killTree(p.child.pid, "SIGKILL")), 3000);
    await Promise.all(procs.map((p) => p.exited));
    clearTimeout(timer);
    // Children that ignored SIGTERM (e.g. vite under `&`) may outlive the shell.
    for (const p of procs) if (p.child.pid) killTree(p.child.pid, "SIGKILL");
    if (keepError && this.status.state === "error") this.refresh();
    else if (this.status.state !== "stopped") this.set({ state: "stopped" });
    return this.status;
  }

  /** Another project opened: forget this one's ended processes, so its status and start_service begin empty. */
  reset(): void {
    if (this.alive().length) return;
    this.procs = [];
    this.urls = [];
    this.pageUrl = this.firstUrl = undefined;
    this.set({ state: "idle" });
  }

  // Synchronous last resort for process exit.
  killNow(): void {
    for (const p of this.procs) if (p.child.pid) killTree(p.child.pid, "SIGKILL");
  }
}

/** The error line Node prints (not the stack frames after it), else the last few lines. */
export function errorTail(lines: string[]): string {
  const clean = lines.slice(-40).map((l) => l.replace(ANSI, "").trimEnd()).filter((l) => l.trim() && !/^\s+at /.test(l) && !/^Node\.js v\d/.test(l));
  const err = clean.findLast((l) => /^(Uncaught )?([A-Z]\w*)?(Error|Exception)\b.*:/.test(l.trim()));
  return err ? err.trim() : clean.slice(-5).join("\n").trim();
}

/** Plain words for two exits people hit: the port is taken, or the command stopped to ask a question nobody can answer. */
export function exitHint(lines: string[]): string {
  const recent = lines.slice(-40).map((l) => l.replace(ANSI, ""));
  const inUse = recent.findLast((l) => /address already in use|port \d+ is (already )?in use/i.test(l)) ?? recent.findLast((l) => /EADDRINUSE/.test(l));
  if (inUse) {
    const port = [...inUse.replace(/\[Errno \d+\]/g, "").matchAll(/(?<![\d.])(\d{2,5})(?![\d.])/g)].map((m) => Number(m[1])).findLast((n) => n <= 65535);
    return `\n${port ? `Port ${port}` : "Its port"} is already in use by another program. Stop that program, then press Run again.`;
  }
  if (recent.slice(-3).some((l) => /\(y\/n\)|\[y\/n\]|\?\s*›/i.test(l))) return "\nIt stopped to ask a question, and Shrike can't answer one. Run it once in a terminal to answer it, or add the option that skips the question.";
  return "";
}

/** The last line that names a problem and says something past "Error:" (a child that crashed while its parent kept running). */
export function lastProblem(lines: string[]): string | undefined {
  return lines
    .map((l) => l.replace(ANSI, "").trim())
    .findLast((l) => !/^at |^(throw|await|return|const|let|var)\b|[;{]$/.test(l) && /\b(error|could not|couldn't|cannot|can't|failed|refused|EADDRINUSE)\b/i.test(l) && l.replace(/^\w*(error|exception):?/i, "").trim().length > 8);
}


export async function responds(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual", headers: { "x-shrike-internal": "1" } });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

/** Something accepts connections on the URL's port, HTTP or not (a database or a raw TCP server holds a port just as well). */
function listening(url: string): Promise<boolean> {
  return new Promise((ok) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return ok(false);
    }
    const s = connect({ host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port) || (u.protocol === "https:" ? 443 : 80), timeout: 1000 });
    const done = (v: boolean) => (s.destroy(), ok(v));
    s.once("connect", () => done(true)).once("error", () => done(false)).once("timeout", () => done(false));
  });
}

/** The first URL whose port already answers (another program holds it), after giving a just-stopped run a moment to let go. */
export async function portTaken(urls: (string | undefined)[], graceMs = 1500): Promise<string | undefined> {
  const deadline = Date.now() + graceMs;
  const ours = new Set([...live].flatMap((r) => r.urls.map(portOf)).filter(Boolean));
  for (;;) {
    let taken: string | undefined;
    for (const u of urls) if (u && !taken && !ours.has(portOf(u)) && (await listening(u))) taken = u;
    if (!taken || Date.now() > deadline) return taken;
    await new Promise((r) => setTimeout(r, 250));
  }
}
