/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        neuralink: {
          bg: "#0a0a0a",
          accent: "#00ff9f",
          text: "#e0e0e0",
        },
      },
    },
  },
  plugins: [],
};
