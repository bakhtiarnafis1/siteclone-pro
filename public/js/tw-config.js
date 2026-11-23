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
        accent: { DEFAULT: '#0e7f95', soft: '#5cc9dd', deep: '#0a6577' },
        brand: { 50: '#effbfd', 100: '#d3f2f7', 200: '#a9e4ee', 500: '#1593ab', 600: '#0e7f95', 700: '#0a6577', 800: '#0b5260', 900: '#0c3f4a', 950: '#06262e' },
        mint: '#4ade80',
        body: '#a1a6ad',
        dim: '#6d727a',
      },
      boxShadow: {
        soft: '0 16px 44px rgba(6, 38, 46, 0.07)',
        lift: '0 24px 60px -20px rgba(6, 38, 46, 0.25)',
        brand: '0 8px 22px -6px rgba(14, 127, 149, 0.45)',
      },
    },
  },
};
