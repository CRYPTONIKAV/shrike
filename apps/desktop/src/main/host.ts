import { BrowserWindow, session, webContents } from "electron";
import type { AppSide, ApprovalRequest, HttpRequestSpec, MemoryNote, ProjectInfo, RunStatus, ShrikeEvents, ShrikeHost } from "@shrike/schema";
import { AppView } from "./app-view.ts";
import { notePatch } from "./issue.ts";
import * as checkpoints from "./checkpoints.ts";
import * as memory from "./memory.ts";
import { notify } from "./notify.ts";
import * as files from "./files.ts";
import { sendRequest as sendHttp } from "./http-send.ts";
import { startIngest, type Ingest } from "./ingest.ts";
import { inspector } from "./inspector.ts";
import * as patches from "./patches.ts";
import { paths } from "./paths.ts";
import { liveConsent, loadProject, readConfig } from "./project.ts";
import { liveUrlOf, portTaken, responds, Runner, shiftExpectedPlaces, shiftUrl } from "./runner.ts";
import * as race from "./race.ts";
import { randomHex, Store } from "./store.ts";

type Sender = <K extends keyof ShrikeEvents>(channel: K, payload: ShrikeEvents[K]) => void;
let emit: Sender = () => {};
export function setSender(s: Sender): void {
  emit = s;
}

let project: ProjectInfo | null = null;
let serverUrl: string | undefined;
let unwatch: (() => void) | undefined;
let ingestP: Promise<Ingest> | undefined;
let lastHelloAt = 0;
const helloWaiters = new Set<() => void>();
const approvals = new Map<string, (approved: boolean) => void>();
const patchApprovals = new Map<string, string>(); // patch id -> waiting approval id (A13)
const watchers = new Map<string, Set<string>>(); // A11: external MCP client name -> action ids it read

export const store = new Store({
  projectRoot: () => project?.root ?? "",
  projectName: () => project?.name,
  declaredPlaces: () => shiftPlaces(project?.declaredPlaces),
  redactRules: () => project?.redact,
  onUpdate: (views) => emit("actions:update", views),
  onHello: (msg) => {
    if (msg.source !== "server") return;
    lastHelloAt = Date.now();
    runner.setInstrumented(msg.place?.id, msg.url);
    if (msg.url && !serverUrl && !project?.appUrl && !offset()) serverUrl = msg.url; // an API whose port Shrike couldn't guess: where it listened
    for (const w of helloWaiters) w();
  },
});

// W2: in a worktree every local port is moved by its offset, so its API and declared places are too.
const offset = () => (project ? runner.offsetFor(project.root) : 0);
const apiUrl = () => shiftUrl(serverUrl, offset());
function shiftPlaces(p: ProjectInfo["declaredPlaces"]): ProjectInfo["declaredPlaces"] {
  const o = offset();
  return p && o ? Object.fromEntries(Object.entries(p).map(([k, v]) => [shiftUrl(`http://${k}`, o)!.slice("http://".length), v])) : p;
}

// A flooding dev command mustn't swamp the renderer: output goes out at most every 50ms, the newest 64KB per stream.
const OUT_EVERY_MS = 50;
const OUT_MAX = 64 * 1024;
const outBuf = new Map<string | null, { text: string; skipped: number }>(); // null: the merged "run:output" stream
let outTimer: ReturnType<typeof setTimeout> | undefined;
function queueOutput(name: string | null, chunk: string): void {
  const b = outBuf.get(name) ?? { text: "", skipped: 0 };
  b.text += chunk;
  if (b.text.length > OUT_MAX) {
    const cut = b.text.indexOf("\n", b.text.length - OUT_MAX) + 1 || b.text.length - OUT_MAX;
    b.skipped += cut;
    b.text = b.text.slice(cut);
  }
  outBuf.set(name, b);
  outTimer ??= setTimeout(() => {
    outTimer = undefined;
    for (const [p, { text, skipped }] of outBuf) {
      const chunk = `${skipped ? `\r\n[shrike] Skipped ${Math.ceil(skipped / 1024)} KB of output to keep up.\r\n` : ""}${text}`;
      if (p === null) emit("run:output", chunk);
      else emit("process:output", { process: p, chunk });
    }
    outBuf.clear();
  }, OUT_EVERY_MS);
}

let prevState: RunStatus["state"] = "idle";
let side: AppSide = "local"; // #62: back to local whenever the run stops
export const runner = new Runner({
  onStatus: (s) => {
    if (s.state !== "running") side = "local";
    emit("run:status", s);
    if (s.state === "running" && prevState !== "running") appView.load().catch(() => {});
    prevState = s.state;
  },
  onOutput: (chunk) => queueOutput(null, chunk),
  onProcessOutput: (process, chunk) => queueOutput(process, chunk),
});

export const appView = new AppView({
  bundlePath: paths.browserAgentBundle,
  appUrl: () => (runner.status.state === "running" ? (side === "live" && project?.liveUrl) || runner.status.url : undefined),
  live: () => liveRun(),
  traceparent: () => !liveRun() || readConfig(project!.root).liveTraceparent === true, // #50: off on live origins unless the project turns it on
  bypassServiceWorker: () => liveRun() && readConfig(project!.root).liveServiceWorker !== true, // #55: on for live sites unless the project keeps the worker
  // #55: the credentials go straight to Chromium, which keeps them in memory for this session; Shrike never stores them.
  onLogin: (host, realm) =>
    new Promise((resolve) => {
      const id = randomHex(8);
      logins.set(id, resolve);
      emit("live:login", { id, host, realm });
    }),
  onNotice: (text) => (emit("live:notice", text), queueOutput(null, `\r\n[shrike] ${text}\r\n`)),
  rightSession: (guest) => guest.session === session.fromPartition(appPartition()),
  onMessage: (msg) => store.handle(msg),
  onWarning: (text) => queueOutput(null, text),
});

/** #55: the app pane's partition: the live site's own for a live project or the Live side, else the local one (renderer: stores/project.ts appPartition). */
export const appPartition = (): string => (project?.livePartition && (liveUrlOf(project) || side === "live") ? project.livePartition : "persist:shrike-app");

/** #54: the app pane shows a live site (a live project's run, or the Live side of a local run), not a local dev server. */
export const liveRun = (): boolean => !!project && runner.status.state === "running" && (!!liveUrlOf(project) || side === "live");

/** #62: a running project with a liveUrl moves its app pane between the local run and the live site (the webview remounts in the side's partition, #55). */
export async function setAppSide(next: AppSide): Promise<AppSide> {
  const p = requireProject();
  if (next === side) return side;
  if (next === "live") {
    if (!p.liveUrl) throw new Error("Add your live URL in Setup first.");
    if (runner.status.state !== "running") throw new Error("Run your app first, then switch to Live.");
    const win = BrowserWindow.getAllWindows().find((w) => !w.getParentWindow());
    if (!(await liveConsent(p.root, p.liveUrl, win))) return side;
  }
  side = next;
  emit("run:status", runner.status); // the app window asks for its partition again
  await appView.load();
  return side;
}

const logins = new Map<string, (login: { username: string; password: string } | null) => void>();
export function answerLiveLogin(id: string, login: { username: string; password: string } | null): void {
  logins.get(id)?.(login);
  logins.delete(id);
}

/** #55: forget everything the live site stored (cookies, storage, cache, basic-auth), then open it again. */
export async function signOutLive(): Promise<void> {
  const p = requireProject();
  if (!p.livePartition) throw new Error("This project has no live site.");
  const ses = session.fromPartition(p.livePartition);
  await ses.clearStorageData();
  await ses.clearAuthCache();
  await ses.clearCache();
  if (liveRun()) await appView.reload().catch(() => {});
}

const ingest = () => (ingestP ??= startIngest((msg) => store.handle(msg), inspector)); // inspector: I place inspector

export function requireProject(): ProjectInfo {
  if (!project) throw new Error("No project is open.");
  return project;
}

export const getServerUrl = (): string | undefined => serverUrl;

export function getProject(): ProjectInfo | null {
  return project;
}

/** Called before another project replaces the open one (the start agent stops with it). */
export const beforeProjectSwitch: (() => Promise<void>)[] = [];

export async function openProject(root: string): Promise<ProjectInfo> {
  const loaded = await loadProject(root);
  if (project?.root !== loaded.info.root) {
    for (const f of beforeProjectSwitch) await f().catch(() => {});
    await race.projectOpened(loaded.info.root); // W2: another repo's background worktree runs stop
    await runner.stop();
    runner.reset();
    clearActions();
    unwatch?.();
    const root = loaded.info.root;
    unwatch = files.watchFiles(root, (path) => {
      emit("file:changed", { path });
      if (path === ".shrike/memory.md") void memory.loadMemory(root).then((notes) => emit("memory:update", notes), () => {}); // hand edits
    });
    checkpoints.clearCheckpoints();
    watchers.clear();
    emit("checkpoint:update", []);
  }
  project = loaded.info;
  // #17: expectedPlaces are read from files copied from main, so in a worktree
  // they name main's ports. Shift them with the worktree's offset so every lane
  // header shows the workspace's ports from the first frame.
  if (project.expectedPlaces) project.expectedPlaces = shiftExpectedPlaces(project.expectedPlaces, offset());
  serverUrl = loaded.serverUrl;
  void memory.loadMemory(project.root).then((notes) => emit("memory:update", notes), () => {});
  return project;
}

let starting: Promise<RunStatus> | null = null;
export function run(): Promise<RunStatus> {
  starting ??= (async () => {
    const p = requireProject();
    const live = liveUrlOf(p);
    if (live) {
      if (runner.status.state === "running") return runner.status;
      const win = BrowserWindow.getAllWindows().find((w) => !w.getParentWindow());
      if (!(await liveConsent(p.root, live, win))) return runner.refuse("Shrike opens a live site only after you confirm you own it or may test it. Press Run to answer again.");
      return runner.startLive(live);
    }
    if (runner.status.state !== "starting" && runner.status.state !== "running") {
      // A server we didn't start would answer instead of ours, and Shrike would see none of it.
      const taken = await portTaken([shiftUrl(p.appUrl, offset()), apiUrl()]);
      if (taken) return runner.refuse(`Port ${new URL(taken).port || new URL(taken).host} is already in use by another program, so Shrike can't see your app there. Stop that program, then press Run again.`);
    }
    const { url, token } = await ingest();
    return runner.start(p, { nodeAgentRegister: paths.nodeAgentRegister, pythonAgent: paths.pythonAgent, ingestUrl: url, token, serverUrl });
  })().finally(() => (starting = null));
  return starting;
}

export function clearActions(): void {
  store.clear();
  watchers.clear();
  appView.clearShots();
  emit("actions:cleared", null);
}

/** #53: the live project's origins, liveUrl's first. Validated when the project loads (project.ts). */
export const liveOrigins = (): string[] => [...new Set([project?.liveUrl, ...(project?.origins ?? [])].filter((u): u is string => !!u).map((u) => new URL(u).origin))];

export const appBaseUrl = () => apiUrl() ?? (runner.status.state === "running" ? runner.status.url : undefined) ?? project?.appUrl;
export function sendRequest(req: HttpRequestSpec, trigger: "explorer" | "agent") {
  requireProject();
  return sendHttp(store, req, appBaseUrl(), trigger, liveOrigins());
}

export function requestApproval(req: Omit<ApprovalRequest, "id">): Promise<boolean> {
  const id = randomHex(8);
  if (req.patch) {
    patchApprovals.set(req.patch.id, id);
    notePatch(req.patch);
  }
  notify("Your agent needs you", req.title);
  return new Promise((resolve) => {
    approvals.set(id, resolve);
    emit("approval:request", { ...req, id });
  });
}

export function answerApproval(id: string, approved: boolean): void {
  const resolve = approvals.get(id);
  if (!resolve) return;
  approvals.delete(id);
  for (const [p, a] of patchApprovals) if (a === id) patchApprovals.delete(p);
  resolve(approved);
  emit("approval:resolved", { id, approved });
}

/** A13: reject a waiting patch with the diff comments as the reason. False when nothing was waiting. */
export function rejectWithFeedback(patchId: string, text: string): boolean {
  const id = patchApprovals.get(patchId);
  if (!id || !approvals.has(id)) return false;
  patches.setFeedback(patchId, text);
  answerApproval(id, false);
  return true;
}

function waitForServerHello(sinceMs: number, timeoutMs: number): Promise<boolean> {
  if (lastHelloAt > sinceMs) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      helloWaiters.delete(onHello);
      clearTimeout(timer);
      resolve(ok);
    };
    const onHello = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    helloWaiters.add(onHello);
  });
}

// node-agent says hello before the server listens, so also wait until the API answers.
async function waitForServerRestart(sinceMs: number, timeoutMs: number): Promise<boolean> {
  const deadline = sinceMs + timeoutMs;
  if (!(await waitForServerHello(sinceMs, timeoutMs))) return false;
  const url = apiUrl();
  while (url && Date.now() < deadline) {
    if (await responds(url)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

const patchDeps = () => ({
  root: requireProject().root,
  requestApproval,
  waitForServerHello: waitForServerRestart,
  onUpdate: (p: ShrikeEvents["patch:update"]) => {
    notePatch(p);
    emit("patch:update", p);
  },
  onCheckpoints: (list: ShrikeEvents["checkpoint:update"]) => emit("checkpoint:update", list),
});

export function revertPatch(patchId: string): Promise<void> {
  return patches.revertPatch(patchDeps(), patchId);
}

export function rewindTo(checkpointId: string): Promise<void> {
  const deps = patchDeps();
  return checkpoints.rewindTo(
    {
      revert: (id) => patches.revertPatch(deps, id),
      reapply: (id) => patches.reapplyPatch(deps, id),
      settle: (paths, since) => patches.settle(deps, paths, since),
    },
    checkpointId,
  );
}

// ---- A5 memory ----

export const getMemory = (): Promise<MemoryNote[]> => memory.loadMemory(requireProject().root);

export async function addMemory(note: Omit<MemoryNote, "id" | "createdAt">): Promise<MemoryNote> {
  const r = await memory.addMemory(requireProject().root, note);
  emit("memory:update", r.all);
  return r.note;
}

export async function removeMemory(id: string): Promise<void> {
  emit("memory:update", await memory.removeMemory(requireProject().root, id));
}

// ---- A11 watched-by ----

export const watchedBy = () => [...watchers].map(([client, ids]) => ({ client, actionIds: [...ids] }));

// ---- O2 ghost cursor: show where the agent is about to click, then let it click ----

const guest = () => webContents.getAllWebContents().find((w) => w.getType() === "webview" && !w.isDestroyed());

async function ghost(ref: string): Promise<void> {
  const g = guest();
  if (!g) return;
  try {
    // Same scroll as the browser-agent's click, so the rect is where the click lands.
    const at = (await g.executeJavaScript(
      `(() => { const el = document.querySelector('[data-shrike-ref="' + CSS.escape(${JSON.stringify(ref)}) + '"]'); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    )) as { x: number; y: number } | null;
    if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return;
    emit("agent:cursor", { x: Math.round(at.x), y: Math.round(at.y), label: "agent" });
    await new Promise((r) => setTimeout(r, 450)); // the glide
    emit("agent:cursor", { x: Math.round(at.x), y: Math.round(at.y), label: "agent", click: true });
  } catch {} // the cursor is decoration; never block the click
}

export async function shutdown(): Promise<void> {
  for (const resolve of approvals.values()) resolve(false);
  approvals.clear();
  unwatch?.();
  await runner.stop();
  await (await ingestP?.catch(() => undefined))?.close();
}

export const host: ShrikeHost = {
  projectRoot: () => requireProject().root,
  listActions: () => store.listActions(),
  getAction: (id) => store.getAction(id),
  getEvent: (id) => store.getEvent(id),
  searchEvents: (q) => store.searchEvents(q),
  listFiles: () => files.listFiles(requireProject().root),
  readFile: (path) => files.readFile(requireProject().root, path),
  searchCode: (q, glob) => files.searchCode(requireProject().root, q, glob),
  listRoutes: () => project?.routes ?? [],
  sendRequest: (req) => sendRequest(req, "agent"),
  appSnapshot: () => appView.snapshot(),
  appClick: async (ref) => {
    await ghost(ref);
    return { actionId: await appView.click(ref) };
  },
  appType: async (ref, text, submit) => {
    await ghost(ref);
    return { actionId: await appView.type(ref, text, submit) };
  },
  appNavigate: async (url) => {
    const appUrl = runner.status.state === "running" ? runner.status.url : undefined;
    if (!appUrl) throw new Error("The app isn't running. Press Run first.");
    const target = new URL(url, appView.currentUrl() ?? appUrl);
    const allowed = [new URL(appUrl).origin, ...liveOrigins()]; // #53: a live project's own origins too, never anything else
    if (!allowed.includes(target.origin)) throw new Error(`Only pages of your app (${allowed.join(", ")}) can be opened.`);
    const next = store.nextAction((root) => root.trigger === "navigation", 10_000);
    await appView.load(target.href);
    return { actionId: await next };
  },
  waitForAction: (id, timeoutMs) => store.waitForAction(id, timeoutMs),
  requestApproval,
  liveOrigins,
  redactKeep: () => project?.redact?.keep,
  proposePatch: (files, rationale, from) => patches.proposePatch(patchDeps(), files, rationale, from),
  revertPatch,
  // ponytail: the agent package turns report_findings calls into "findings" steps itself, so nothing to do here.
  reportFindings: () => {},
  remember: (note) => addMemory({ ...note, by: "agent" }),
  noteWatch: (client, ids) => {
    const set = watchers.get(client) ?? new Set<string>();
    const before = set.size;
    for (const id of ids) if (store.getAction(id)) set.add(id);
    watchers.set(client, set);
    if (set.size !== before) emit("mcp:watch", { client, actionIds: [...set] });
  },
};
