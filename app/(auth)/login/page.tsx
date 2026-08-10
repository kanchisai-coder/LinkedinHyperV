'use client';

import { useState } from 'react';
import { useAuth } from '@/components/providers/AuthProvider';
import { motion } from 'framer-motion';
import { AlertCircle, Eye, EyeOff, Loader2, LockKeyhole } from 'lucide-react';

export default function LoginPage() {
  const { login } = useAuth();
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      await login(password, rememberMe);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md">
      <div className="app-surface-strong app-gradient-border p-6 sm:p-8">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent)] text-xl font-bold text-white shadow-[0_12px_24px_rgba(10,102,194,0.18)]">
            LI
          </div>
          <div className="min-w-0">
            <div className="text-xl font-bold text-[var(--text-primary)]">LinkedIn Data Console</div>
            <div className="text-sm text-[var(--text-muted)]">Secure access to your LinkedIn mirror</div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-semibold text-[var(--text-secondary)]">Password</label>
            <div className="relative">
              <LockKeyhole size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="app-input h-11 pl-10 pr-10 text-sm"
                style={{ borderColor: error ? 'var(--danger)' : 'var(--border)' }}
                placeholder="Enter dashboard password"
                disabled={isLoading}
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            {error && (
              <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-2 flex items-center gap-2 text-sm text-[var(--danger)]">
                <AlertCircle size={15} />
                {error}
              </motion.p>
            )}
          </div>

          <label className="flex select-none items-center gap-2 text-sm text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              disabled={isLoading}
              className="h-4 w-4 rounded border-[var(--border)] accent-[var(--accent)]"
            />
            <span>Remember me</span>
          </label>

          <button type="submit" disabled={isLoading || !password} className="app-button app-button-primary h-11 w-full text-sm disabled:opacity-50">
            {isLoading ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 size={18} className="animate-spin" />
                Signing in
              </span>
            ) : (
              'Sign in'
            )}
          </button>
        </form>
      </div>
    </motion.div>
  );
}
