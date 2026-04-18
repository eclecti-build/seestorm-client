import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

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
    default: 'SeeStorm — Great Lakes Severe Weather',
    template: '%s — SeeStorm',
  },
  description:
    'Ad-free, real-time severe weather visualization for Great Lakes communities. Built on National Weather Service data.',
  openGraph: {
    title: 'SeeStorm — Great Lakes Severe Weather',
    description:
      'Ad-free, real-time severe weather visualization for Great Lakes communities. Built on National Weather Service data.',
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
      <body className="antialiased bg-gray-950">{children}</body>
    </html>
  );
}
