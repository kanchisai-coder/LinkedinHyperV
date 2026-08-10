import { query } from '../db';
import { randomUUID } from 'crypto';

export interface User {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: 'admin' | 'user';
  linkedin_email?: string;
  linkedin_connected: boolean;
  created_at: Date;
  // Backward-compatible camelCase alias for consumers that expect createdAt.
  createdAt?: Date;
}

export type CreateUserDTO = Pick<User, 'name' | 'email' | 'password_hash'> & Partial<Pick<User, 'role'>>;

function mapUser(row: Record<string, unknown>): User {
  const user = row as unknown as User;
  const createdAt = user.created_at ? new Date(String(user.created_at)) : undefined;
  return {
    ...user,
    ...(createdAt ? { createdAt } : {}),
  };
}

export async function createUser(data: CreateUserDTO): Promise<User> {
  const id = randomUUID();
  const role = data.role || 'user';
  
  const text = `
    INSERT INTO users (id, name, email, password_hash, role)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `;
  
  const values = [id, data.name, data.email, data.password_hash, role];
  
  const res = await query(text, values);
  return mapUser(res.rows[0] as Record<string, unknown>);
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const text = 'SELECT * FROM users WHERE email = $1';
  const res = await query(text, [email]);
  
  if (res.rows.length === 0) return null;
  return mapUser(res.rows[0] as Record<string, unknown>);
}

export async function getUserById(id: string): Promise<User | null> {
  const text = 'SELECT * FROM users WHERE id = $1';
  const res = await query(text, [id]);
  
  if (res.rows.length === 0) return null;
  return mapUser(res.rows[0] as Record<string, unknown>);
}

export async function updateUserLinkedInStatus(
  id: string, 
  linkedin_email: string, 
  linkedin_connected: boolean
): Promise<User | null> {
  const text = `
    UPDATE users 
    SET linkedin_email = $1, linkedin_connected = $2
    WHERE id = $3
    RETURNING *
  `;
  
  const res = await query(text, [linkedin_email, linkedin_connected, id]);
  
  if (res.rows.length === 0) return null;
  return mapUser(res.rows[0] as Record<string, unknown>);
}

export async function getAllUsers(): Promise<Omit<User, 'password_hash'>[]> {
  // Omit password hash when asking for all users for admin panel
  const text = 'SELECT id, name, email, role, linkedin_email, linkedin_connected, created_at FROM users ORDER BY created_at DESC';
  const res = await query(text);
  return res.rows.map((row) => mapUser(row as Record<string, unknown>));
}
