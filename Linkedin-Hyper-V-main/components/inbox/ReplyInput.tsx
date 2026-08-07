'use client';

import { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';

interface ReplyInputProps {
  onSend: (text: string) => Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
}

export function ReplyInput({ onSend, disabled = false, disabledReason }: ReplyInputProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = '0px';
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 144)}px`;
  }, [text]);

  async function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    const previousText = text;
    setSending(true);
    setText('');
    try {
      await onSend(trimmed);
      textareaRef.current?.focus();
    } catch (error) {
      setText(previousText);
      throw error;
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }

  const canSend = Boolean(text.trim()) && !sending && !disabled;

  return (
    <div className="border-t border-[var(--border)] bg-[var(--bg-panel)] p-3 sm:p-4">
      <div className="flex items-end gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-subtle)] p-2 focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_rgba(10,102,194,0.14)]">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Write a message"
          disabled={disabled || sending}
          rows={1}
          className="max-h-36 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-relaxed text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)]"
        />
        <button
          onClick={() => void handleSend()}
          disabled={!canSend}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)] text-white transition-colors hover:bg-[var(--accent-hover)] disabled:bg-[var(--bg-panel)] disabled:text-[var(--text-faint)]"
          aria-label="Send message"
        >
          <Send size={16} />
        </button>
      </div>
      <p className="mt-2 hidden text-xs text-[var(--text-muted)] sm:block">
        {disabled ? (disabledReason || 'Resolve this thread before sending a message.') : 'Press Enter to send. Shift+Enter adds a line break.'}
      </p>
    </div>
  );
}
