// Vitest configuration — kept separate from vite.config.js so unit tests
// don't load the production build pipeline (Tailwind/PostCSS/React plugins).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.{js,jsx}'],
  },
  // Inline an empty PostCSS config so vitest doesn't try to load the project's
  // postcss.config.js (which requires tailwindcss and isn't needed for unit tests).
  css: {
    postcss: { plugins: [] },
  },
});
