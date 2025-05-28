/** @type {import('next').NextConfig} */
const nextConfig = {
  // Environment variables for API connection
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'https://voice-browser-frontend-production.up.railway.app',
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL || 'wss://voice-browser-frontend-production.up.railway.app'
  },
  
  // Allow external images and resources
  images: {
    domains: ['localhost'],
    unoptimized: true
  }
}

module.exports = nextConfig 