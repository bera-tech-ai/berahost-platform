import { useState } from "react";
import { motion } from "framer-motion";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  KeyRound,
  Plus,
  Copy,
  Trash2,
  Clock,
  ShieldCheck,
  AlertTriangle,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  Terminal,
} from "lucide-react";
import { useListApiKeys, useCreateApiKey, useRevokeApiKey } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { formatDistanceToNow, format } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const SCOPES = [
  {
    id: "read",
    label: "Read",
    color: "text-blue-400",
    bg: "bg-blue-400/10 border-blue-400/30",
    description: "Read your owned resources, logs, metrics, plans/status, payment history, support, teams and connected repositories",
  },
  {
    id: "write",
    label: "Write",
    color: "text-green-400",
    bg: "bg-green-400/10 border-green-400/30",
    description: "Manage your owned deployments, web apps, schedules, support, teams and marketplace submissions; implies read",
  },
  {
    id: "payments",
    label: "Payments",
    color: "text-yellow-400",
    bg: "bg-yellow-400/10 border-yellow-400/30",
    description: "Start PayHero subscription or domain checkout; implies read but not write",
  },
] as const;

type ScopeId = "read" | "write" | "payments";

const keySchema = z.object({
  name: z.string().min(3, "Name must be at least 3 characters").max(100, "Name must be 100 characters or fewer"),
  scopes: z.array(z.string()).min(1, "Select at least one scope"),
});

// ─── Code block with copy ─────────────────────────────────────────────────
function CodeBlock({ code, lang = "bash" }: { code: string; lang?: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    toast({ title: "Copied" });
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="relative rounded-lg bg-black/60 border border-border/40 overflow-hidden mt-2">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/30 bg-white/5">
        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">{lang}</span>
        <button onClick={copy} className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-primary transition-colors">
          {copied ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto text-xs font-mono leading-relaxed text-foreground/90 whitespace-pre">{code}</pre>
    </div>
  );
}

// ─── Collapsible endpoint doc block ──────────────────────────────────────
function Endpoint({
  method,
  path,
  scope,
  description,
  body,
  responseExample,
}: {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  scope: string;
  description: string;
  body?: string;
  responseExample?: string;
}) {
  const [open, setOpen] = useState(false);
  const colors: Record<string, string> = {
    GET: "text-blue-400 bg-blue-400/10 border-blue-400/30",
    POST: "text-green-400 bg-green-400/10 border-green-400/30",
    PUT: "text-yellow-400 bg-yellow-400/10 border-yellow-400/30",
    PATCH: "text-orange-400 bg-orange-400/10 border-orange-400/30",
    DELETE: "text-red-400 bg-red-400/10 border-red-400/30",
  };
  const scopeColors: Record<string, string> = {
    read: "border-blue-500/40 text-blue-400",
    write: "border-green-500/40 text-green-400",
    payments: "border-yellow-500/40 text-yellow-400",
    public: "border-muted-foreground/40 text-muted-foreground",
  };
  return (
    <div className="border border-border/30 rounded-lg overflow-hidden bg-card/20">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 p-3 hover:bg-white/5 transition-colors text-left"
      >
        <span className={`font-mono text-xs font-bold px-2 py-0.5 rounded border ${colors[method]} shrink-0`}>{method}</span>
        <code className="font-mono text-xs text-foreground/80 flex-1">{path}</code>
        <Badge variant="outline" className={`text-[10px] font-mono shrink-0 ${scopeColors[scope]}`}>{scope}</Badge>
        {open ? <ChevronUp className="h-3 w-3 text-muted-foreground shrink-0" /> : <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />}
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-border/20 pt-3">
          <p className="text-sm text-muted-foreground">{description}</p>
          {body && (
            <>
              <p className="text-xs font-mono text-muted-foreground uppercase">Request Body</p>
              <CodeBlock code={body} lang="json" />
            </>
          )}
          {responseExample && (
            <>
              <p className="text-xs font-mono text-muted-foreground uppercase">Response</p>
              <CodeBlock code={responseExample} lang="json" />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────
export default function ApiKeysPage() {
  const { data: apiKeys, isLoading, refetch } = useListApiKeys();
  const { toast } = useToast();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  const createMutation = useCreateApiKey({
    mutation: {
      onSuccess: (data: any) => {
        setNewKey(data.key);
        toast({ title: "API Key Generated", description: "Save this key now — it won't be shown again." });
        form.reset();
        refetch();
      },
      onError: (err: any) => {
        toast({ title: "Error", description: err.error || "Failed to create API key", variant: "destructive" });
      }
    }
  });

  const revokeMutation = useRevokeApiKey({
    mutation: {
      onSuccess: () => {
        toast({ title: "Key Revoked", description: "The API key has been permanently deactivated." });
        refetch();
      },
      onError: (err: any) => {
        toast({ title: "Error", description: err.error || "Failed to revoke key", variant: "destructive" });
      }
    }
  });

  const form = useForm<z.infer<typeof keySchema>>({
    resolver: zodResolver(keySchema),
    defaultValues: { name: "", scopes: ["read"] },
  });

  const selectedScopes = form.watch("scopes");

  const onSubmit = (values: z.infer<typeof keySchema>) => {
    createMutation.mutate({ data: { name: values.name, scopes: values.scopes } });
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied", description: "API key copied to clipboard" });
  };

  const closeDialog = () => { setIsDialogOpen(false); setNewKey(null); };

  const container = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.08 } } };
  const item = { hidden: { opacity: 0, y: 20 }, show: { opacity: 1, y: 0 } };

  const apiBase = `${window.location.protocol}//${window.location.host}${BASE}/api`;

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-4xl mx-auto">
        <Skeleton className="h-10 w-64 mb-2" />
        <Skeleton className="h-5 w-96" />
        <div className="grid gap-4 mt-8">{[1, 2].map(i => <Skeleton key={i} className="h-32 w-full" />)}</div>
      </div>
    );
  }

  return (
    <motion.div className="space-y-6 max-w-4xl mx-auto" variants={container} initial="hidden" animate="show">

      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
        <motion.div variants={item}>
           <h1 className="page-title flex items-center gap-3">
             <KeyRound className="h-7 w-7 text-primary" /> API keys
          </h1>
           <p className="mt-2 text-sm text-muted-foreground">
             Create scoped credentials for scripts and deployment tooling. Keys are shown once.
          </p>
        </motion.div>
        <motion.div variants={item}>
          <Dialog open={isDialogOpen} onOpenChange={(open) => !open && closeDialog()}>
            <DialogTrigger asChild>
               <Button data-testid="button-create-api-key" className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={() => setIsDialogOpen(true)}>
                 <Plus className="mr-2 h-4 w-4" /> Create API key
              </Button>
            </DialogTrigger>
            <DialogContent className="border-primary/30 bg-card/95 backdrop-blur-xl max-w-md">
              <DialogHeader>
                <DialogTitle className="font-bold text-xl text-primary">GENERATE API KEY</DialogTitle>
                <DialogDescription className="font-mono text-xs">
                  Choose a name and the permissions this key should have.
                </DialogDescription>
              </DialogHeader>

              {newKey ? (
                <div className="space-y-4 py-4">
                  <div className="p-4 rounded-lg bg-accent/10 border border-accent/30 text-accent flex items-start gap-3">
                    <ShieldCheck className="h-5 w-5 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold text-sm mb-1">Key Generated Successfully</p>
                      <p className="text-xs font-mono opacity-80">Copy this key now. You won't be able to see it again.</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input value={newKey} readOnly className="font-mono text-sm bg-background/80 border-primary/30 text-primary h-12" />
                     <Button size="icon" data-testid="button-copy-new-api-key" aria-label="Copy API key" className="h-12 w-12 shrink-0" onClick={() => copyToClipboard(newKey)}>
                      <Copy className="h-5 w-5" />
                    </Button>
                  </div>
                   <Button className="w-full mt-4" onClick={closeDialog}>I have saved my key</Button>
                </div>
              ) : (
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5 py-4">
                    <FormField control={form.control} name="name" render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-mono text-xs uppercase text-muted-foreground">Key Name</FormLabel>
                        <FormControl>
                          <Input placeholder="E.g., My Discord Bot, CI/CD Pipeline" {...field} className="bg-background/50 font-mono" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />

                    <FormField control={form.control} name="scopes" render={() => (
                      <FormItem>
                        <FormLabel className="font-mono text-xs uppercase text-muted-foreground">Permissions (Scopes)</FormLabel>
                        <div className="space-y-2 mt-1">
                          {SCOPES.map(scope => (
                            <label key={scope.id} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${selectedScopes.includes(scope.id) ? scope.bg : "border-border/30 bg-transparent"}`}>
                              <Checkbox
                                checked={selectedScopes.includes(scope.id)}
                                onCheckedChange={(checked) => {
                                  const current = form.getValues("scopes");
                                  form.setValue("scopes", checked ? [...current, scope.id] : current.filter(s => s !== scope.id));
                                }}
                                className="mt-0.5"
                              />
                              <div>
                                <span className={`font-mono text-sm font-bold ${scope.color}`}>{scope.label}</span>
                                <p className="text-xs text-muted-foreground mt-0.5">{scope.description}</p>
                              </div>
                            </label>
                          ))}
                        </div>
                        <FormMessage />
                      </FormItem>
                    )} />

                     <Button type="submit" data-testid="button-submit-api-key" className="w-full bg-primary hover:bg-primary/90 text-primary-foreground" disabled={createMutation.isPending}>
                       {createMutation.isPending ? "Creating key…" : "Create key"}
                    </Button>
                  </form>
                </Form>
              )}
            </DialogContent>
          </Dialog>
        </motion.div>
      </div>

      {/* ── Keys list ── */}
      <motion.div variants={item} className="grid gap-4">
        {apiKeys && apiKeys.length > 0 ? (
          apiKeys.map((apiKey: any) => (
            <Card key={apiKey.id} className="border-border/50 bg-card/30 backdrop-blur-sm hover:border-primary/30 transition-all">
              <CardContent className="p-4 sm:p-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div className="flex items-start gap-4">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                    <KeyRound className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-bold text-base mb-1">{apiKey.name || "Unnamed Key"}</h3>
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {(apiKey.scopes ?? []).map((s: string) => {
                        const sc = SCOPES.find(x => x.id === s);
                        return (
                          <Badge key={s} variant="outline" className={`text-[10px] font-mono ${sc?.color ?? ""}`}>
                            {s}
                          </Badge>
                        );
                      })}
                    </div>
                    <div className="flex flex-wrap items-center gap-4 text-xs font-mono text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        Created {format(new Date(apiKey.createdAt), "MMM d, yyyy")}
                      </span>
                      {apiKey.lastUsed ? (
                        <span className="flex items-center gap-1 text-primary/70">
                          Last used {formatDistanceToNow(new Date(apiKey.lastUsed), { addSuffix: true })}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50">Never used</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 self-end sm:self-auto">
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                       <Button variant="outline" size="sm" data-testid={`button-revoke-api-key-${apiKey.id}`} className="border-destructive/30 text-destructive hover:bg-destructive/10">
                         <Trash2 className="mr-2 h-3 w-3" /> Revoke
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent className="border-destructive/30 bg-card/95 backdrop-blur-xl">
                      <AlertDialogHeader>
                        <AlertDialogTitle className="flex items-center gap-2 text-destructive">
                          <AlertTriangle className="h-5 w-5" /> Revoke API Key?
                        </AlertDialogTitle>
                        <AlertDialogDescription className="font-mono">
                          This cannot be undone. Any app using this key will immediately lose API access.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel className="font-mono">CANCEL</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-destructive hover:bg-destructive/90 font-mono text-destructive-foreground"
                          onClick={() => revokeMutation.mutate({ id: apiKey.id })}
                        >
                          CONFIRM REVOCATION
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </CardContent>
            </Card>
          ))
        ) : (
          <Card className="border-dashed border-border/50 bg-transparent">
            <CardContent className="flex flex-col items-center justify-center py-20 text-center">
              <KeyRound className="h-12 w-12 text-muted-foreground/30 mb-4" />
               <h3 className="text-xl font-semibold mb-2">No API keys yet</h3>
               <p className="text-muted-foreground max-w-sm">
                 Create a scoped key when you are ready to connect an internal tool or deployment workflow.
              </p>
            </CardContent>
          </Card>
        )}
      </motion.div>

      {/* ── Developer Docs ── */}
      <motion.div variants={item}>
        <Card className="border-primary/20 bg-card/20 backdrop-blur-sm">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-lg font-bold">
              <BookOpen className="h-5 w-5 text-primary" /> Developer Documentation
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              Use your API key to automate everything — deployments, bot management, payments & more.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">

            {/* ── Authentication ── */}
            <div>
              <h3 className="font-bold text-sm uppercase tracking-widest text-muted-foreground mb-3 flex items-center gap-2">
                <Terminal className="h-4 w-4" /> Authentication
              </h3>
              <p className="text-sm text-muted-foreground mb-2">
                Send your API key in <strong>one</strong> of these headers with every request:
              </p>
              <Tabs defaultValue="header">
                <TabsList className="h-8 bg-black/40">
                  <TabsTrigger value="header" className="text-xs font-mono">x-api-key</TabsTrigger>
                  <TabsTrigger value="bearer" className="text-xs font-mono">Authorization</TabsTrigger>
                  <TabsTrigger value="curl" className="text-xs font-mono">cURL example</TabsTrigger>
                  <TabsTrigger value="js" className="text-xs font-mono">JavaScript</TabsTrigger>
                  <TabsTrigger value="py" className="text-xs font-mono">Python</TabsTrigger>
                </TabsList>
                <TabsContent value="header">
                  <CodeBlock lang="http" code={`x-api-key: <your-api-key>`} />
                </TabsContent>
                <TabsContent value="bearer">
                  <CodeBlock lang="http" code={`Authorization: Bearer <your-api-key>`} />
                </TabsContent>
                <TabsContent value="curl">
                  <CodeBlock lang="bash" code={`curl ${apiBase}/deployments \\
  -H "x-api-key: <your-api-key>"`} />
                </TabsContent>
                <TabsContent value="js">
                  <CodeBlock lang="javascript" code={`const API = "${apiBase}";
const KEY = "<your-api-key>";

const res = await fetch(\`\${API}/deployments\`, {
  headers: { "x-api-key": KEY }
});
const deployments = await res.json();`} />
                </TabsContent>
                <TabsContent value="py">
                  <CodeBlock lang="python" code={`import requests

API = "${apiBase}"
KEY = "<your-api-key>"
HEADERS = {"x-api-key": KEY}

r = requests.get(f"{API}/deployments", headers=HEADERS)
print(r.json())`} />
                </TabsContent>
              </Tabs>
              <div className="mt-3 rounded-lg border border-yellow-400/20 bg-yellow-400/5 p-3 text-xs text-muted-foreground">
                Use HTTPS and keep keys in a secret manager or server-side environment variable; never put them in browser code, source control, URLs, or logs. A key is shown only once. Revoke a lost key and create a replacement. <code>write</code> includes <code>read</code>; <code>payments</code> includes <code>read</code> but does not grant write access. Public catalog reads need no key.
              </div>
            </div>

            {/* ── Scope table ── */}
            <div>
              <h3 className="font-bold text-sm uppercase tracking-widest text-muted-foreground mb-3">Scopes</h3>
              <div className="rounded-lg border border-border/30 overflow-hidden text-sm">
                <div className="grid grid-cols-3 bg-white/5 px-4 py-2 text-xs font-mono text-muted-foreground uppercase">
                  <span>Scope</span><span>Can also use</span><span>What it allows</span>
                </div>
                {[
                  { scope: "read", color: "text-blue-400", implies: "—", what: "Read owned customer resources and public catalogs" },
                  { scope: "write", color: "text-green-400", implies: "read", what: "Manage owned bot/web deployments, schedules, marketplace, teams and support" },
                  { scope: "payments", color: "text-yellow-400", implies: "read", what: "Start PayHero subscription and domain checkout" },
                ].map(row => (
                  <div key={row.scope} className="grid grid-cols-3 px-4 py-2 border-t border-border/20 items-center">
                    <Badge variant="outline" className={`w-fit text-[11px] font-mono ${row.color}`}>{row.scope}</Badge>
                    <span className="font-mono text-xs text-muted-foreground">{row.implies}</span>
                    <span className="text-xs text-muted-foreground">{row.what}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Endpoints ── */}
            <div>
              <h3 className="font-bold text-sm uppercase tracking-widest text-muted-foreground mb-2">Customer API endpoints</h3>
              <p className="text-sm text-muted-foreground mb-4">Paths below include the <code>/api</code> prefix. Resource IDs are numeric unless a path says otherwise. Public catalog reads do not require a key; private operations are restricted to the key owner's resources.</p>

              <p className="text-xs font-mono text-primary/60 mb-2 uppercase tracking-widest">Bot catalog (public)</p>
              <div className="space-y-1.5 mb-4">
                <Endpoint method="GET" path="/api/bots" scope="public" description="List available bot templates and identifiers. Use this response to choose botId when creating a deployment." responseExample={`[{ "id": 1, "name": "<bot-name>", "platform": "whatsapp" }]`} />
                <Endpoint method="GET" path="/api/bots/:id" scope="public" description="Read a bot template's description, platform, required/optional environment-variable names, and session setup guidance." />
              </div>

              <p className="text-xs font-mono text-primary/60 mb-2 uppercase tracking-widest">Bot deployments, logs, metrics and schedules</p>
              <div className="space-y-1.5 mb-4">
                <Endpoint method="GET" path="/api/deployments" scope="read" description="List your bot deployments. Stored environment values are omitted from API-key responses." responseExample={`[{ "id": 24, "botId": 1, "status": "running", "createdAt": "<ISO-8601>" }]`} />
                <Endpoint method="POST" path="/api/deployments" scope="write" description="Create and start a bot deployment. Requires an active subscription and remaining bot capacity on your current plan. Use botId from GET /api/bots. envVars is accepted but omitted from API-key responses." body={`{ "botId": 1, "customName": "My bot", "envVars": { "SESSION_ID": "<your-session-value>" } }`} responseExample={`{ "id": 24, "botId": 1, "status": "stopped", "createdAt": "<ISO-8601>" }`} />
                <Endpoint method="GET" path="/api/deployments/:id" scope="read" description="Read one of your deployments; another customer's deployment is reported as not found." />
                <Endpoint method="DELETE" path="/api/deployments/:id" scope="write" description="Stop and permanently delete one of your bot deployments." />
                <Endpoint method="POST" path="/api/deployments/:id/start" scope="write" description="Start an owned bot. Requires an active subscription and available running-bot capacity." />
                <Endpoint method="POST" path="/api/deployments/:id/stop" scope="write" description="Stop an owned bot deployment." />
                <Endpoint method="PUT" path="/api/deployments/:id/env" scope="write" description="Update the environment configuration for an owned bot; secrets are write-only through API-key responses." body={`{ "SESSION_ID": "<your-session-value>", "OWNER_NUMBER": "<your-phone-number>" }`} />
                <Endpoint method="POST" path="/api/deployments/:id/clone" scope="write" description="Create a copy of an owned bot deployment. Subscription and bot-capacity checks still apply; provide a new session value before starting." />
                <Endpoint method="POST" path="/api/deployments/:id/phone" scope="write" description="Set the phone number used by the owned bot and restart it if currently running." body={`{ "phone": "254712345678" }`} responseExample={`{ "ok": true, "phone": "254712345678", "restarted": false }`} />
                <Endpoint method="PUT" path="/api/deployments/:id/webhook" scope="write" description="Set or clear the deployment's outbound webhook URL and event list." body={`{ "webhookUrl": "https://example.com/hooks/berahost", "events": ["crash", "restart"] }`} />
                <Endpoint method="POST" path="/api/deployments/:id/webhook/test" scope="write" description="Send a test event to the webhook configured for this owned deployment." />
                <Endpoint method="GET" path="/api/deployments/:id/logs" scope="read" description="Read recent deployment logs. Optional query parameter limit controls the number of returned lines. Known environment values and credential-like assignments are redacted for API-key clients." responseExample={`[{ "id": 501, "deploymentId": 24, "logLine": "Connected", "logType": "stdout", "createdAt": "<ISO-8601>" }]`} />
                <Endpoint method="GET" path="/api/deployments/:id/logs/search" scope="read" description="Search logs for an owned bot. Query parameters: q (text), type (stdout/stderr/info/warn/error), since (date-time), limit (maximum 500). Results are redacted for API-key clients." />
                <Endpoint method="GET" path="/api/deployments/:id/logs/export" scope="read" description="Export an owned bot's logs. Optional format=json; defaults to plain text. Secret values are redacted for API-key clients." />
                <Endpoint method="GET" path="/api/deployments/:id/logs/stream" scope="read" description="Subscribe to live deployment logs using Server-Sent Events (text/event-stream). Close the connection to stop the stream; secret values are redacted." />
                <Endpoint method="GET" path="/api/deployments/:id/metrics" scope="read" description="Read CPU, memory, thread count, status, uptime and recent-log count for an owned bot." responseExample={`{ "deploymentId": 24, "status": "running", "cpu": 0.4, "memMb": 128, "threads": 8, "logsLastHour": 42, "uptime": 3600 }`} />
                <Endpoint method="GET" path="/api/deployments/:id/schedule" scope="read" description="Read the owned bot's scheduled restart; returns null if none is configured." />
                <Endpoint method="PUT" path="/api/deployments/:id/schedule" scope="write" description="Create or update a daily restart schedule. restartTime is 24-hour HH:MM; timezone defaults to Africa/Nairobi." body={`{ "restartTime": "03:00", "timezone": "Africa/Nairobi", "isEnabled": true, "note": "Daily refresh" }`} />
                <Endpoint method="DELETE" path="/api/deployments/:id/schedule" scope="write" description="Remove an owned bot's restart schedule." />
              </div>

              <p className="text-xs font-mono text-primary/60 mb-2 uppercase tracking-widest">Web deployments</p>
              <div className="space-y-1.5 mb-4">
                <Endpoint method="GET" path="/api/web-deployments" scope="read" description="List your web apps, status, repository, public URL and plan expiry. Stored environment values are omitted for API-key requests." />
                <Endpoint method="GET" path="/api/web-deployments/:id" scope="read" description="Read one owned web deployment." />
                <Endpoint method="POST" path="/api/web-deployments/scan" scope="write" description="Validate a public GitHub repository URL before deployment. Environment scanning runs during the first build." body={`{ "repoUrl": "https://github.com/owner/repository" }`} />
                <Endpoint method="POST" path="/api/web-deployments" scope="write" description="Create a web app from a public repoUrl or a previously connected githubRepo. branch, envVars, buildCommand, startCommand and customName are optional as applicable. Requires an active plan and available web-app capacity." body={`{ "repoUrl": "https://github.com/owner/repository", "branch": "main", "customName": "My site", "buildCommand": "npm run build", "startCommand": "npm start", "envVars": { "API_TOKEN": "<your-value>" } }`} />
                <Endpoint method="PATCH" path="/api/web-deployments/:id" scope="write" description="Update an owned deployment's branch or autoDeploy setting. A connected GitHub repository is required to enable managed auto-deploy." body={`{ "branch": "main", "autoDeploy": true }`} />
                <Endpoint method="POST" path="/api/web-deployments/:id/start" scope="write" description="Restart an owned web app. Requires an active subscription." />
                <Endpoint method="POST" path="/api/web-deployments/:id/stop" scope="write" description="Stop an owned web app." />
                <Endpoint method="DELETE" path="/api/web-deployments/:id" scope="write" description="Delete an owned web app, its runtime, managed webhook, and related domain orders." />
                <Endpoint method="POST" path="/api/web-deployments/:id/domains" scope="payments" description="Create a custom-domain request for an owned web app. Available on the active Gold plan; the returned TXT verification token is shown at creation. Current request price is returned as amountKes." body={`{ "hostname": "app.example.com" }`} responseExample={`{ "id": 12, "hostname": "app.example.com", "amountKes": 134, "verificationToken": "<one-time-TXT-value>" }`} />
                <Endpoint method="POST" path="/api/web-deployments/domains/:id/verify" scope="write" description="Verify a paid domain order by checking the _berahost.<hostname> TXT record. Use the token returned when the order was created; verification errors do not repeat the stored token." />
              </div>

              <p className="text-xs font-mono text-primary/60 mb-2 uppercase tracking-widest">Plans, subscriptions and PayHero payments</p>
              <div className="space-y-1.5 mb-4">
                <Endpoint method="GET" path="/api/subscriptions/plans" scope="public" description="Read the server's current canonical plan catalog, including price, term, deployment limits and features. No plan facts are hard-coded in this guide." responseExample={`[{ "id": "<plan-id>", "name": "<plan-name>", "priceKes": "<current-price>", "maxBots": "<bot-limit>", "maxWebApps": "<web-limit>", "billing": "monthly" }]`} />
                <Endpoint method="GET" path="/api/payments/plans" scope="public" description="Compatibility catalog endpoint returning the current plan list under subscriptionPlans." responseExample={`{ "subscriptionPlans": [{ "id": "<plan-id>", "priceKes": "<current-price>", "billing": "monthly" }] }`} />
                <Endpoint method="GET" path="/api/subscriptions/status" scope="read" description="Read your current plan, canonical plan details, expiry and active state." responseExample={`{ "plan": "starter", "planDetails": { "id": "starter", "name": "Starter" }, "expiresAt": "<ISO-8601>", "isActive": true, "billing": "monthly" }`} />
                <Endpoint method="POST" path="/api/payments/subscribe" scope="payments" description="Start PayHero checkout for a monthly plan. Choose the plan ID from the public plan catalog and provide a valid Kenyan phone number." body={`{ "plan": "<plan-id-from-catalog>", "phone": "254712345678" }`} responseExample={`{ "message": "Payment initiated for <plan-name>. Check your phone for the M-Pesa prompt.", "transactionId": 42, "plan": "<plan-id>", "amountKes": "<current-price>" }`} />
                <Endpoint method="POST" path="/api/payments/domain" scope="payments" description="Start PayHero checkout for an owned pending domain order." body={`{ "orderId": 12, "phone": "254712345678" }`} responseExample={`{ "message": "Domain payment initiated. Check your phone for the M-Pesa prompt.", "transactionId": 43, "amountKes": 134 }`} />
                <Endpoint method="GET" path="/api/payments/status/:id" scope="read" description="Read the status of one of your payment transactions." responseExample={`{ "id": 42, "status": "pending", "package": "sub:starter", "amountKes": 70 }`} />
                <Endpoint method="GET" path="/api/payments/history" scope="read" description="List up to the latest 50 payment transactions for your account." />
              </div>

              <p className="text-xs font-mono text-primary/60 mb-2 uppercase tracking-widest">Marketplace, support, notifications and teams</p>
              <div className="space-y-1.5 mb-4">
                <Endpoint method="GET" path="/api/marketplace/submissions" scope="read" description="List your own bot submissions and their review state." />
                <Endpoint method="POST" path="/api/marketplace/submit" scope="write" description="Submit a bot template for review. platform must be whatsapp, telegram, or discord." body={`{ "name": "Example bot", "description": "A short description", "repoUrl": "https://github.com/owner/repository", "platform": "whatsapp", "sessionGuideUrl": "https://example.com/setup", "sessionPrefix": "<prefix>", "requiredVars": [], "optionalVars": [], "startCommand": "npm start" }`} />
                <Endpoint method="GET" path="/api/support/tickets" scope="read" description="List your own support tickets." />
                <Endpoint method="POST" path="/api/support/tickets" scope="write" description="Create a support ticket and its first message. subject and message are required; priority is optional." body={`{ "subject": "Deployment question", "message": "Describe the issue here", "priority": "medium" }`} />
                <Endpoint method="GET" path="/api/support/tickets/:id/messages" scope="read" description="Read messages for one of your own support tickets." />
                <Endpoint method="POST" path="/api/support/tickets/:id/messages" scope="write" description="Add a message to one of your own support tickets." body={`{ "message": "Additional details" }`} />
                <Endpoint method="GET" path="/api/notifications" scope="read" description="List your latest notifications." />
                <Endpoint method="POST" path="/api/notifications/:id/read" scope="write" description="Mark one of your own notifications as read." />
                <Endpoint method="GET" path="/api/teams" scope="read" description="List teams you own or belong to. API-key responses omit member email addresses and stored invite codes." />
                <Endpoint method="POST" path="/api/teams" scope="write" description="Create a team. Its inviteCode is returned to the owner in this creation response; share it only with intended members." body={`{ "name": "My team" }`} responseExample={`{ "id": 7, "name": "My team", "inviteCode": "<invite-code>", "message": "Team created successfully" }`} />
                <Endpoint method="POST" path="/api/teams/join" scope="write" description="Join a team using an invite code provided by its owner." body={`{ "inviteCode": "<invite-code>" }`} />
                <Endpoint method="DELETE" path="/api/teams/:id/members/:memberId" scope="write" description="Remove a member from a team you own." />
                <Endpoint method="POST" path="/api/teams/:id/regenerate-invite" scope="write" description="Rotate the invite code for a team you own; the new code is returned only in this response." />
              </div>

              <p className="text-xs font-mono text-primary/60 mb-2 uppercase tracking-widest">Referrals and connected GitHub</p>
              <div className="space-y-1.5 mb-4">
                <Endpoint method="GET" path="/api/referrals/my" scope="read" description="Read your referral code/link, total count and recent referral timestamps. Reward amounts and referred users' email addresses are not returned." />
                <Endpoint method="POST" path="/api/referrals/apply" scope="write" description="Apply a referral code once to your account; this records attribution and does not grant plan access or payment credit." body={`{ "referralCode": "<referral-code>" }`} responseExample={`{ "message": "Referral applied successfully." }`} />
                <Endpoint method="GET" path="/api/github/status" scope="read" description="Read whether your GitHub account is already connected and its public profile identity; does not manage OAuth credentials." />
                <Endpoint method="GET" path="/api/github/repos" scope="read" description="List repositories available to your already-connected GitHub account. Connect/disconnect and credential operations remain browser-session-only." />
                <Endpoint method="GET" path="/api/github/repos/branches" scope="read" description="List branches for a repository available to your connected GitHub account. Query parameter: fullName=owner/repository." />
              </div>

              <p className="text-xs font-mono text-primary/60 mb-2 uppercase tracking-widest">API-key management</p>
              <div className="space-y-1.5">
                <Endpoint method="GET" path="/api/api-keys" scope="read" description="List your key metadata and scopes. Existing raw keys and hashes are never returned." />
                <Endpoint method="POST" path="/api/api-keys" scope="write" description="Create a key. The raw value is returned once; only its hash is stored. API-key callers cannot create a key with broader scopes than their own." body={`{ "name": "CI deploy key", "scopes": ["read", "write"], "expiresAt": "<optional-future-ISO-8601-or-null>"}`} responseExample={`{ "id": 9, "key": "<shown-once>", "name": "CI deploy key", "scopes": ["read", "write"], "expiresAt": null }`} />
                <Endpoint method="DELETE" path="/api/api-keys/:id" scope="write" description="Revoke one of your own keys immediately; a key can revoke itself." />
              </div>
            </div>

            {/* ── Full example ── */}
            <div>
              <h3 className="font-bold text-sm uppercase tracking-widest text-muted-foreground mb-3">Full Deploy Example</h3>
              <p className="text-sm text-muted-foreground mb-2">Choose a bot from the public catalog, create a deployment, then poll its status:</p>
              <Tabs defaultValue="js2">
                <TabsList className="h-8 bg-black/40">
                  <TabsTrigger value="js2" className="text-xs font-mono">JavaScript</TabsTrigger>
                  <TabsTrigger value="py2" className="text-xs font-mono">Python</TabsTrigger>
                  <TabsTrigger value="curl2" className="text-xs font-mono">cURL</TabsTrigger>
                </TabsList>
                <TabsContent value="js2">
                  <CodeBlock lang="javascript" code={`const API  = "${apiBase}";
const KEY  = "<your-api-key>";
const hdrs = { "x-api-key": KEY, "Content-Type": "application/json" };

// 1. Deploy the bot
const deploy = await fetch(\`\${API}/deployments\`, {
  method: "POST",
  headers: hdrs,
  body: JSON.stringify({
    botId: 1,                                       // 1 = Atassa-MD
    envVars: { SESSION_ID: "<session-value>" }, // your session string
  }),
}).then(r => r.json());

console.log("Deployment ID:", deploy.id);

// 2. Poll until running (or failed)
let status = deploy.status;
for (let attempt = 0; attempt < 60 && status !== "running" && status !== "failed"; attempt++) {
  await new Promise(r => setTimeout(r, 5000));
  const d = await fetch(\`\${API}/deployments/\${deploy.id}\`, { headers: hdrs }).then(r => r.json());
  status = d.status;
  console.log("Status:", status);
}

// 3. Check subscription status after deployment
const subscription = await fetch(\`\${API}/subscriptions/status\`, { headers: hdrs }).then(r => r.json());
console.log("Subscription expires:", subscription.expiresAt);`} />
                </TabsContent>
                <TabsContent value="py2">
                  <CodeBlock lang="python" code={`import requests, time

API   = "${apiBase}"
KEY   = "<your-api-key>"
HDRS  = {"x-api-key": KEY, "Content-Type": "application/json"}

# 1. Choose a template from the public catalog, then deploy
bot_id = requests.get(f"{API}/bots").json()[0]["id"]
deploy = requests.post(f"{API}/deployments", headers=HDRS, json={
    "botId": bot_id,
    "envVars": {"SESSION_ID": "<session-value>"}
}).json()
print("Deployment ID:", deploy["id"])

# 2. Poll until running
status = deploy["status"]
for _ in range(60):
    if status in ("running", "failed"): break
    time.sleep(5)
    d = requests.get(f"{API}/deployments/{deploy['id']}", headers=HDRS).json()
    status = d["status"]
    print("Status:", status)

# 3. Subscription status
subscription = requests.get(f"{API}/subscriptions/status", headers=HDRS).json()
print("Subscription expires:", subscription["expiresAt"])`} />
                </TabsContent>
                <TabsContent value="curl2">
                  <CodeBlock lang="bash" code={`# Deploy
curl -X POST ${apiBase}/deployments \\
  -H "x-api-key: <your-api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{"botId":1,"envVars":{"SESSION_ID":"<session-value>"}}'

# Check status
curl ${apiBase}/deployments/24 \\
  -H "x-api-key: <your-api-key>"

# Stop the bot
curl -X POST ${apiBase}/deployments/24/stop \\
  -H "x-api-key: <your-api-key>"`} />
                </TabsContent>
              </Tabs>
            </div>

            {/* ── Error reference ── */}
            <div>
              <h3 className="font-bold text-sm uppercase tracking-widest text-muted-foreground mb-3">Error Responses</h3>
              <div className="rounded-lg border border-border/30 overflow-hidden text-sm">
                <div className="grid grid-cols-3 bg-white/5 px-4 py-2 text-xs font-mono text-muted-foreground uppercase">
                  <span>HTTP Code</span><span>Error</span><span>Cause</span>
                </div>
                {[
                  ["401", "Unauthorized", "Missing or invalid API key"],
                  ["401", "Invalid or expired API key", "Key revoked, or past expiry date"],
                  ["403", "API key missing required scope", "Key doesn't have the scope needed for this endpoint"],
                  ["400", "Invalid request", "A required field or resource value is invalid"],
                  ["402", "Subscription required", "An active subscription is required for this deployment action"],
                  ["403", "Plan limit or feature restriction", "Capacity is full or the requested feature is unavailable on your plan"],
                  ["404", "Resource not found", "ID does not exist or belongs to another user"],
                  ["409", "GitHub connection required", "Repository browsing requires an already-connected GitHub account"],
                  ["502", "Payment provider error", "PayHero could not start the requested payment"],
                ].map(([code, err, cause], i) => (
                  <div key={i} className="grid grid-cols-3 px-4 py-2 border-t border-border/20 items-start">
                    <span className={`font-mono text-xs font-bold ${code.startsWith("4") ? "text-red-400" : "text-muted-foreground"}`}>{code}</span>
                    <span className="font-mono text-xs text-foreground/70">{err}</span>
                    <span className="text-xs text-muted-foreground">{cause}</span>
                  </div>
                ))}
              </div>
            </div>

          </CardContent>
        </Card>
      </motion.div>
    </motion.div>
  );
}
