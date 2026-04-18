/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: { 900: '#040405', 800: '#0a0a0c', 700: '#111114', 600: '#18181c' },
        accent: { DEFAULT: '#7c5bf0', hover: '#6a4bd6', dim: '#4a3a80' },
        surface: { DEFAULT: '#0e0e12', light: '#17171d', border: '#222228' },
      },
    },
  },
  plugins: [],
}
