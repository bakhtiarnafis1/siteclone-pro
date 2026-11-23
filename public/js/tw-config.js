// Shared Tailwind (CDN) theme — load right after https://cdn.tailwindcss.com
tailwind.config = {
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        ink: { 950: '#05060b', 900: '#0a0c16', 800: '#10142a', 700: '#1a2040' },
        accent: { DEFAULT: '#2f5bff', soft: '#7c97ff' },
        mint: '#9befc9',
        body: '#a4aabd',
        dim: '#6b7187',
      },
    },
  },
};
