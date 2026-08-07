// FILE: app/(auth)/layout.tsx
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-base)] p-4">
      {children}
    </div>
  );
}
