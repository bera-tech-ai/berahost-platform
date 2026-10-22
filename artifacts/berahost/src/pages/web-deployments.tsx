import { FormEvent, useEffect, useMemo, useState } from "react";
import { ExternalLink, FileText, Globe2, Github, Link2, Loader2, Play, Plus, RefreshCw, Square, Trash2, WandSparkles } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useGetMe } from "@workspace/api-client-react";

const BASE = import.meta.env.BASE_URL;

type GithubRepo = { id: number; fullName: string; name: string; private: boolean; htmlUrl: string; defaultBranch: string; description: string | null; updatedAt: string | null };
type WebDeployment = {
  id: number;
  slug: string;
  customName?: string | null;
  repoUrl: string;
  githubFullName?: string | null;
  githubPrivate?: boolean;
  branch: string;
  status: string;
  publicUrl: string;
  autoDeploy?: boolean;
  lastCommitSha?: string | null;
  lastCommitMessage?: string | null;
  buildLog?: string;
};

function statusTone(status: string) {
  if (status === "running") return "border-accent/30 bg-accent/10 text-accent";
  if (["queued", "building", "deploying", "starting"].includes(status)) return "border-primary/30 bg-primary/10 text-primary";
  if (["failed", "crashed"].includes(status)) return "border-destructive/30 bg-destructive/10 text-destructive";
  return "border-border bg-muted/30 text-muted-foreground";
}
function statusDot(status: string) {
  if (status === "running") return "bg-accent shadow-[0_0_10px_hsl(var(--accent))]";
  if (["queued", "building", "deploying", "starting"].includes(status)) return "bg-primary animate-pulse";
  if (["failed", "crashed"].includes(status)) return "bg-destructive";
  return "bg-muted-foreground/60";
}

export default function WebDeploymentsPage() {
  const { toast } = useToast();
  const { data: user } = useGetMe();
  const [rows, setRows] = useState<WebDeployment[]>([]);
  const [githubConnected, setGithubConnected] = useState(false);
  const [githubLogin, setGithubLogin] = useState<string | null>(null);
  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [repoFilter, setRepoFilter] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<GithubRepo | null>(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [customName, setCustomName] = useState("");
  const [buildCommand, setBuildCommand] = useState("");
  const [startCommand, setStartCommand] = useState("");
  const [envText, setEnvText] = useState("");
  const [autoDeploy, setAutoDeploy] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [domain, setDomain] = useState<Record<number, string>>({});
  const [phone, setPhone] = useState("");
  const [domainOrders, setDomainOrders] = useState<Record<number, any>>({});
  const [openLogs, setOpenLogs] = useState<Record<number, boolean>>({});

  const load = () => apiFetch("/api/web-deployments").then(setRows).catch(() => setRows([]));
  const loadGithub = async () => {
    try {
      const status = await apiFetch("/api/github/status");
      setGithubConnected(Boolean(status.connected));
      setGithubLogin(status.login || null);
      if (status.connected) {
        setLoadingRepos(true);
        setRepos(await apiFetch("/api/github/repos"));
      }
    } catch {
      setGithubConnected(false);
      setRepos([]);
    } finally { setLoadingRepos(false); }
  };
  useEffect(() => {
    load();
    loadGithub();
    const timer = window.setInterval(load, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const filteredRepos = useMemo(() => repos.filter((repo) => repo.fullName.toLowerCase().includes(repoFilter.toLowerCase())), [repos, repoFilter]);
  const connectGithub = () => { window.location.href = `${BASE}api/auth/github?mode=connect&returnTo=/web-deployments`; };

  const selectRepo = (repo: GithubRepo) => {
    setSelectedRepo(repo);
    setBranch(repo.defaultBranch || "main");
    setRepoUrl("");
    if (!customName) setCustomName(repo.name);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try {
      const envVars: Record<string, string> = {};
      envText.split("\n").forEach((line) => { const i = line.indexOf("="); if (i > 0) envVars[line.slice(0, i).trim()] = line.slice(i + 1).trim(); });
      const body: any = { repoUrl: selectedRepo ? undefined : repoUrl, githubRepo: selectedRepo || undefined, branch, customName, buildCommand, startCommand, envVars, autoDeploy };
      const created = await apiFetch("/api/web-deployments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      toast({ title: "Web deployment queued", description: created.automationWarning || (autoDeploy && selectedRepo ? "GitHub push auto-deploy is enabled." : "BERAHOST is cloning, scanning, and building your repository.") });
      setSelectedRepo(null); setRepoUrl(""); setCustomName(""); setEnvText(""); setAutoDeploy(true); await load();
    } catch (err: any) { toast({ title: "Deployment rejected", description: err?.error || "Check your subscription, GitHub connection, and repository.", variant: "destructive" }); }
    finally { setBusy(false); }
  };

  const action = async (id: number, verb: "start" | "stop") => { try { await apiFetch(`/api/web-deployments/${id}/${verb}`, { method: "POST" }); await load(); } catch (err: any) { toast({ title: "Action failed", description: err?.error || "Try again.", variant: "destructive" }); } };
  const toggleAutoDeploy = async (row: WebDeployment) => { try { const updated = await apiFetch(`/api/web-deployments/${row.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autoDeploy: !row.autoDeploy }) }); if (updated.automationWarning) toast({ title: "Automatic deploy disabled", description: updated.automationWarning, variant: "destructive" }); else toast({ title: updated.autoDeploy ? "Auto-deploy enabled" : "Auto-deploy disabled", description: updated.autoDeploy ? "Matching GitHub pushes will redeploy this app." : "Pushes will no longer trigger builds." }); await load(); } catch (err: any) { toast({ title: "Auto-deploy update failed", description: err?.error || "Reconnect GitHub and try again.", variant: "destructive" }); } };
  const deleteDeployment = async (row: WebDeployment) => {
    if (!window.confirm(`Delete ${row.customName || row.slug}? This stops the runtime, removes its logs, webhook, and domain orders.`)) return;
    try { await apiFetch(`/api/web-deployments/${row.id}`, { method: "DELETE" }); setDomainOrders((current) => { const next = { ...current }; delete next[row.id]; return next; }); setOpenLogs((current) => { const next = { ...current }; delete next[row.id]; return next; }); toast({ title: "Deployment deleted", description: "The runtime, webhook, stored logs, and linked domain orders were removed." }); await load(); }
    catch (err: any) { toast({ title: "Delete failed", description: err?.error || "The deployment could not be deleted.", variant: "destructive" }); }
  };
  const copyUrl = async (url: string) => { await navigator.clipboard?.writeText(url); toast({ title: "Live URL copied", description: url }); };
  const copyLogs = async (row: WebDeployment) => { await navigator.clipboard?.writeText(row.buildLog || ""); toast({ title: "Logs copied", description: "The complete deployment log is now on your clipboard." }); };
  const downloadLogs = (row: WebDeployment) => { const blob = new Blob([row.buildLog || ""], { type: "text/plain;charset=utf-8" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${row.slug}-deployment.log`; anchor.click(); URL.revokeObjectURL(url); };
  const requestDomain = async (id: number) => { try { const order = await apiFetch(`/api/web-deployments/${id}/domains`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hostname: domain[id] }) }); setDomainOrders((current) => ({ ...current, [id]: order })); if (order.adminFree) { toast({ title: "Administrator domain enabled", description: `${order.message} Add the TXT token shown below: ${order.verificationToken}` }); return; } const payment = await apiFetch("/api/payments/domain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId: order.id, phone }) }); toast({ title: "Domain payment started", description: `${payment.message} Add the TXT token shown below after payment: ${order.verificationToken}` }); } catch (err: any) { toast({ title: "Domain request failed", description: err?.error || "Gold plan is required.", variant: "destructive" }); } };
  const verifyDomain = async (deploymentId: number) => { const order = domainOrders[deploymentId]; if (!order) return; try { const result = await apiFetch(`/api/web-deployments/domains/${order.id}/verify`, { method: "POST" }); toast({ title: "Domain verified", description: result.message }); setDomainOrders((current) => ({ ...current, [deploymentId]: { ...order, status: "active" } })); } catch (err: any) { toast({ title: "Verification pending", description: err?.error || "Add the TXT record and try again.", variant: "destructive" }); } };

  return <div className="space-y-7">
    <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end"><div><p className="eyebrow">Web hosting workspace</p><h1 className="page-title mt-2">Your web deployments</h1><p className="mt-2 max-w-2xl text-sm text-muted-foreground">Connect GitHub once, choose a public or private repository, and receive a live URL with optional push-to-deploy automation.</p></div><Button onClick={() => document.getElementById("new-web-deployment")?.scrollIntoView({ behavior: "smooth" })} className="bg-primary text-primary-foreground"><Plus className="mr-2 h-4 w-4" /> New deployment</Button></div>

    <Card className="soft-card border-primary/20 bg-primary/[0.03]"><CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl border border-primary/25 bg-primary/10"><Github className="h-5 w-5 text-primary" /></div><div><p className="text-sm font-semibold">{githubConnected ? `GitHub connected as @${githubLogin}` : "Connect GitHub to deploy private repositories"}</p><p className="text-xs text-muted-foreground">{githubConnected ? "Your repository picker can access repositories you authorize." : "OAuth uses repository access only on the server and never exposes tokens to the browser."}</p></div></div><div className="flex gap-2"><Button variant="outline" onClick={githubConnected ? loadGithub : connectGithub} disabled={loadingRepos}>{loadingRepos ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : githubConnected ? <RefreshCw className="mr-2 h-4 w-4" /> : <Github className="mr-2 h-4 w-4" />}{githubConnected ? "Refresh repositories" : "Connect GitHub"}</Button>{githubConnected && <Button variant="ghost" className="text-destructive" onClick={async () => { await apiFetch("/api/github/disconnect", { method: "POST" }); setGithubConnected(false); setRepos([]); toast({ title: "GitHub disconnected" }); }}>Disconnect</Button>}</div></CardContent></Card>

    <Card id="new-web-deployment" className="soft-card border-primary/20 bg-primary/[0.03]"><CardHeader className="border-b border-border/50 pb-4"><CardTitle className="flex items-center gap-2 text-base"><WandSparkles className="h-4 w-4 text-primary" /> New web deployment</CardTitle><p className="text-xs text-muted-foreground">Select a connected repository for private access and automatic redeploys, or paste a public URL as before.</p></CardHeader><CardContent className="pt-5"><form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
      {githubConnected && <div className="space-y-2 md:col-span-2"><Label>Connected GitHub repository</Label><Input value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)} placeholder="Search repositories by owner/name" />{selectedRepo && <div className="flex items-center justify-between rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm"><span className="flex items-center gap-2"><Github className="h-4 w-4 text-primary" />{selectedRepo.fullName}<Badge variant="outline" className="text-[10px]">{selectedRepo.private ? "Private" : "Public"}</Badge></span><Button type="button" variant="ghost" size="sm" onClick={() => setSelectedRepo(null)}>Clear</Button></div>}<div className="max-h-48 overflow-auto rounded-lg border border-border/70 bg-background/30">{filteredRepos.length === 0 ? <p className="p-3 text-xs text-muted-foreground">{loadingRepos ? "Loading repositories…" : "No matching repositories."}</p> : filteredRepos.slice(0, 40).map((repo) => <button type="button" key={repo.id} onClick={() => selectRepo(repo)} className={`flex w-full items-center justify-between border-b border-border/40 px-3 py-2 text-left text-xs last:border-0 hover:bg-primary/10 ${selectedRepo?.id === repo.id ? "bg-primary/10" : ""}`}><span className="min-w-0 truncate font-mono">{repo.fullName}</span><span className="ml-3 shrink-0 text-[10px] text-muted-foreground">{repo.private ? "Private" : "Public"} · {repo.defaultBranch}</span></button>)}</div></div>}
      {!selectedRepo && <div className="space-y-2 md:col-span-2"><Label>Public GitHub repository URL</Label><Input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/owner/repository" required={!selectedRepo} /></div>}
      <div className="space-y-2"><Label>Branch</Label><Input value={branch} onChange={(e) => setBranch(e.target.value)} /></div><div className="space-y-2"><Label>Project name</Label><Input value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="My storefront" /></div><div className="space-y-2"><Label>Build command <span className="text-muted-foreground">(optional)</span></Label><Input value={buildCommand} onChange={(e) => setBuildCommand(e.target.value)} placeholder="npm run build" /></div><div className="space-y-2"><Label>Start command <span className="text-muted-foreground">(optional for static)</span></Label><Input value={startCommand} onChange={(e) => setStartCommand(e.target.value)} placeholder="npm start" /></div>
      {selectedRepo && <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-accent/20 bg-accent/5 p-3 md:col-span-2"><input type="checkbox" checked={autoDeploy} onChange={(e) => setAutoDeploy(e.target.checked)} className="mt-0.5 accent-cyan-400" /><span><span className="block text-sm font-medium">Auto deploy on every push to {branch}</span><span className="block text-xs text-muted-foreground">BERAHOST creates and signs the repository webhook automatically.</span></span></label>}
      <div className="space-y-2 md:col-span-2"><Label>Environment values</Label><Textarea value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder="API_URL=https://api.example.com\nPUBLIC_KEY=..." className="font-mono text-xs" /><p className="text-xs text-muted-foreground">BERAHOST scans .env.example/.env.sample during build. Values are used only by this deployment.</p></div><Button type="submit" disabled={busy || (!selectedRepo && !repoUrl)} className="md:col-span-2">{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <WandSparkles className="mr-2 h-4 w-4" />} Deploy application</Button></form></CardContent></Card>

    <div className="space-y-3"><div className="flex items-center justify-between"><div><p className="eyebrow">Live projects</p><h2 className="mt-1 text-xl font-semibold">Your deployments</h2></div><span className="text-xs text-muted-foreground">{rows.length} project{rows.length === 1 ? "" : "s"}</span></div>{rows.length === 0 ? <Card className="border-dashed border-border/70 bg-transparent"><CardContent className="py-16 text-center"><Globe2 className="mx-auto h-10 w-10 text-muted-foreground/40" /><p className="mt-3 text-sm font-medium">No web deployments yet</p><p className="mt-1 text-xs text-muted-foreground">Choose a GitHub repository above to receive a live URL.</p></CardContent></Card> : rows.map((row) => { const live = ["queued", "building", "deploying", "starting"].includes(row.status); const showLogs = openLogs[row.id] || live || ["failed", "crashed"].includes(row.status); return <Card key={row.id} className="soft-card overflow-hidden border-border/70 transition-colors hover:border-primary/35"><CardContent className="p-4 sm:p-5"><div className="flex flex-col gap-4 lg:flex-row lg:items-start"><div className="flex min-w-0 flex-1 items-start gap-3"><div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-secondary/30 bg-secondary/10">{row.githubFullName ? <Github className="h-5 w-5 text-secondary" /> : <Globe2 className="h-5 w-5 text-secondary" />}</div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-base font-semibold">{row.customName || row.slug}</h3><Badge variant="outline" className={`gap-1.5 text-[10px] uppercase ${statusTone(row.status)}`}><span className={`h-1.5 w-1.5 rounded-full ${statusDot(row.status)}`} />{row.status}</Badge>{row.githubPrivate && <Badge variant="outline" className="text-[10px]">Private</Badge>}</div><p className="mt-1 truncate font-mono text-xs text-muted-foreground">{row.githubFullName || row.repoUrl.replace("https://github.com/", "")} · {row.branch}</p><div className="mt-3 flex flex-wrap gap-2"><a href={row.publicUrl} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-xs text-primary hover:bg-primary/10"><ExternalLink className="h-3.5 w-3.5 shrink-0" /><span className="truncate font-mono">{row.publicUrl}</span></a><Button size="sm" variant="ghost" className="h-8 px-2 text-muted-foreground hover:text-primary" onClick={() => copyUrl(row.publicUrl)}><Link2 className="mr-1.5 h-3.5 w-3.5" /> Copy URL</Button></div>{row.lastCommitSha && <p className="mt-2 truncate text-[11px] text-muted-foreground">Latest commit <span className="font-mono text-foreground/80">{row.lastCommitSha}</span>{row.lastCommitMessage ? ` · ${row.lastCommitMessage}` : ""}</p>}</div></div><div className="flex flex-wrap items-center gap-2 lg:justify-end"><a href={row.publicUrl} target="_blank" rel="noreferrer"><Button size="sm" className="bg-primary text-primary-foreground hover:bg-primary/90"><ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Open</Button></a><Button size="sm" variant="outline" className="border-border/70" onClick={() => setOpenLogs((current) => ({ ...current, [row.id]: !showLogs }))}><FileText className="mr-1.5 h-3.5 w-3.5" /> Logs</Button>{row.githubFullName && <Button size="sm" variant="outline" className={row.autoDeploy ? "border-accent/30 text-accent" : "border-border/70 text-muted-foreground"} onClick={() => toggleAutoDeploy(row)}>{row.autoDeploy ? "Auto on" : "Auto off"}</Button>}{row.status === "running" ? <Button size="sm" variant="outline" className="border-destructive/30 text-destructive hover:bg-destructive/10" onClick={() => action(row.id, "stop")}><Square className="mr-1.5 h-3.5 w-3.5" /> Stop</Button> : <Button size="sm" variant="outline" className="border-accent/30 text-accent hover:bg-accent/10" onClick={() => action(row.id, "start")} disabled={live}><Play className="mr-1.5 h-3.5 w-3.5" /> Start</Button>}<Button size="sm" variant="outline" className="border-destructive/30 text-destructive hover:bg-destructive/10" onClick={() => deleteDeployment(row)}><Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete</Button></div></div>{showLogs && <div className="mt-4 overflow-hidden rounded-xl border border-border/60 bg-black/55"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-3 py-2"><p className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-muted-foreground"><FileText className="h-3.5 w-3.5 text-primary" /> Deployment logs {live && <span className="text-primary">· live</span>}</p><div className="flex items-center gap-2"><span className="text-[10px] font-mono text-muted-foreground">{row.status}</span><Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[10px]" onClick={() => copyLogs(row)}>Copy all</Button><Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[10px]" onClick={() => downloadLogs(row)}>Download</Button></div></div><pre className="max-h-[70vh] min-h-[420px] select-text overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-foreground/90">{row.buildLog || "Waiting for deployment logs..."}</pre></div>}<div className="mt-4 rounded-xl border border-border/60 bg-background/25 p-3"><div className="mb-2 flex items-center justify-between"><p className="text-xs font-medium">Custom domain</p><span className="text-[10px] text-muted-foreground">{user?.isAdmin ? "FREE for admin" : "Gold · KES 134"}</span></div><div className="grid gap-2 md:grid-cols-[1fr_180px_auto]"><Input value={domain[row.id] || ""} onChange={(e) => setDomain({ ...domain, [row.id]: e.target.value })} placeholder="app.example.com" /><Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07XXXXXXXX" /><Button size="sm" variant="secondary" onClick={() => requestDomain(row.id)}>Add domain</Button></div>{domainOrders[row.id] && <div className="mt-3 rounded-lg border border-primary/20 bg-primary/[0.04] p-3 text-xs"><p className="font-semibold">Domain status: {domainOrders[row.id].status || "pending"}</p><p className="mt-1 text-muted-foreground">{domainOrders[row.id].adminFree ? "Add this TXT record to verify the administrator domain:" : "After PayHero confirms payment, publish this TXT record:"} <code className="break-all text-primary">_berahost.{domainOrders[row.id].hostname} = {domainOrders[row.id].verificationToken}</code></p><Button size="sm" className="mt-3" variant="outline" onClick={() => verifyDomain(row.id)} disabled={domainOrders[row.id].status === "active"}>Verify DNS</Button></div>}</div></CardContent></Card>; })}</div>
  </div>;
}
