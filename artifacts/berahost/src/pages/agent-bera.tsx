import { FormEvent, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, CheckCircle2, ChevronDown, Clock, ExternalLink, Github, Loader2, Terminal, WandSparkles } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import GithubTokenConnect from "@/components/github-token-connect";
import AgentFace, { TypingDots } from "@/components/agent-face";

const BASE = import.meta.env.BASE_URL;

type CheckResult = { name: string; ok: boolean; detail: string; status?: number };
type AgentBuild = {
  id: number;
  prompt: string;
  name?: string | null;
  status: string;
  error?: string | null;
  plan?: { appName?: string; summary?: string; resources?: Array<{ name: string; endpoints: Array<{ method: string; path: string }> }>; endpoints?: Array<{ method: string; path: string }> } | null;
  parentId?: number | null;
  builtinDb?: boolean;
  envVarKeys?: string[];
  testResults?: { ok: boolean; results: CheckResult[] } | null;
  liveCheck?: { ok: boolean; url: string; title?: string; checks: CheckResult[]; browser: { available: boolean; ok?: boolean; detail: string; screenshot?: string; flow?: { attempted: boolean; ok: boolean; detail: string }; vision?: { ok: boolean | null; issues: string[]; detail: string } } } | null;
  repoUrl?: string | null;
  publicUrl?: string | null;
  deploymentStatus?: string | null;
  webDeploymentId?: number | null;
  buildLog?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

const STAGES = ["planning", "generating", "testing", "publishing", "deploying", "verifying", "live"] as const;
const STAGE_LABELS: Record<string, string> = { planning: "Plan", generating: "Build", testing: "Test APIs", publishing: "Publish", deploying: "Deploy", verifying: "Live check", live: "Live" };

function statusTone(status: string) {
  if (status === "live") return "border-accent/30 bg-accent/10 text-accent";
  if (status === "failed") return "border-destructive/30 bg-destructive/10 text-destructive";
  return "border-primary/30 bg-primary/10 text-primary";
}

function stageLabel(status: string) {
  switch (status) {
    case "planning": return "Planning the app and its API…";
    case "generating": return "Writing the backend and frontend code…";
    case "testing": return "Booting the app in a sandbox and testing every API endpoint…";
    case "publishing": return "Publishing the tested code to your GitHub…";
    case "deploying": return "Deploying on BERAHOST…";
    case "verifying": return "Checking the live deployment…";
    case "live": return "Live";
    case "failed": return "Failed";
    default: return status;
  }
}

function formatElapsed(ms: number) {
  const secs = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Ticking elapsed clock for an in-progress build (from createdAt); for a
// finished build it renders the total run time once, from createdAt to
// updatedAt.
function ElapsedTimer({ build, active }: { build: AgentBuild; active: boolean }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  if (!build.createdAt) return null;
  const start = new Date(build.createdAt).getTime();
  if (Number.isNaN(start)) return null;
  const end = active ? Date.now() : build.updatedAt ? new Date(build.updatedAt).getTime() : start;
  return (
    <span className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
      <Clock className="h-3.5 w-3.5" />
      {active ? `${formatElapsed(end - start)} elapsed` : `took ${formatElapsed(end - start)}`}
    </span>
  );
}

// A failed build's status is just "failed" — infer the stage it died in
// from the evidence on the row, so the stepper can mark it honestly.
function failedStageIdx(b: AgentBuild) {
  if (b.liveCheck) return STAGES.indexOf("verifying");
  if (b.repoUrl) return STAGES.indexOf("deploying");
  if (b.testResults && !b.testResults.ok) return STAGES.indexOf("testing");
  if (b.testResults) return STAGES.indexOf("publishing");
  if (b.plan) return STAGES.indexOf("generating");
  return STAGES.indexOf("planning");
}

function StageStepper({ build }: { build: AgentBuild }) {
  const failed = build.status === "failed";
  const live = build.status === "live";
  const currentIdx = failed ? failedStageIdx(build) : STAGES.indexOf(build.status as any);
  if (!failed && !live && currentIdx < 0) return null;
  return (
    <div>
      <ol className="flex items-start overflow-x-auto pb-1">
        {STAGES.map((s, i) => {
          const done = live ? i < STAGES.length - 1 : i < currentIdx;
          const isCurrent = !failed && !live && i === currentIdx;
          const isFailed = failed && i === currentIdx;
          const isLive = live && i === STAGES.length - 1;
          return (
            <li key={s} className="flex items-start">
              {i > 0 && <span className={`mx-1.5 mt-[13px] h-px w-5 shrink-0 sm:w-8 ${done || isLive ? "bg-accent/50" : "bg-border"}`} />}
              <span className="flex w-14 shrink-0 flex-col items-center gap-1 text-center">
                <span className={`relative flex h-7 w-7 items-center justify-center rounded-full border ${
                  isFailed ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : done || isLive ? "border-accent/40 bg-accent/10 text-accent"
                  : isCurrent ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border bg-muted/30 text-muted-foreground"}`}>
                  {isFailed ? <AlertCircle className="h-4 w-4" />
                    : done || isLive ? <Check className="h-4 w-4" />
                    : isCurrent ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <span className="text-[11px] font-medium">{i + 1}</span>}
                  {isCurrent && <span className="agent-bera-dot absolute inset-0 rounded-full bg-primary/40" />}
                </span>
                <span className={`text-[11px] leading-tight ${isFailed ? "font-medium text-destructive" : isCurrent ? "font-medium text-primary" : done || isLive ? "text-accent" : "text-muted-foreground"}`}>{STAGE_LABELS[s]}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-1 text-xs text-muted-foreground">{stageLabel(build.status)}</p>
    </div>
  );
}

// The build's own log, streamed by the poll into a terminal-style console:
// dark, monospace, auto-scrolled to the newest line as lines arrive.
// Expanded while the build runs; collapsible once it has finished.
function BuildConsole({ build, active }: { build: AgentBuild; active: boolean }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [open, setOpen] = useState(active);
  useEffect(() => { if (active) setOpen(true); }, [active]);
  useEffect(() => {
    const el = preRef.current;
    if (open && el) el.scrollTop = el.scrollHeight;
  }, [build.buildLog, open]);
  if (!build.buildLog) return null;
  const lines = build.buildLog.split("\n").filter((l) => l.trim().length > 0).length;
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-black/60">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left">
        <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-zinc-400">
          <Terminal className="h-3.5 w-3.5 text-primary" />
          Build console
          {active && <span className="flex items-center gap-1.5 normal-case text-primary"><span className="agent-bera-dot h-1.5 w-1.5 rounded-full bg-primary" /> live</span>}
        </span>
        <span className="flex items-center gap-2 font-mono text-[10px] text-zinc-500">
          {lines} lines
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      {open && (
        <pre ref={preRef} className="max-h-80 select-text overflow-auto whitespace-pre-wrap break-words border-t border-white/10 p-3 font-mono text-[11px] leading-relaxed text-zinc-200">
          {build.buildLog}
        </pre>
      )}
    </div>
  );
}

function CheckList({ results }: { results: CheckResult[] }) {
  return (
    <ul className="space-y-1">
      {results.map((r) => (
        <li key={r.name} className="flex items-start gap-1.5 text-xs">
          {r.ok
            ? <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-accent" />
            : <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0 text-destructive" />}
          <span className="min-w-0">
            <span className="font-medium">{r.name}</span>
            {r.detail ? <span className="text-muted-foreground"> — {r.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function BuildActions({ build, onDone }: { build: AgentBuild; onDone: () => void }) {
  const { toast } = useToast();
  const [instruction, setInstruction] = useState("");
  const [envText, setEnvText] = useState("");
  const [useBuiltinDb, setUseBuiltinDb] = useState(false);
  const [busy, setBusy] = useState("");
  const rootId = build.parentId ?? build.id;

  const submitEdit = async () => {
    if (instruction.trim().length < 3) { toast({ title: "Describe the change", description: "A short sentence is enough — e.g. 'make the header dark blue'.", variant: "destructive" }); return; }
    setBusy("edit");
    try {
      await apiFetch(`/api/agent-bera/builds/${rootId}/edit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instruction: instruction.trim() }) });
      setInstruction("");
      toast({ title: "Edit started", description: "Agent Bera is applying your change, re-testing the APIs, then updating the live app." });
      onDone();
    } catch (err: any) { toast({ title: "Edit could not start", description: err?.error || "Try again.", variant: "destructive" }); }
    finally { setBusy(""); }
  };

  const saveEnv = async () => {
    const envVars: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      const key = eq > 0 ? trimmed.slice(0, eq).trim() : "";
      if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { toast({ title: "Check your variables", description: `Each line must look like KEY=value — "${trimmed.slice(0, 40)}" doesn't.`, variant: "destructive" }); return; }
      envVars[key] = trimmed.slice(eq + 1).trim();
    }
    setBusy("env");
    try {
      await apiFetch(`/api/agent-bera/builds/${rootId}/env`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ envVars }) });
      setEnvText("");
      toast({ title: "Variables saved", description: "The app is restarting with the new variables." });
      onDone();
    } catch (err: any) { toast({ title: "Variables not saved", description: err?.error || "Try again.", variant: "destructive" }); }
    finally { setBusy(""); }
  };

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Edit this app — e.g. add a phone field to orders, make the header dark…"
          className="min-w-64 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
          maxLength={1000}
        />
        <Button size="sm" onClick={submitEdit} disabled={busy === "edit"}>
          {busy === "edit" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <WandSparkles className="mr-2 h-4 w-4" />}
          Edit app
        </Button>
      </div>
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">Environment variables</summary>
        <div className="mt-2 space-y-2">
          <Textarea
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            placeholder={"KEY=value — one per line"}
            rows={3}
            className="font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">Saving REPLACES all of the app's variables and restarts it. Values are never shown anywhere, so re-enter every variable you want to keep{build.builtinDb ? " (the built-in DATABASE_URL is kept automatically)" : ""}. Current names: {(build.envVarKeys || []).join(", ") || "none"}.</p>
          <Button size="sm" variant="outline" onClick={saveEnv} disabled={busy === "env"}>
            {busy === "env" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save variables & restart
          </Button>
        </div>
      </details>
    </div>
  );
}

export default function AgentBeraPage() {
  const { toast } = useToast();
  const [builds, setBuilds] = useState<AgentBuild[]>([]);
  const [prompt, setPrompt] = useState("");
  const [apiUrl, setApiUrl] = useState("");
  const [envText, setEnvText] = useState("");
  const [useBuiltinDb, setUseBuiltinDb] = useState(false);
  const [busy, setBusy] = useState(false);
  const [githubConnected, setGithubConnected] = useState<boolean | null>(null);
  const [githubLogin, setGithubLogin] = useState<string | null>(null);

  const load = () => apiFetch("/api/agent-bera/builds").then(setBuilds).catch(() => { /* keep last snapshot */ });
  const loadGithub = async () => {
    try {
      const status = await apiFetch("/api/github/status");
      setGithubConnected(Boolean(status.connected));
      setGithubLogin(status.login || null);
    } catch { setGithubConnected(false); }
  };

  useEffect(() => {
    load();
    loadGithub();
  }, []);

  // Poll fast while any build is in flight so the build console streams
  // like a terminal; relax when everything has settled.
  const anyActive = builds.some((b) => b.status !== "live" && b.status !== "failed");
  useEffect(() => {
    const timer = window.setInterval(load, anyActive ? 2000 : 4000);
    return () => window.clearInterval(timer);
  }, [anyActive]);

  // The first build still in flight drives this page's living face and
  // is broadcast to the Bera Guide, which mirrors the working state
  // (fast ring, typing dots, stage) in its corner of every page.
  const activeBuild = builds.find(b => b.status !== "live" && b.status !== "failed");
  useEffect(() => {
    const detail = activeBuild ? { active: true, stage: activeBuild.status } : { active: false };
    try {
      if (activeBuild) sessionStorage.setItem("bera-build-activity", JSON.stringify({ ...detail, ts: Date.now() }));
      else sessionStorage.removeItem("bera-build-activity");
    } catch { /* storage unavailable — the event below still lands */ }
    window.dispatchEvent(new CustomEvent("bera-build-activity", { detail }));
  }, [activeBuild?.id, activeBuild?.status]);

  const connectGithub = () => { window.location.href = `${BASE}api/auth/github?mode=connect&returnTo=/agent-bera`; };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (prompt.trim().length < 8) {
      toast({ title: "Describe your website", description: "A sentence or two is enough — what is it for, and what should it show?", variant: "destructive" });
      return;
    }
    const envVars: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      const key = eq > 0 ? trimmed.slice(0, eq).trim() : "";
      if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        toast({ title: "Check your variables", description: `Each line must look like KEY=value — "${trimmed.slice(0, 40)}" doesn't.`, variant: "destructive" });
        return;
      }
      envVars[key] = trimmed.slice(eq + 1).trim();
    }
    setBusy(true);
    try {
      await apiFetch("/api/agent-bera/builds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: prompt.trim(), ...(Object.keys(envVars).length ? { envVars } : {}), ...(useBuiltinDb ? { useBuiltinDb: true } : {}), ...(apiUrl.trim() ? { apiUrl: apiUrl.trim() } : {}) }) });
      setPrompt("");
      setEnvText("");
      setUseBuiltinDb(false);
      toast({ title: "Agent Bera is on it", description: "Planning, coding the backend, testing the APIs, then publishing — watch the progress below." });
      await load();
    } catch (err: any) {
      toast({ title: "Build could not start", description: err?.error || "Try again.", variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <style>{`
        @keyframes agent-bera-float { 0%, 100% { transform: translateY(0) rotate(0deg); } 50% { transform: translateY(-3px) rotate(6deg); } }
        @keyframes agent-bera-shimmer { 0% { transform: translateX(-120%) skewX(-18deg); } 100% { transform: translateX(240%) skewX(-18deg); } }
        @keyframes agent-bera-ping { 0% { transform: scale(1); opacity: .7; } 80%, 100% { transform: scale(2.4); opacity: 0; } }
        .agent-bera-mark { position: relative; overflow: hidden; }
        .agent-bera-mark::after { content: ""; position: absolute; top: 0; bottom: 0; width: 45%; background: linear-gradient(90deg, transparent, rgba(255,255,255,.45), transparent); animation: agent-bera-shimmer 2.8s ease-in-out infinite; }
        .agent-bera-mark svg { animation: agent-bera-float 3.2s ease-in-out infinite; }
        .agent-bera-dot { animation: agent-bera-ping 1.8s cubic-bezier(0, 0, .2, 1) infinite; }
      `}</style>
      <div>
        <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
          <AgentFace size={40} working={!!activeBuild} />
          Agent Bera
        </h1>
        {activeBuild && (
          <p className="mt-1 flex items-center gap-2 text-sm text-primary">
            Agent Bera is working — {STAGE_LABELS[activeBuild.status] || activeBuild.status} <TypingDots />
          </p>
        )}
        <p className="text-muted-foreground mt-1">Describe the app you want in plain language. Agent Bera plans it, writes the full-stack code (Node/Express backend + API-driven frontend), boots it in a sandbox and tests every API endpoint before anything is published, then deploys it here on BERAHOST and checks the live result.</p>
      </div>

      {githubConnected === false && (
        <Card className="border-primary/30">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Github className="h-5 w-5" /> Connect GitHub first</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">Agent Bera publishes every site it builds as a repository in your GitHub account, then deploys it from there — the same flow as GitHub deploy. Connect GitHub once and you're set.</p>
            <Button onClick={connectGithub}><Github className="mr-2 h-4 w-4" /> Connect GitHub</Button>
            <GithubTokenConnect onConnected={() => loadGithub()} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">What should Agent Bera build?</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-3">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. An inventory app for my shop — products API with prices in KES, add/list products from the page, low-stock view"
              rows={4}
              maxLength={2000}
              disabled={githubConnected === false}
            />
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="agent-bera-env">Environment variables <span className="font-normal text-muted-foreground">(optional)</span></label>
              <Textarea
                id="agent-bera-env"
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
                placeholder={"DATABASE_URL=postgres://user:pass@host:5432/dbname\nAPI_KEY=..."}
                rows={3}
                disabled={githubConnected === false}
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">One KEY=value per line. Give the app a real database with DATABASE_URL (Postgres) and the agent will code against it, run its endpoint tests with these variables, and deploy with them. Values are stored with the deployment and never shown again — only the names appear on the build.</p>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={useBuiltinDb} onChange={(e) => setUseBuiltinDb(e.target.checked)} disabled={githubConnected === false} className="mt-0.5" />
              <span>Give my app a <span className="font-medium">built-in database</span> <span className="text-muted-foreground">— BERAHOST provisions an isolated Postgres database for the app, so its data survives restarts. No DATABASE_URL needed.</span></span>
            </label>
            <div className="space-y-1">
              <label className="text-sm font-medium">External API <span className="font-normal text-muted-foreground">(optional)</span></label>
              <Input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://api.example.com — an API or its docs page" disabled={githubConnected === false} className="font-mono text-xs" />
              <p className="text-xs text-muted-foreground">Building against an existing API? Paste its base URL or documentation page — the agent visits it first, learns what it returns, and codes against the real thing.</p>
            </div>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={busy || githubConnected === false}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <WandSparkles className="mr-2 h-4 w-4" />}
                Build it
              </Button>
              <span className="text-xs text-muted-foreground">The finished site counts as one web app on your plan{githubLogin ? <> · publishing to <span className="font-medium">@{githubLogin}</span></> : null}.</span>
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Your Agent Bera builds</h2>
        {builds.length === 0 && (
          <Card className="border-dashed border-border/70 bg-transparent">
            <CardContent className="py-14 text-center">
              <WandSparkles className="mx-auto h-10 w-10 text-muted-foreground/40" />
              <p className="mt-3 text-sm font-medium">No builds yet</p>
              <p className="mt-1 text-xs text-muted-foreground">Describe your first website above — then watch it being planned, coded, tested and deployed right here.</p>
            </CardContent>
          </Card>
        )}
        {builds.map((b) => {
          const active = b.status !== "live" && b.status !== "failed";
          return (
            <Card key={b.id} className="overflow-hidden">
              <CardContent className="space-y-4 py-5">
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold">{b.plan?.appName || b.name || "Website"}</span>
                    <Badge variant="outline" className={statusTone(b.status)}>{b.status.toUpperCase()}</Badge>
                    {b.parentId ? <Badge variant="outline">EDIT</Badge> : null}
                    {b.builtinDb ? <Badge variant="outline">BUILT-IN DB</Badge> : null}
                    {(b as any).apiUrl ? <Badge variant="outline">API</Badge> : null}
                    {b.deploymentStatus && b.status !== "live" && <Badge variant="outline" className="border-border text-muted-foreground">DEPLOYMENT: {b.deploymentStatus.toUpperCase()}</Badge>}
                    <span className="ml-auto"><ElapsedTimer build={b} active={active} /></span>
                  </div>
                  <p className="text-sm text-muted-foreground">{b.prompt}</p>
                  {b.plan?.summary && <p className="text-xs text-muted-foreground">{b.plan.summary}</p>}
                </div>

                <StageStepper build={b} />

                {b.error && (
                  <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{b.error}</p>
                )}

                {b.plan?.resources && b.plan.resources.length > 0 ? (
                  <div className="space-y-1.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Plan</p>
                    <div className="space-y-1 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                      {b.plan.resources.map((r) => (
                        <p key={r.name} className="text-xs text-muted-foreground"><span className="font-medium text-foreground">{r.name}</span> — {r.endpoints.map((e) => `${e.method} ${e.path}`).join(" · ")}</p>
                      ))}
                    </div>
                  </div>
                ) : b.plan?.endpoints && b.plan.endpoints.length > 0 ? (
                  <p className="text-xs text-muted-foreground">API: {b.plan.endpoints.map((e) => `${e.method} ${e.path}`).join(" · ")}</p>
                ) : null}

                {b.envVarKeys && b.envVarKeys.length > 0 && (
                  <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">Variables:
                    {b.envVarKeys.map((k) => <span key={k} className="rounded-full border border-border bg-muted/30 px-2 py-0.5 font-mono text-[11px]">{k}</span>)}
                  </p>
                )}

                <BuildConsole build={b} active={active} />

                {b.testResults && (
                  <div className="space-y-1.5">
                    <p className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Endpoint tests
                      <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] normal-case tracking-normal ${b.testResults.ok ? "border-accent/30 bg-accent/10 text-accent" : "border-destructive/30 bg-destructive/10 text-destructive"}`}>
                        {b.testResults.results.filter((r) => r.ok).length}/{b.testResults.results.length} passed
                      </span>
                    </p>
                    <CheckList results={b.testResults.results} />
                  </div>
                )}

                {b.liveCheck && (
                  <div className="space-y-1.5">
                    <p className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Live check
                      <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] normal-case tracking-normal ${b.liveCheck.ok ? "border-accent/30 bg-accent/10 text-accent" : "border-destructive/30 bg-destructive/10 text-destructive"}`}>
                        {b.liveCheck.ok ? "passed" : "problems found"}
                      </span>
                    </p>
                    {b.liveCheck.checks && b.liveCheck.checks.length > 0 && <CheckList results={b.liveCheck.checks} />}
                    <p className="text-xs text-muted-foreground">Browser: {b.liveCheck.browser.available ? b.liveCheck.browser.detail : "browser runtime unavailable (HTTP + API checks still ran)"}</p>
                    {b.liveCheck.browser?.flow?.attempted && <p className={`text-xs ${b.liveCheck.browser.flow.ok ? "text-muted-foreground" : "text-destructive"}`}><span className="font-medium">Interaction:</span> {b.liveCheck.browser.flow.detail}</p>}
                    {b.liveCheck.browser?.vision && b.liveCheck.browser.vision.ok !== null && <p className={`text-xs ${b.liveCheck.browser.vision.ok ? "text-muted-foreground" : "text-destructive"}`}><span className="font-medium">Vision:</span> {b.liveCheck.browser.vision.detail}</p>}
                    {b.liveCheck.browser?.screenshot && (
                      <a href={b.publicUrl || undefined} target="_blank" rel="noreferrer" className="block max-w-md">
                        <img src={b.liveCheck.browser.screenshot} alt="Screenshot of the live app taken by Agent Bera's browser check" className="w-full rounded-md border border-border" />
                      </a>
                    )}
                  </div>
                )}

                {(b.publicUrl || b.repoUrl) && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3 text-sm">
                    {b.publicUrl && (
                      <a className="flex min-w-0 items-center gap-2 text-primary hover:underline" href={b.publicUrl} target="_blank" rel="noreferrer">
                        <ExternalLink className="h-4 w-4 shrink-0" />
                        <span className="truncate font-mono text-xs">{b.publicUrl.replace(/^https?:\/\//, "")}</span>
                        {b.status === "live" && <span className="shrink-0 font-sans text-sm font-medium">Visit live site</span>}
                      </a>
                    )}
                    {b.repoUrl && <a className="inline-flex items-center gap-1 text-primary hover:underline" href={b.repoUrl} target="_blank" rel="noreferrer"><Github className="h-3.5 w-3.5" /> View code</a>}
                  </div>
                )}
                {b.status === "live" && !b.parentId && <BuildActions build={b} onDone={load} />}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
