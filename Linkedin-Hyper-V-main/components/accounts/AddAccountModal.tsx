// FILE: components/accounts/AddAccountModal.tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs';
import { CookieInstructions } from './CookieInstructions';
import { validateLinkedInCookies } from '@/lib/validators/cookie-validator';
import { Loader2, Check, X, Upload, FileText } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';

interface AddAccountModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  existingAccounts: string[];
  initialAccountId?: string | null;
}

export function AddAccountModal({ open, onClose, onSuccess, existingAccounts, initialAccountId = null }: AddAccountModalProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [accountId, setAccountId] = useState('');
  const [cookiesJson, setCookiesJson] = useState('');
  const [validation, setValidation] = useState<ReturnType<typeof validateLinkedInCookies> | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationResult, setVerificationResult] = useState<'success' | 'error' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    if (initialAccountId) {
      setAccountId(initialAccountId);
      setStep(2);
      return;
    }
    setStep(1);
    setAccountId('');
  }, [open, initialAccountId]);

  const handleClose = () => {
    setStep(1);
    setAccountId('');
    setCookiesJson('');
    setValidation(null);
    setVerificationResult(null);
    onClose();
  };

  const handleStep1Next = () => {
    if (!accountId.trim()) {
      toast.error('Please enter an account ID');
      return;
    }
    if (!/^[a-z0-9_-]+$/i.test(accountId)) {
      toast.error('Account ID can only contain letters, numbers, hyphens, and underscores');
      return;
    }
    setStep(2);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      setCookiesJson(content);
      validateCookies(content);
    };
    reader.readAsText(file);
  };

  const validateCookies = (json: string) => {
    try {
      const parsed = JSON.parse(json);
      const result = validateLinkedInCookies(parsed);
      setValidation(result);
    } catch {
      setValidation({
        isValid: false,
        hasLiAt: false,
        hasJSessionId: false,
        errors: ['Invalid JSON format'],
        warnings: [],
      });
    }
  };

  const handleStep2Next = async () => {
    if (!accountId.trim()) {
      toast.error('Please enter an account ID');
      setStep(1);
      return;
    }

    if (!validation?.isValid) {
      toast.error('Please fix cookie validation errors');
      return;
    }

    setIsImporting(true);
    try {
      const cookies = JSON.parse(cookiesJson);
      const res = await fetch(`/api/accounts/${accountId}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cookies),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || 'Failed to import cookies');
        setIsImporting(false);
        return;
      }

      toast.success('Cookies imported successfully');
      onSuccess();
      setStep(3);
      // Auto-start verification
      handleVerify();
    } catch {
      toast.error('Network error during import');
      setIsImporting(false);
    }
  };

  const handleVerify = async () => {
    setIsVerifying(true);
    try {
      const res = await fetch(`/api/accounts/${accountId}/verify`, {
        method: 'POST',
      });

      if (res.ok) {
        setVerificationResult('success');
        toast.success('Session verified successfully!');
      } else {
        const data = await res.json();
        setVerificationResult('error');
        toast.error(data.error || 'Verification failed');
      }
    } catch {
      setVerificationResult('error');
      toast.error('Network error during verification');
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogTitle>Import LinkedIn Session</DialogTitle>
        <DialogDescription>
          Bring an existing LinkedIn browser session into the data console with a clean import and verification flow.
        </DialogDescription>

        {/* Step Indicator */}
        <div className="flex items-center gap-2 mb-6">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex items-center flex-1">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-all ${
                  step >= s ? 'ring-2 ring-[var(--accent)]' : ''
                }`}
                style={{
                  background: step >= s ? 'var(--accent)' : 'var(--bg-elevated)',
                  color: step >= s ? 'white' : 'var(--text-muted)',
                }}
              >
                {s}
              </div>
              {s < 3 && (
                <div
                  className="flex-1 h-0.5 mx-2"
                  style={{ background: step > s ? 'var(--accent)' : 'var(--border)' }}
                />
              )}
            </div>
          ))}
        </div>

        <AnimatePresence mode="wait">
          {/* Step 1: Account ID */}
          {step === 1 && (
            <motion.div
              key="step1"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
            >
              <div className="space-y-4">
                <div>
                  <label className="mb-2 block text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                    Account ID
                  </label>
                  <input
                    type="text"
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                    placeholder="e.g., alice, bob, my_account"
                    className="app-input h-11"
                    autoFocus
                  />
                  <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                    Choose a unique identifier for this account (letters, numbers, hyphens, underscores)
                  </p>
                </div>

                {existingAccounts.length > 0 && (
                  <div
                    className="p-3 rounded-lg"
                    style={{ background: 'var(--bg-elevated)' }}
                  >
                    <p className="text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                      Existing accounts:
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {existingAccounts.map((id) => (
                        <span key={id} className="rounded-full bg-[var(--bg-panel)] px-2.5 py-1 text-xs text-[var(--text-muted)]">
                          {id}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <Button onClick={handleStep1Next} disabled={!accountId.trim()} className="w-full">
                  Next
                </Button>
              </div>
            </motion.div>
          )}

          {/* Step 2: Cookie Import */}
          {step === 2 && (
            <motion.div
              key="step2"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
            >
              <Tabs defaultValue="paste">
                <TabsList>
                  <TabsTrigger value="paste">
                    <FileText size={14} className="mr-1" /> Paste JSON
                  </TabsTrigger>
                  <TabsTrigger value="upload">
                    <Upload size={14} className="mr-1" /> Upload File
                  </TabsTrigger>
                  <TabsTrigger value="instructions">Instructions</TabsTrigger>
                </TabsList>

                <TabsContent value="paste">
                  <div className="space-y-4">
                    <div
                      className="rounded-xl border px-3 py-2 text-sm"
                      style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
                    >
                      Importing for account: <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{accountId || '(not set)'}</span>
                    </div>
                    <textarea
                      value={cookiesJson}
                      onChange={(e) => {
                        setCookiesJson(e.target.value);
                        validateCookies(e.target.value);
                      }}
                      placeholder='Paste cookie JSON array here...\n[\n  {"name": "li_at", "value": "...", ...}\n]'
                      className="app-input h-64 resize-none px-4 py-3 font-mono text-sm"
                    />

                    {validation && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          {validation.hasLiAt ? (
                            <Check size={16} className="text-green-500" />
                          ) : (
                            <X size={16} style={{ color: 'var(--color-error-500)' }} />
                          )}
                          <span className="text-sm" style={{ color: validation.hasLiAt ? '#22c55e' : '#ef4444' }}>
                            li_at cookie
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          {validation.hasJSessionId ? (
                            <Check size={16} className="text-green-500" />
                          ) : (
                            <X size={16} style={{ color: 'var(--color-error-500)' }} />
                          )}
                          <span className="text-sm" style={{ color: validation.hasJSessionId ? '#22c55e' : '#ef4444' }}>
                            JSESSIONID cookie
                          </span>
                        </div>
                        
                        {validation.errors.length > 0 && (
                          <div className="rounded-xl p-3" style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid #ef4444' }}>
                            {validation.errors.map((err, i) => (
                              <p key={i} className="text-sm" style={{ color: 'var(--color-error-500)' }}>{err}</p>
                            ))}
                          </div>
                        )}
                        
                        {validation.warnings.length > 0 && (
                          <div className="rounded-xl p-3" style={{ background: 'rgba(245, 158, 11, 0.1)', border: '1px solid #f59e0b' }}>
                            {validation.warnings.map((warn, i) => (
                              <p key={i} className="text-sm" style={{ color: 'var(--color-warning-500)' }}>{warn}</p>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="upload">
                  <div className="space-y-4">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".json"
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full rounded-2xl border-2 border-dashed py-12 transition-all hover:border-opacity-50"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <Upload size={32} className="mx-auto mb-2" style={{ color: 'var(--text-muted)' }} />
                      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        Click to upload cookies.json file
                      </p>
                    </button>
                  </div>
                </TabsContent>

                <TabsContent value="instructions">
                  <CookieInstructions />
                </TabsContent>
              </Tabs>

              <div className="mt-6 flex gap-2">
                <Button onClick={() => setStep(1)} variant="ghost">
                  Back
                </Button>
                <Button
                  onClick={handleStep2Next}
                  disabled={!validation?.isValid || isImporting}
                  className="flex-1"
                >
                  {isImporting ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 size={16} className="animate-spin" />
                      Importing...
                    </span>
                  ) : (
                    'Import & Verify'
                  )}
                </Button>
              </div>
            </motion.div>
          )}

          {/* Step 3: Verification */}
          {step === 3 && (
            <motion.div
              key="step3"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="text-center py-8"
            >
              {isVerifying && (
                <div>
                  <Loader2 size={48} className="animate-spin mx-auto mb-4" style={{ color: 'var(--accent)' }} />
                  <p className="text-lg font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                    Verifying session...
                  </p>
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                    This may take 10-30 seconds while we launch a browser and navigate to LinkedIn.
                  </p>
                </div>
              )}

              {!isVerifying && verificationResult === 'success' && (
                <div>
                  <div
                    className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
                    style={{ background: 'rgba(34, 197, 94, 0.1)' }}
                  >
                    <Check size={32} className="text-green-500" />
                  </div>
                  <p className="text-lg font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                    Session Active!
                  </p>
                  <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
                    Account {accountId} has been successfully added and verified.
                  </p>
                    <Button
                      onClick={() => {
                        onSuccess();
                        handleClose();
                      }}
                    >
                      Done
                    </Button>
                </div>
              )}

              {!isVerifying && verificationResult === 'error' && (
                <div>
                  <div
                    className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
                    style={{ background: 'rgba(239, 68, 68, 0.1)' }}
                  >
                    <X size={32} style={{ color: 'var(--color-error-500)' }} />
                  </div>
                  <p className="text-lg font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                    Verification Failed
                  </p>
                  <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
                    The session could not be verified. The cookies may be expired or invalid.
                  </p>
                  <div className="flex gap-2 justify-center">
                    <Button
                      onClick={handleVerify}
                      variant="ghost"
                    >
                      Retry
                    </Button>
                    <Button
                      onClick={handleClose}
                    >
                      Close
                    </Button>
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
