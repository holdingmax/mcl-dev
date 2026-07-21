/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        mcl: {
          blue: '#1e3a5f',
          red: '#c8102e',
        },
      },
    },
  },
  plugins: [],
}
