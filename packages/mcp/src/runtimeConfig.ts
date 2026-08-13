export function readOptionalBoundedInteger(
  name: string,
  min: number,
  max: number,
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = env[name];
  if (!raw?.trim()) return undefined;
  const normalized = raw.trim();
  const value = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
