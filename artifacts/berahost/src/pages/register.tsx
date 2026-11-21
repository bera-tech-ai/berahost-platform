import { useState } from "react";
import { Link, useLocation } from "wouter";
import { motion } from "framer-motion";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useRegister, useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, UserPlus, Shield, Eye, EyeOff } from "lucide-react";

const registerSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  phone: z.string().optional(),
  referralCode: z.string().optional(),
});

type RegisterForm = z.infer<typeof registerSchema>;

export default function Register() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { refetch } = useGetMe({ query: { enabled: false, queryKey: getGetMeQueryKey() } });
  const [showPassword, setShowPassword] = useState(false);
  const referralCodeFromLink = new URLSearchParams(window.location.search).get("ref")?.trim().toUpperCase() ?? "";

  const registerForm = useForm<RegisterForm>({
    resolver: zodResolver(registerSchema),
    defaultValues: { email: "", password: "", phone: "", referralCode: referralCodeFromLink },
  });

  const registerMutation = useRegister({
    mutation: {
      onSuccess: async () => {
        await refetch();
        toast({
          title: "Account created",
          description: registerForm.getValues("referralCode")
            ? "Welcome to BERAHOST. Your referral was recorded for attribution."
            : "Welcome to your BERAHOST workspace.",
        });
        setLocation("/dashboard");
      },
      onError: (error) => {
        toast({
          title: "Registration failed",
          description: (error as any).error || "Could not create account",
          variant: "destructive",
        });
      },
    },
  });

  function onSubmit(values: RegisterForm) {
    registerMutation.mutate({
      data: {
        email: values.email,
        password: values.password,
        phone: values.phone?.trim() || undefined,
        referralCode: values.referralCode?.trim() || undefined,
      },
    });
  }

  return (
     <div className="min-h-[100dvh] bg-background flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom,_var(--tw-gradient-stops))] from-secondary/10 via-background to-background pointer-events-none" />
      <div className="absolute -left-40 bottom-20 w-96 h-96 bg-primary/20 rounded-full blur-[100px] pointer-events-none" />
      <div className="absolute -right-40 top-20 w-96 h-96 bg-secondary/20 rounded-full blur-[100px] pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-md z-10"
      >
        <Card className="border-secondary/30 bg-card/60 backdrop-blur-xl shadow-[0_0_30px_rgba(180,0,255,0.1)]">
          <CardHeader className="space-y-1 text-center">
             <CardTitle className="text-3xl font-semibold tracking-tight text-foreground">
              BERAHOST
            </CardTitle>
             <CardDescription className="mt-2 text-sm text-muted-foreground">
               Set up a workspace for your WhatsApp bot operations.
            </CardDescription>
            <div className="flex items-center justify-center gap-2 pt-2">
                 <div className="flex items-center gap-1.5 text-xs px-3 py-1 rounded-full border border-secondary/60 bg-secondary/10 text-secondary">
                <Shield className="h-3 w-3" />
                 No WhatsApp verification required
              </div>
            </div>
          </CardHeader>

          <CardContent>
             <div className="mb-5 rounded-lg border border-primary/20 bg-primary/5 p-3">
               <p className="text-xs leading-5 text-muted-foreground">
                 Start with email and password. You can add a WhatsApp number later from Settings when a bot needs it.
              </p>
            </div>

            <Form {...registerForm}>
               <form onSubmit={registerForm.handleSubmit(onSubmit)} className="space-y-4" data-testid="form-register">
                <FormField
                  control={registerForm.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                       <FormLabel className="text-sm text-muted-foreground">
                         Email address
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="email"
                           data-testid="input-register-email" autoComplete="email" placeholder="you@company.com"
                          {...field}
                          className="bg-background/50 border-secondary/30 focus-visible:border-secondary focus-visible:ring-secondary/50 font-mono"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={registerForm.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                       <FormLabel className="text-sm text-muted-foreground">
                         Password
                      </FormLabel>
                      <FormControl>
                         <div className="relative"><Input data-testid="input-register-password" autoComplete="new-password" type={showPassword ? "text" : "password"} placeholder="At least 6 characters" {...field} className="bg-background/50 border-secondary/30 pr-10 focus-visible:border-secondary focus-visible:ring-secondary/50" /><button type="button" data-testid="button-toggle-register-password" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((value) => !value)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={registerForm.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                       <FormLabel className="text-sm text-muted-foreground">
                         WhatsApp number <span className="text-muted-foreground/60">(optional)</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                           data-testid="input-register-phone" autoComplete="tel" placeholder="254 712 345 678"
                          {...field}
                          className="bg-background/50 border-border/50 focus-visible:border-primary focus-visible:ring-primary/50 font-mono"
                        />
                      </FormControl>
                      <p className="text-[10px] font-mono text-muted-foreground">
                        You can add a number later from Settings.
                      </p>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={registerForm.control}
                  name="referralCode"
                  render={({ field }) => (
                    <FormItem>
                        <FormLabel className="text-sm text-muted-foreground">
                         Referral code <span className="text-muted-foreground/60">(optional)</span>
                      </FormLabel>
                      {referralCodeFromLink && (
                        <p className="text-xs text-primary/80">Referral code loaded from your invite link. It records attribution only.</p>
                      )}
                      <FormControl>
                        <Input
                           data-testid="input-register-referral" placeholder="Enter a code if you have one"
                          {...field}
                          className="bg-background/50 border-secondary/30 focus-visible:border-secondary focus-visible:ring-secondary/50 font-mono uppercase"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Button
                  type="submit"
                   data-testid="button-submit-register" className="w-full font-medium bg-primary hover:bg-primary/90 text-primary-foreground transition-all mt-2"
                  disabled={registerMutation.isPending}
                >
                  {registerMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <UserPlus className="mr-2 h-4 w-4" />
                  )}
                   {registerMutation.isPending ? "Creating account…" : "Create account"}
                </Button>
              </form>
            </Form>
          </CardContent>

          <CardFooter className="flex flex-col space-y-4 text-center text-sm border-t border-border/50 pt-6">
            <div className="text-muted-foreground font-mono text-xs">
              Already registered?{" "}
              <Link href="/login" className="text-secondary hover:text-secondary/80 underline underline-offset-4 decoration-secondary/30">
                 Sign in
              </Link>
            </div>
          </CardFooter>
        </Card>
      </motion.div>
    </div>
  );
}
