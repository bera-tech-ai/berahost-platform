import { useCallback, useEffect, useState } from "react";
import { CreditCard, History, CheckCircle2, Clock, XCircle, RefreshCw, LifeBuoy, Download } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";

type Payment = {
  id: number;
  payheroTxnId?: string | null;
  phone?: string | null;
  amountKes: number;
  package: string;
  status: string;
  createdAt: string;
};

export default function PaymentsPage() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try { setPayments(await apiFetch("/api/payments/history")); }
    catch { setError("Payment history could not be loaded. Refresh to try again."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const statusIcon = (status: string) => status === "success"
    ? <CheckCircle2 className="h-4 w-4 text-accent" />
    : status === "failed"
      ? <XCircle className="h-4 w-4 text-destructive" />
      : <Clock className="h-4 w-4 text-yellow-400" />;
  const packageName = (value: string) => value?.startsWith("sub:")
    ? `${value.slice(4)} monthly subscription`
    : value?.startsWith("domain:") ? "Custom domain request" : "Hosting payment";
  const downloadReceipt = (payment: Payment) => {
    const receipt = [
      "BERAHOST PAYMENT RECORD",
      `Transaction: ${payment.id}`,
      `Status: ${payment.status}`,
      `Description: ${packageName(payment.package)}`,
      `Amount: KES ${payment.amountKes}`,
      `Date: ${new Date(payment.createdAt).toLocaleString()}`,
      `PayHero reference: ${payment.payheroTxnId || "Not provided"}`,
      "This payment record is not a tax invoice.",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([receipt], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `berahost-payment-${payment.id}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return <div className="space-y-8">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><p className="text-xs font-mono uppercase tracking-[0.2em] text-primary">BILLING LEDGER</p><h1 className="mt-2 text-3xl font-black">Subscription payments</h1><p className="mt-2 text-muted-foreground">Review PayHero transaction status, amount, date, and provider reference.</p></div>
      <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button>
    </div>
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><History className="h-5 w-5 text-primary" /> Payment history</CardTitle></CardHeader><CardContent>
      {error ? <p role="alert" className="py-8 text-center text-sm text-destructive">{error}</p>
        : loading ? <p className="py-8 text-center text-sm text-muted-foreground">Loading transactions…</p>
        : payments.length === 0 ? <div className="py-10 text-center text-muted-foreground">No payment transactions yet. <Link href="/subscriptions" className="text-primary hover:underline">View subscription plans</Link>.</div>
        : <div className="space-y-3">{payments.map((payment) => <div key={payment.id} className="rounded-lg border border-border/50 bg-background/30 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3">{statusIcon(payment.status)}<div><p className="font-semibold">{packageName(payment.package)}</p><p className="text-xs text-muted-foreground">{new Date(payment.createdAt).toLocaleString()} · {payment.phone || "PayHero"}</p></div></div><div className="flex items-center gap-3"><span className="font-mono font-bold">KES {payment.amountKes}</span><Badge variant="outline" className="uppercase">{payment.status}</Badge></div></div>
          {payment.payheroTxnId && <p className="mt-3 break-all text-xs text-muted-foreground">PayHero reference: <code className="font-mono text-foreground/80">{payment.payheroTxnId}</code></p>}
          {payment.status === "pending" && <p className="mt-3 rounded-md border border-yellow-400/20 bg-yellow-400/5 p-3 text-xs text-muted-foreground">Waiting for PayHero confirmation. Check the M-Pesa prompt and allow the transaction to update before starting another checkout.</p>}
          {payment.status === "failed" && <div className="mt-3 rounded-md border border-destructive/20 bg-destructive/5 p-3 text-xs text-muted-foreground"><p>PayHero did not confirm this payment. You can try checkout again from <Link href="/subscriptions" className="text-primary underline">Plans</Link>. If M-Pesa charged you, contact <Link href="/support" className="text-primary underline">support</Link> with the transaction ID and provider reference.</p></div>}
          {payment.status === "success" && <p className="mt-3 text-xs text-accent">Payment confirmed by PayHero.</p>}
          {payment.status === "success" && <Button size="sm" variant="outline" className="mt-3" onClick={() => downloadReceipt(payment)}><Download className="mr-2 h-3.5 w-3.5" />Download payment record</Button>}
        </div>)}</div>}
    </CardContent></Card>
    <Card className="border-primary/20 bg-primary/[0.03]"><CardContent className="flex items-start gap-3 p-5"><CreditCard className="mt-0.5 h-5 w-5 text-primary" /><p className="text-sm text-muted-foreground">Subscriptions run for 30 days. When a subscription ends, bot and web runtimes stop automatically but their records remain stored until you renew. This page shows provider references only when PayHero returns one; it does not issue a separate tax receipt.</p><LifeBuoy className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /></CardContent></Card>
  </div>;
}
