import { Pool } from 'pg';

let pool: Pool | null = null;

function maskConnectionString(value: string): string {
  try {
    const url = new URL(value);
    if (url.password) {
      url.password = '***';
    }
    return url.toString();
  } catch {
    return '<invalid connection string>';
  }
}

function getPool(): Pool {
  if (pool) return pool;
  
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const postgresUrl = process.env.POSTGRES_URL?.trim();
  const connectionString = databaseUrl || postgresUrl;
  
  if (!connectionString) {
    if (process.env.npm_lifecycle_event === 'build') {
      console.warn('POSTGRES_URL or DATABASE_URL environment variable is not set. Using dummy pool for build.');
      pool = new Pool();
      return pool;
    }
    throw new Error('POSTGRES_URL or DATABASE_URL environment variable is not set');
  }

  if (databaseUrl && postgresUrl && databaseUrl !== postgresUrl) {
    console.warn(
      `DATABASE_URL and POSTGRES_URL differ. Preferring DATABASE_URL. ` +
      `DATABASE_URL=${maskConnectionString(databaseUrl)} POSTGRES_URL=${maskConnectionString(postgresUrl)}`
    );
  }

  // Create a single connection pool instance
  pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
  
  return pool;
}

// Helper for executing queries
export async function query(text: string, params?: unknown[]) {
  const start = Date.now();
  try {
    const res = await getPool().query(text, params);
    const duration = Date.now() - start;
    if (process.env.NODE_ENV === 'development') {
      console.log('Executed query', { text, duration, rows: res.rowCount });
    }
    return res;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
}

// Initialize the users table
export async function initializeDatabase() {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) DEFAULT 'user',
      linkedin_email VARCHAR(255),
      linkedin_connected BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS linkedin_oauth_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      linkedin_sub VARCHAR(255) UNIQUE NOT NULL,
      access_token_encrypted TEXT NOT NULL,
      iv VARCHAR(255) NOT NULL,
      tag VARCHAR(255) NOT NULL,
      refresh_token_encrypted TEXT,
      refresh_iv VARCHAR(255),
      refresh_tag VARCHAR(255),
      scope TEXT NOT NULL,
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      refresh_token_expires_at TIMESTAMP WITH TIME ZONE,
      token_type VARCHAR(50) DEFAULT 'Bearer',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS linkedin_scheduled_posts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id VARCHAR(255) NOT NULL,
      content TEXT NOT NULL,
      title VARCHAR(255),
      target_url TEXT,
      visibility VARCHAR(50) DEFAULT 'PUBLIC',
      scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
      status VARCHAR(50) DEFAULT 'PENDING',
      linkedin_post_id VARCHAR(255),
      error_message TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;
  
  try {
    await query(createTableQuery);
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Failed to initialize database:', error);
  }
}

// Run initialization immediately on file load, but don't block
if (process.env.npm_lifecycle_event !== 'build') {
  initializeDatabase().catch(console.error);
}

export default getPool;
