import type { MetadataRoute } from 'next';

// Static export requires an explicit opt-in for metadata routes.
export const dynamic = 'force-static';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'SeeStorm',
    short_name: 'SeeStorm',
    description: 'Ad-free, real-time severe weather visualization for Great Lakes communities.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0A0F1A',
    theme_color: '#0A0F1A',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
      },
      {
        src: '/apple-icon.svg',
        sizes: '180x180',
        type: 'image/svg+xml',
      },
    ],
  };
}
