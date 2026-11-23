// Shared Tailwind (CDN) theme — load right after https://cdn.tailwindcss.com
// Brand: deep teal on graphite (dashboard) / on white (public pages).
tailwind.config = {
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Geist', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        // dashboard surfaces (graphite)
        ink: { 950: '#0f1012', 900: '#16171a', 800: '#1c1e21', 700: '#26292d', 600: '#33373c' },
        // brand colour #01a3a4
        accent: { DEFAULT: '#01a3a4', soft: '#5fd6d7', deep: '#018a8b' },
        brand: { 50: '#f0fbfb', 100: '#d0f3f3', 200: '#a3e6e6', 500: '#14b5b6', 600: '#01a3a4', 700: '#018a8b', 800: '#036c6d', 900: '#0a5354', 950: '#053536' },
        mint: '#4ade80',
        body: '#a1a6ad',
        dim: '#6d727a',
      },
      boxShadow: {
        soft: '0 16px 44px rgba(5, 53, 54, 0.07)',
        lift: '0 24px 60px -20px rgba(5, 53, 54, 0.25)',
        brand: '0 8px 22px -6px rgba(1, 163, 164, 0.45)',
      },
    },
  },
};
