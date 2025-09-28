import type { SupabaseClient } from "@supabase/supabase-js";

type VaultFn =
  | "vault_create_secret"
  | "vault_update_secret"
  | "vault_get_secret";

async function invokeVaultFn(
  client: SupabaseClient,
  fn: VaultFn,
  path: string,
  value: string,
): Promise<string> {
  const params = fn === "vault_get_secret"
    ? { secret_name: path }
    : { secret_name: path, secret_value: value };

  const { data, error } = await client.rpc(
    fn,
    params as Record<string, unknown>,
  );

  if (error) {
    throw new Error(`${fn} failed: ${error.message}`);
  }

  if (typeof data === "string") {
    return data;
  }

  if (data && typeof data === "object") {
    if ("id" in data) {
      const idValue = (data as { id?: unknown }).id;
      if (typeof idValue === "string") {
        return idValue;
      }
    }
    if ("secret" in data) {
      const secretValue = (data as { secret?: unknown }).secret;
      if (typeof secretValue === "string") {
        return secretValue;
      }
    }
  }

  throw new Error(`${fn} did not return expected payload`);
}

export async function upsertSecret(
  client: SupabaseClient,
  path: string,
  value: string,
): Promise<string> {
  try {
    return await invokeVaultFn(client, "vault_create_secret", path, value);
  } catch (rawError) {
    const error = rawError as Error;
    if (!error.message.includes("already exists")) {
      throw error;
    }
    return await invokeVaultFn(client, "vault_update_secret", path, value);
  }
}

export async function getSecret(
  client: SupabaseClient,
  path: string,
): Promise<string | null> {
  try {
    const value = await invokeVaultFn(client, "vault_get_secret", path, "");
    return value;
  } catch (rawError) {
    const error = rawError as Error;
    if (error.message.includes("not found")) {
      return null;
    }
    throw error;
  }
}
