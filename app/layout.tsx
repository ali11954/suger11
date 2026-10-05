import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
export const metadata: Metadata = { title: 'External Procurement Intelligence', description: 'Single dashboard for sugar procurement market intelligence' };
export default function RootLayout({children}:{children:ReactNode}) { return <html lang="ar" dir="rtl"><body>{children}</body></html>; }
