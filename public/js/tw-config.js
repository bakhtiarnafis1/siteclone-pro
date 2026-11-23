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
        // brand teal
        accent: { DEFAULT: '#5b5bd6', soft: '#a5b4fc', deep: '#4646c4' },
        brand: { 50: '#f6f6ff', 100: '#e5e7ff', 200: '#c7cbfd', 500: '#6c6ae0', 600: '#5b5bd6', 700: '#4646c4', 800: '#3a379a', 900: '#2c2a75', 950: '#1c1b47' },
        mint: '#4ade80',
        body: '#a1a6ad',
        dim: '#6d727a',
      },
      boxShadow: {
        soft: '0 16px 44px rgba(28, 27, 71, 0.07)',
        lift: '0 24px 60px -20px rgba(28, 27, 71, 0.25)',
        brand: '0 8px 22px -6px rgba(91, 91, 214, 0.45)',
      },
    },
  },
};
