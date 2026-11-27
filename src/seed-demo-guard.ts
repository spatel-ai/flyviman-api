const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Why the demo seed must not run here, or null when it may. It writes known
 * passwords onto staff accounts, so it needs all of: not production, dev
 * tools switched on, and a database on this machine.
 */
export function demoSeedRefusal(env: {
  NODE_ENV?: string;
  ENABLE_DEV_TOOLS?: string;
  MIGRATION_DATABASE_URL?: string;
  DATABASE_URL?: string;
}): string | null {
  if (env.NODE_ENV === 'production') {
    return 'The demo data is never seeded in production.';
  }
  if (env.ENABLE_DEV_TOOLS !== 'true') {
    return 'The demo data needs ENABLE_DEV_TOOLS=true.';
  }
  let host = '';
  try {
    host = new URL(env.MIGRATION_DATABASE_URL || env.DATABASE_URL || '')
      .hostname;
  } catch {
    // Unparseable or missing: refused below.
  }
  if (!LOCAL_HOSTS.has(host)) {
    return 'The demo data is only seeded into a database on this machine.';
  }
  return null;
}
