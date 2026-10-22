import { FormEvent, useEffect, useState } from "react";
import { ExternalLink, Globe2, Loader2, Play, Plus, Square, WandSparkles } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

export default function WebDeploymentsPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState<any[]>([]);
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [customName, setCustomName] = useState("");
  const [buildCommand, setBuildCommand] = useState("");
  const [startCommand, setStartCommand] = useState("");
  const [envText, setEnvText] = useState("");
  const [busy, setBusy] = useState(false);
  const [domain, setDomain] = useState<Record<number, string>>({});
  const [phone, setPhone] = useState("");
  const [domainOrders, setDomainOrders] = useState<Record<number, any>>({});

  const load = () => apiFetch("/api/web-deployments").then(setRows).catch(() => setRows([]));
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try {
      const envVars: Record<string, string> = {};
      envText.split("\n").forEach((line) => { const i = line.indexOf("="); if (i > 0) envVars[line.slice(0, i).trim()] = line.slice(i + 1).trim(); });
      await apiFetch("/api/web-deployments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repoUrl, branch, customName, buildCommand, startCommand, envVars }) });
      toast({ title: "Web deployment queued", description: "BERAHOST is cloning, scanning, and building your repository." });
      setRepoUrl(""); setCustomName(""); setEnvText(""); await load();
    } catch (err: any) { toast({ title: "Deployment rejected", description: err?.error || "Check your subscription and repository URL.", variant: "destructive" }); }
    finally { setBusy(false); }
  };
  const action = async (id: number, verb: "start" | "stop") => { try { await apiFetch(`/api/web-deployments/${id}/${verb}`, { method: "POST" }); await load(); } catch (err: any) { toast({ title: "Action failed", description: err?.error || "Try again.", variant: "destructive" }); } };
  const requestDomain = async (id: number) => { try { const order = await apiFetch(`/api/web-deployments/${id}/domains`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hostname: domain[id] }) }); setDomainOrders((current) => ({ ...current, [id]: order })); const payment = await apiFetch("/api/payments/domain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId: order.id, phone }) }); toast({ title: "Domain payment started", description: `${payment.message} Add the TXT token shown below after payment: ${order.verificationToken}` }); } catch (err: any) { toast({ title: "Domain request failed", description: err?.error || "Gold plan is required.", variant: "destructive" }); } };
  const verifyDomain = async (deploymentId: number) => { const order = domainOrders[deploymentId]; if (!order) return; try { const result = await apiFetch(`/api/web-deployments/domains/${order.id}/verify`, { method: "POST" }); toast({ title: "Domain verified", description: result.message }); setDomainOrders((current) => ({ ...current, [deploymentId]: { ...order, status: "active" } })); } catch (err: any) { toast({ title: "Verification pending", description: err?.error || "Add the TXT record and try again.", variant: "destructive" }); } };

  return <div className="space-y-8">
    <div><p className="text-xs font-mono uppercase tracking-[0.2em] text-primary">WEB HOSTING</p><h1 className="mt-2 text-3xl font-black tracking-tight">Deploy a website from GitHub</h1><p className="mt-2 max-w-2xl text-muted-foreground">Static sites and Node web applications get a unique hosted URL. Your monthly plan controls how many bot and web runtimes you can keep hosted.</p></div>
    <Card className="border-primary/20 bg-primary/[0.03]"><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plus className="h-4 w-4 text-primary" /> New web deployment</CardTitle></CardHeader><CardContent><form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
      <div className="space-y-2 md:col-span-2"><Label>Public GitHub repository</Label><Input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/owner/repository" required /></div>
      <div className="space-y-2"><Label>Branch</Label><Input value={branch} onChange={(e) => setBranch(e.target.value)} /></div><div className="space-y-2"><Label>Project name</Label><Input value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="My storefront" /></div>
      <div className="space-y-2"><Label>Build command <span className="text-muted-foreground">(optional)</span></Label><Input value={buildCommand} onChange={(e) => setBuildCommand(e.target.value)} placeholder="npm run build" /></div><div className="space-y-2"><Label>Start command <span className="text-muted-foreground">(optional for static)</span></Label><Input value={startCommand} onChange={(e) => setStartCommand(e.target.value)} placeholder="npm start" /></div>
      <div className="space-y-2 md:col-span-2"><Label>Environment values</Label><Textarea value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder="API_URL=https://api.example.com\nPUBLIC_KEY=..." className="font-mono text-xs" /><p className="text-xs text-muted-foreground">BERAHOST scans .env.example/.env.sample during build. Values are used only by this deployment.</p></div>
      <Button type="submit" disabled={busy} className="md:col-span-2">{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <WandSparkles className="mr-2 h-4 w-4" />} Deploy web application</Button>
    </form></CardContent></Card>
    <div className="space-y-4"><div className="flex items-center gap-2"><Globe2 className="h-5 w-5 text-primary" /><h2 className="text-xl font-bold">Your hosted web deployments</h2></div>
      {rows.length === 0 ? <Card><CardContent className="py-12 text-center text-muted-foreground">No web deployments yet. Connect a public GitHub repository above.</CardContent></Card> : rows.map((row) => <Card key={row.id}><CardContent className="space-y-4 p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-bold">{row.customName || row.slug}</h3><p className="font-mono text-xs text-muted-foreground">{row.repoUrl} · {row.branch}</p></div><Badge variant="outline" className="uppercase">{row.status}</Badge></div><a className="flex items-center gap-2 text-sm text-primary hover:underline" href={row.publicUrl} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" /> {row.publicUrl}</a><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => action(row.id, "start")} disabled={row.status === "running"}><Play className="mr-1.5 h-3.5 w-3.5" /> Start</Button><Button size="sm" variant="outline" onClick={() => action(row.id, "stop")} disabled={row.status !== "running"}><Square className="mr-1.5 h-3.5 w-3.5" /> Stop</Button></div><details className="rounded-lg border border-border/60 bg-background/30 p-3"><summary className="cursor-pointer text-xs font-mono uppercase tracking-wider text-muted-foreground">Deployment logs · {row.status}</summary><pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground/80">{row.buildLog || "Waiting for deployment logs..."}</pre></details><div className="grid gap-2 rounded-lg border border-border/60 bg-background/30 p-3 md:grid-cols-[1fr_180px_auto]"><Input value={domain[row.id] || ""} onChange={(e) => setDomain({ ...domain, [row.id]: e.target.value })} placeholder="app.example.com" /><Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07XXXXXXXX" /><Button size="sm" variant="secondary" onClick={() => requestDomain(row.id)}>Add domain · KES 134</Button></div>{domainOrders[row.id] && <div className="rounded-lg border border-primary/20 bg-primary/[0.03] p-3 text-xs"><p className="font-semibold">Domain status: {domainOrders[row.id].status || "pending"}</p><p className="mt-1 text-muted-foreground">After PayHero confirms payment, publish this TXT record: <code className="break-all text-primary">_berahost.{domainOrders[row.id].hostname} = {domainOrders[row.id].verificationToken}</code></p><Button size="sm" className="mt-3" variant="outline" onClick={() => verifyDomain(row.id)} disabled={domainOrders[row.id].status === "active"}>Verify DNS</Button></div>}</CardContent></Card>)}
    </div>
  </div>;
}
