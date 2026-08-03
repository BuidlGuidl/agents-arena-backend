const runSecrets = new Map<string, Set<string>>();

export function registerCredentialSecrets(runId: string, secrets: readonly string[]): void {
  const eligible = secrets.filter((secret) => secret.length >= 8);
  if (eligible.length === 0) return;

  const registered = runSecrets.get(runId) ?? new Set<string>();
  for (const secret of eligible) registered.add(secret);
  runSecrets.set(runId, registered);
}

export function credentialSecrets(runId: string): readonly string[] {
  return [...(runSecrets.get(runId) ?? [])];
}

export function dropCredentialSecrets(runId: string): void {
  runSecrets.delete(runId);
}
