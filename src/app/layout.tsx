import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import StalenessBanner from '@/components/StalenessBanner';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://seestorm.org'),
  applicationName: 'SeeStorm',
  title: {
    default: 'SeeStorm — US Severe Weather',
    template: '%s — SeeStorm',
  },
  description:
    'Ad-free, real-time severe weather visualization for communities across the United States. Built on National Weather Service data.',
  openGraph: {
    title: 'SeeStorm — US Severe Weather',
    description:
      'Ad-free, real-time severe weather visualization for communities across the United States. Built on National Weather Service data.',
    siteName: 'SeeStorm',
    locale: 'en_US',
    type: 'website',
  },
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  themeColor: '#0A0F1A',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="antialiased bg-gray-950">
        {/* Binary staleness indicator — red banner when server-time delta
            exceeds STALENESS_CRITICAL_MS. Mounted here so it covers every
            route (map, about, etc). Renders nothing when FRESH; there is
            intentionally no middle tier (Open Decisions #11). */}
        <StalenessBanner />
        {children}
      </body>
    </html>
  );
}
