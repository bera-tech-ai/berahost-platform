import { useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

// Fallback GitHub connection: when the OAuth "Connect GitHub" flow cannot
// be completed, the user pastes a personal access token instead. The API
// verifies it against GitHub and stores it encrypted server-side — the
// token is never shown again after saving.
export default function GithubTokenConnect({ onConnected }: { onConnected: (login: string | null) => void }) {
  const { toast } = useToast();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const value = token.trim();
    if (value.length < 20) {
      toast({ title: "Paste your GitHub token", description: "The token looks too short — copy the whole thing from GitHub.", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const status = await apiFetch("/api/github/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: value }) });
      setToken("");
      toast({ title: "GitHub connected", description: `Connected as @${status.login}. Your token is stored encrypted and never shown again.` });
      onConnected(status.login || null);
    } catch (err: any) {
      toast({ title: "Token not saved", description: err?.error || "GitHub did not accept that token.", variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <p className="flex items-center gap-2 text-sm font-medium"><KeyRound className="h-4 w-4" /> Connect with a token instead</p>
      <p className="text-xs text-muted-foreground">
        If the Connect GitHub button isn't working, create a personal access token on GitHub
        (<a className="text-primary hover:underline" href="https://github.com/settings/tokens/new?scopes=repo&description=BERAHOST" target="_blank" rel="noreferrer">this page opens it with the right settings</a> — tick <span className="font-mono">repo</span>, generate, copy), then paste it here. It is verified, stored encrypted like a secret, and used only to publish and deploy your projects.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="ghp_… or github_pat_…"
          autoComplete="off"
          className="min-w-64 flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
        />
        <Button onClick={save} disabled={busy}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
          Save token
        </Button>
      </div>
    </div>
  );
}
