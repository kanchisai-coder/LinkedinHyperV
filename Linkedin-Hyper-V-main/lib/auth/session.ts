// FILE: lib/auth/session.ts
import { NextRequest } from 'next/server';
import { verifyToken, type JWTPayload } from './jwt';
import { Redis } from 'ioredis';

let redis: Redis | null = null;
let redisWarningShown = false;
let redisUnavailableUntil = 0;
let redisDisabledNoticeShown = false;
const REDIS_OPERATION_TIMEOUT_MS = parseInt(process.env.REDIS_SESSION_TIMEOUT_MS || '2500', 10);

function isRedisDisabled(): boolean {
  return process.env.DISABLE_REDIS === '1';
}

function markRedisUnavailable(error: unknown): void {
  // Avoid hammering DNS/connection retries when Redis is unavailable in local dev.
  redisUnavailableUntil = Date.now() + 60_000;
  if (!redisWarningShown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[auth/session] Redis unavailable, skipping token blacklist checks: ${message}`);
    redisWarningShown = true;
  }
}

function createRedisClient(): Redis {
  const url = process.env.REDIS_URL?.trim();
  const options = {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1 as const,
    connectTimeout: 2000,
    commandTimeout: 2000,
    retryStrategy: () => null,
  };

  const client = url
    ? new Redis(url, options)
    : new Redis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: Number(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD || undefined,
        ...options,
      });

  client.on('error', (error) => {
    markRedisUnavailable(error);
  });

  return client;
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`[auth/session] ${label} timed out after ${REDIS_OPERATION_TIMEOUT_MS}ms`));
    }, REDIS_OPERATION_TIMEOUT_MS);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function getRedis(): Redis | null {
  if (isRedisDisabled()) {
    if (!redisDisabledNoticeShown) {
      redisDisabledNoticeShown = true;
      console.warn('[auth/session] DISABLE_REDIS=1 enabled, skipping token blacklist checks');
    }
    return null;
  }

  if (Date.now() < redisUnavailableUntil) {
    return null;
  }

  if (!redis) {
    redis = createRedisClient();
  }

  return redis;
}

/**
 * Extract and verify session from request cookies
 */
export async function getSession(req: NextRequest): Promise<JWTPayload | null> {
  const token = req.cookies.get('app_session')?.value;
  if (!token) return null;
  
  const payload = await verifyToken(token);
  if (!payload) return null;
  
  // Check if token is blacklisted (for logout)
  if (payload.jti) {
    const redisClient = getRedis();
    if (redisClient) {
      try {
        const isBlacklisted = await withTimeout(
          redisClient.get(`jwt:blacklist:${payload.jti}`),
          'blacklist lookup'
        );
        if (isBlacklisted) return null;
      } catch (error) {
        markRedisUnavailable(error);
        redis?.disconnect();
        redis = null;
      }
    }
  }
  
  return payload;
}

/**
 * Blacklist a JWT token (for logout)
 */
export async function blacklistToken(jti: string, expiresIn: number): Promise<void> {
  const redisClient = getRedis();
  if (!redisClient) {
    return;
  }

  try {
    await withTimeout(
      redisClient.setex(`jwt:blacklist:${jti}`, expiresIn, '1'),
      'blacklist write'
    );
  } catch (error) {
    markRedisUnavailable(error);
    redis?.disconnect();
    redis = null;
  }
}
