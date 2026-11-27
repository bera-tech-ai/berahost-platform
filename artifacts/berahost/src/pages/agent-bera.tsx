import { FormEvent, useEffect, useState } from "react";
import { ExternalLink, Github, Loader2, WandSparkles } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL;

type CheckResult = { name: string; ok: boolean; detail: string; status?: number };
type AgentBuild = {
  id: number;
  prompt: string;
  name?: string | null;
  status: string;
  error?: string | null;
  plan?: { appName?: string; summary?: string; endpoints?: Array<{ method: string; path: string }> } | null;
  testResults?: { ok: boolean; results: CheckResult[] } | null;
  liveCheck?: { ok: boolean; url: string; title?: string; checks: CheckResult[]; browser: { available: boolean; ok?: boolean; detail: string } } | null;
  repoUrl?: string | null;
  publicUrl?: string | null;
  deploymentStatus?: string | null;
  createdAt?: string | null;
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

export default function AgentBeraPage() {
  const { toast } = useToast();
  const [builds, setBuilds] = useState<AgentBuild[]>([]);
  const [prompt, setPrompt] = useState("");
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
    const timer = window.setInterval(load, 4000);
    return () => window.clearInterval(timer);
  }, []);

  const connectGithub = () => { window.location.href = `${BASE}api/auth/github?mode=connect&returnTo=/agent-bera`; };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (prompt.trim().length < 8) {
      toast({ title: "Describe your website", description: "A sentence or two is enough — what is it for, and what should it show?", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      await apiFetch("/api/agent-bera/builds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: prompt.trim() }) });
      setPrompt("");
      toast({ title: "Agent Bera is on it", description: "Planning, coding the backend, testing the APIs, then publishing — watch the progress below." });
      await load();
    } catch (err: any) {
      toast({ title: "Build could not start", description: err?.error || "Try again.", variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight"><WandSparkles className="h-6 w-6 text-primary" /> Agent Bera</h1>
        <p className="text-muted-foreground mt-1">Describe the app you want in plain language. Agent Bera plans it, writes the full-stack code (Node/Express backend + API-driven frontend), boots it in a sandbox and tests every API endpoint before anything is published, then deploys it here on BERAHOST and checks the live result.</p>
      </div>

      {githubConnected === false && (
        <Card className="border-primary/30">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Github className="h-5 w-5" /> Connect GitHub first</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">Agent Bera publishes every site it builds as a repository in your GitHub account, then deploys it from there — the same flow as GitHub deploy. Connect GitHub once and you're set.</p>
            <Button onClick={connectGithub}><Github className="mr-2 h-4 w-4" /> Connect GitHub</Button>
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
        {builds.length === 0 && <p className="text-sm text-muted-foreground">No builds yet — describe your first website above.</p>}
        {builds.map((b) => {
          const stageIdx = STAGES.indexOf(b.status as any);
          return (
            <Card key={b.id}>
              <CardContent className="space-y-2 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{b.name || "Website"}</span>
                  <Badge variant="outline" className={statusTone(b.status)}>{b.status.toUpperCase()}</Badge>
                  {b.status !== "live" && b.status !== "failed" && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                </div>
                <p className="text-sm text-muted-foreground">{b.prompt}</p>
                {b.status !== "failed" && stageIdx >= 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {STAGES.map((s, i) => (
                      <span key={s} className={`rounded-full border px-2 py-0.5 text-[11px] ${i < stageIdx || b.status === "live" ? "border-accent/30 bg-accent/10 text-accent" : i === stageIdx ? "border-primary/30 bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}>
                        {STAGE_LABELS[s]}
                      </span>
                    ))}
                    <span className="text-xs text-muted-foreground self-center">{stageLabel(b.status)}</span>
                  </div>
                )}
                {b.error && <p className="text-sm text-destructive">{b.error}</p>}
                {b.plan?.endpoints && b.plan.endpoints.length > 0 && (
                  <p className="text-xs text-muted-foreground">API: {b.plan.endpoints.map((e) => `${e.method} ${e.path}`).join(" · ")}</p>
                )}
                {b.testResults && (
                  <p className="text-xs">
                    <span className={b.testResults.ok ? "text-accent" : "text-destructive"}>Endpoint tests: {b.testResults.results.filter((r) => r.ok).length}/{b.testResults.results.length} passed</span>
                    {!b.testResults.ok && b.testResults.results.filter((r) => !r.ok).slice(0, 3).map((r) => <span key={r.name} className="block text-destructive">{r.name} — {r.detail}</span>)}
                  </p>
                )}
                {b.liveCheck && (
                  <p className="text-xs">
                    <span className={b.liveCheck.ok ? "text-accent" : "text-destructive"}>Live check: {b.liveCheck.ok ? "passed" : "problems found"}</span>
                    <span className="text-muted-foreground"> · Browser: {b.liveCheck.browser.available ? (b.liveCheck.browser.ok ? "loaded clean" : "loaded with JS errors") : "not available on this host (HTTP + API checks still ran)"}</span>
                  </p>
                )}
                <div className="flex flex-wrap gap-4 text-sm">
                  {b.publicUrl && b.status === "live" && <a className="inline-flex items-center gap-1 text-primary hover:underline" href={b.publicUrl} target="_blank" rel="noreferrer">Visit live site <ExternalLink className="h-3.5 w-3.5" /></a>}
                  {b.repoUrl && <a className="inline-flex items-center gap-1 text-primary hover:underline" href={b.repoUrl} target="_blank" rel="noreferrer"><Github className="h-3.5 w-3.5" /> View code</a>}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
