export function getRequiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

export function getOptionalEnv(
  name: string,
  fallback?: string,
): string | undefined {
  const value = Deno.env.get(name) ?? fallback;
  return value || undefined;
}
