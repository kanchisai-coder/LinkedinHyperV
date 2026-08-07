'use client';

import { useState } from 'react';
import { Download, FileJson, FileSpreadsheet, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { cn } from '@/lib/utils';

interface ExportButtonProps {
  type: 'messages' | 'activity';
  accountId?: string;
  conversationId?: string;
  chatId?: string;
  label?: string;
  variant?: 'default' | 'outline' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
}

export function ExportButton({
  type,
  accountId,
  conversationId,
  chatId,
  label = 'Export',
  variant = 'outline',
  size = 'md',
}: ExportButtonProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [showMenu, setShowMenu] = useState(false);

  async function handleExport(format: 'csv' | 'json') {
    setIsExporting(true);
    setShowMenu(false);

    try {
      const response = await fetch(`/api/export/${type}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId,
          conversationId: conversationId || chatId,
          format,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Export failed');
      }

      const contentDisposition = response.headers.get('Content-Disposition');
      let filename = `linkedin-${type}-${new Date().toISOString().split('T')[0]}.${format}`;

      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="?(.+)"?/i);
        if (filenameMatch) filename = filenameMatch[1];
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(`Exported ${format.toUpperCase()}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Export failed. Please try again.');
    } finally {
      setIsExporting(false);
    }
  }

  const sizes = {
    sm: 'h-8 px-3 text-xs',
    md: 'h-10 px-4 text-sm',
    lg: 'h-11 px-5 text-sm',
  };

  const variants = {
    default: 'app-button-primary',
    outline: 'app-button-secondary',
    ghost: 'app-button-ghost',
  };

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu((open) => !open)}
        disabled={isExporting}
        className={cn('app-button disabled:opacity-60', sizes[size], variants[variant])}
      >
        {isExporting ? (
          <Loader2 size={size === 'lg' ? 18 : 15} className="animate-spin" />
        ) : (
          <Download size={size === 'lg' ? 18 : 15} />
        )}
        <span>{isExporting ? 'Exporting' : label}</span>
      </button>

      {showMenu && !isExporting && (
        <>
          <button className="fixed inset-0 z-20 cursor-default" aria-label="Close export menu" onClick={() => setShowMenu(false)} />
          <div className="absolute right-0 z-30 mt-2 w-48 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-panel)] py-1 shadow-md">
            <button
              onClick={() => void handleExport('csv')}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
            >
              <FileSpreadsheet size={16} className="text-[var(--success)]" />
              Export as CSV
            </button>
            <button
              onClick={() => void handleExport('json')}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
            >
              <FileJson size={16} className="text-[var(--accent)]" />
              Export as JSON
            </button>
          </div>
        </>
      )}
    </div>
  );
}
