import { Activity, AlertTriangle, CheckCircle2, CircleHelp, RefreshCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const BASE = import.meta.env.BASE_URL;
type ServiceCheck = { id: string; name: string; status: "operational" | "degraded" | "not_monitored"; detail: string };
type StatusResponse = { checkedAt: string; services: ServiceCheck[] };

export default function StatusPage() {
  const { data, isLoading, isError, refetch, dataUpdatedAt } = useQuery<StatusResponse>({
    queryKey: ["public-service-status"],
    queryFn: async () => {
      const response = await fetch(`${BASE}api/status`, { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to read the service status");
      return response.json();
    },
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
  });

  const hasIssue = data?.services.some((service) => service.status === "degraded") ?? false;
  const statusIcon = (status: ServiceCheck["status"]) => status === "operational"
    ? <CheckCircle2 className="h-5 w-5 text-emerald-400" />
    : status === "degraded"
      ? <AlertTriangle className="h-5 w-5 text-destructive" />
      : <CircleHelp className="h-5 w-5 text-muted-foreground" />;
  const badgeClass = (status: ServiceCheck["status"]) => status === "operational"
    ? "border-emerald-400/30 text-emerald-400"
    : status === "degraded" ? "border-destructive/30 text-destructive" : "border-border text-muted-foreground";

  return <main className="mx-auto min-h-[100dvh] max-w-4xl space-y-6 bg-background px-4 py-12 sm:px-6">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div><Link href="/" className="text-sm text-primary hover:underline">BERAHOST</Link><p className="eyebrow mt-6">SERVICE TRANSPARENCY</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Service status</h1><p className="mt-2 text-sm text-muted-foreground">Live checks for the dashboard API and database, with monitoring limits stated clearly.</p></div>
      <Button variant="outline" onClick={() => void refetch()} disabled={isLoading}><RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />Refresh</Button>
    </header>

    {data && <Card className={hasIssue ? "border-destructive/30 bg-destructive/5" : "border-emerald-400/20 bg-emerald-400/[0.03]"}><CardContent className="flex items-center gap-3 p-5"><Activity className={`h-5 w-5 ${hasIssue ? "text-destructive" : "text-emerald-400"}`} /><div><p className="font-medium">{hasIssue ? "A monitored check needs attention" : "All monitored checks are responding"}</p><p className="mt-1 text-xs text-muted-foreground">Last checked {new Date(data.checkedAt).toLocaleString()}</p></div></CardContent></Card>}

    <Card><CardHeader><CardTitle className="text-base">Service components</CardTitle></CardHeader><CardContent className="space-y-3">
      {isLoading && !data && <p className="py-6 text-center text-sm text-muted-foreground">Checking BERAHOST services…</p>}
      {isError && !data && <p role="alert" className="py-6 text-center text-sm text-destructive">The status check could not be reached. The dashboard may be unavailable or the check itself may have failed.</p>}
      {(data?.services ?? []).map((service) => <div key={service.id} className="flex flex-wrap items-start gap-3 rounded-lg border border-border/60 bg-background/40 p-4"><div className="pt-0.5">{statusIcon(service.status)}</div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="font-medium">{service.name}</p><Badge variant="outline" className={badgeClass(service.status)}>{service.status === "not_monitored" ? "Not monitored" : service.status}</Badge></div><p className="mt-1 text-sm text-muted-foreground">{service.detail}</p></div></div>)}
    </CardContent></Card>

    <p className="text-xs leading-5 text-muted-foreground">This page does not provide an uptime history or SLA. Bot and web runtime states are available to signed-in customers per deployment. PayHero transaction outcomes are shown per payment; BERAHOST does not currently poll PayHero availability.</p>
    {dataUpdatedAt > 0 && <p className="text-right text-[11px] text-muted-foreground">Page refreshed {new Date(dataUpdatedAt).toLocaleTimeString()} · automatic refresh every 30 seconds</p>}
  </main>;
}
