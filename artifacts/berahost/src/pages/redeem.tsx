import { FormEvent, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { TicketCheck } from "lucide-react";
import { format } from "date-fns";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
const BASE = import.meta.env.BASE_URL;
async function redeem(code: string) {
  const response = await fetch(`${BASE}api/redeem-codes/redeem`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) throw new Error(data?.error || data?.message || `Request failed (${response.status})`);
  return data;
}
export default function RedeemPage() {
  const [code, setCode] = useState("");
  const mutation = useMutation({ mutationFn: redeem });
  const submit = (event: FormEvent) => { event.preventDefault(); mutation.mutate(code.trim()); };
  return <div className="mx-auto max-w-2xl space-y-6"><header><p className="text-xs font-mono uppercase tracking-[.2em] text-primary">Account / Benefit</p><h1 className="mt-2 text-2xl font-bold tracking-tight">Redeem a code</h1><p className="mt-1 text-sm text-muted-foreground">Apply a BERAHOST plan benefit code to your signed-in account.</p></header><Card className="border-primary/20 bg-primary/[.03]"><CardHeader><div className="mb-2 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><TicketCheck className="h-5 w-5"/></div><CardTitle>Enter your code</CardTitle><CardDescription>Code benefits are plan time, not cash, coins, credits, or a discount.</CardDescription></CardHeader><CardContent><form onSubmit={submit} className="space-y-4"><Input autoComplete="off" value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="e.g. BERA-XXXXXX" aria-label="Redeem code" className="h-12 font-mono tracking-wider"/><Button className="w-full" disabled={!code.trim() || mutation.isPending}>{mutation.isPending ? "Applying code…" : "Redeem benefit"}</Button></form>{mutation.isError && <div role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">Code could not be redeemed: {mutation.error.message}</div>}{mutation.isSuccess && <div role="status" className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4"><p className="font-medium text-emerald-400">Benefit applied successfully</p><p className="mt-1 text-sm text-muted-foreground">{mutation.data?.message || `${mutation.data?.plan || "Plan"} benefit is now active.`}</p><p className="mt-1 text-sm">Plan: <span className="font-semibold">{mutation.data?.plan || "—"}</span>{mutation.data?.expiresAt && <> · Active through {format(new Date(mutation.data.expiresAt), "MMM d, yyyy")}</>}</p></div>}</CardContent></Card></div>;
}
