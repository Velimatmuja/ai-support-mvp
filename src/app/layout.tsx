import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'SupportBot',
  description: 'AI customer support for small businesses.',
};

export const viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
