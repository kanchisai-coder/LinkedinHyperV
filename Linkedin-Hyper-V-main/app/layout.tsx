import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/components/providers/AuthProvider";
import { WebSocketProvider } from "@/components/providers/WebSocketProvider";
import { Toaster } from "react-hot-toast";

export const metadata: Metadata = {
  title: "LinkedIn Hyper-V",
  description: "Self-hosted LinkedIn automation dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        className="font-body antialiased"
        style={{ background: "var(--bg-base)", color: "var(--text-primary)" }}
      >
        <AuthProvider>
          <WebSocketProvider>
            {children}
          </WebSocketProvider>
        </AuthProvider>
        <Toaster 
          position="top-right"
          toastOptions={{
            style: {
              background: 'var(--bg-panel)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
            },
          }}
        />
      </body>
    </html>
  );
}

