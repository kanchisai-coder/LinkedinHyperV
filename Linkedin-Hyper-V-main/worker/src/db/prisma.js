// FILE: worker/src/db/prisma.js
// Prisma Client singleton with connection pooling

'use strict';

const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

let prisma = null;

/**
 * Get Prisma Client singleton instance
 * @returns {PrismaClient}
 */
function getPrisma() {
  if (!prisma) {
    const databaseUrl = process.env.DATABASE_URL;
    
    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    const adapter = new PrismaPg({ connectionString: databaseUrl });

    // Slow-query logging: emit `query` events so we can flag slow ones.
    // Threshold (ms) is configurable; default 250ms. Set <=0 to disable.
    const slowQueryMs = Number.parseInt(process.env.PRISMA_SLOW_QUERY_MS || '250', 10);
    const verboseQueries = process.env.NODE_ENV === 'development';

    prisma = new PrismaClient({
      adapter,
      log: [
        { level: 'query', emit: 'event' },
        { level: 'warn', emit: 'stdout' },
        { level: 'error', emit: 'stdout' },
      ],
    });

    prisma.$on('query', (e) => {
      const duration = Number(e.duration) || 0;
      if (verboseQueries) {
        // Full query logging in dev only
        console.log(`[Prisma][query ${duration}ms] ${e.query}`);
      } else if (slowQueryMs > 0 && duration >= slowQueryMs) {
        // Production: only flag slow queries. Trim params to avoid log spam.
        const params = typeof e.params === 'string' && e.params.length > 200
          ? `${e.params.slice(0, 200)}…`
          : e.params;
        console.warn(`[Prisma][slow ${duration}ms] ${e.query} -- params=${params}`);
      }
    });

    // Handle graceful shutdown
    process.on('beforeExit', async () => {
      await prisma.$disconnect();
    });

    console.log(`[Prisma] Database client initialized (slowQueryMs=${slowQueryMs})`);
  }

  return prisma;
}

/**
 * Disconnect Prisma Client
 */
async function disconnectPrisma() {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
    console.log('[Prisma] Database client disconnected');
  }
}

/**
 * Check database connection
 * @returns {Promise<boolean>}
 */
async function checkDatabaseConnection() {
  try {
    const client = getPrisma();
    await client.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    console.error('[Prisma] Database connection check failed:', error.message);
    return false;
  }
}

module.exports = {
  getPrisma,
  disconnectPrisma,
  checkDatabaseConnection,
};
