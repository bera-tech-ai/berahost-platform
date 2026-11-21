const SENSITIVE_KEY = /(?:SESSION|TOKEN|SECRET|PASSWORD|API[_-]?KEY|AUTHORIZATION|COOKIE|WEBHOOK|PHONE|DATABASE|PRIVATE)/i;
const ASSIGNMENT_PATTERN = /\b((?:[A-Z0-9]+_)*(?:SESSION|TOKEN|SECRET|PASSWORD|API[_-]?KEY|AUTHORIZATION|COOKIE|WEBHOOK|PHONE|DATABASE|PRIVATE)(?:_[A-Z0-9]+)*)\s*([=:])\s*("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi;

export function redactLogSecrets(value: unknown, envVars: unknown): string {
  let line = String(value ?? "");
  if (envVars && typeof envVars === "object" && !Array.isArray(envVars)) {
    for (const [key, raw] of Object.entries(envVars as Record<string, unknown>)) {
      if (!SENSITIVE_KEY.test(key) || raw === null || raw === undefined) continue;
      const secret = String(raw);
      if (secret.length < 3) continue;
      line = line.split(secret).join("[REDACTED]");
    }
  }
  return line.replace(ASSIGNMENT_PATTERN, (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`);
}
