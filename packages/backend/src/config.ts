export function resolveListenHost(value = process.env.ARENA_HOST): string {
  return value?.trim() || '127.0.0.1';
}
