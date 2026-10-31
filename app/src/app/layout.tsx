import type { Metadata, Viewport } from 'next';
import { hasSession } from '@/server/auth/session';
import { loadSettings } from '@/server/queries';
import './globals.css';

// Third-party font files are not redistributed with this package. If a deployment places a
// self-hosted Pretendard (OFL) stylesheet at public/fonts/pretendard.css it is used; otherwise the
// system font stack in globals.css applies.

export const metadata: Metadata = {
  title: { default: 'Review Workflow', template: '%s · Review Workflow' },
  description: '리뷰 일정 관리',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F8F8F8' },
    { media: '(prefers-color-scheme: dark)', color: '#121212' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = (await hasSession()) ? (await loadSettings()).theme : 'system';
  const themeClass = theme === 'system' ? '' : theme;
  return (
    <html lang="ko" className={themeClass || undefined}>
      <head>
        {/* eslint-disable-next-line @next/next/no-css-tags */}
        <link rel="stylesheet" href="/fonts/pretendard.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
