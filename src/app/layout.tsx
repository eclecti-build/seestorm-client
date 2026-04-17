import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'SeeStorm — Wisconsin Severe Weather',
  description:
    'Ad-free, real-time severe weather visualization for Wisconsin communities. Tornado warnings, radar, and storm tracking.',
  openGraph: {
    title: 'SeeStorm — Wisconsin Severe Weather',
    description: 'Ad-free, real-time severe weather visualization for Wisconsin communities.',
    type: 'website',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.className} antialiased bg-gray-950`}>{children}</body>
    </html>
  );
}
