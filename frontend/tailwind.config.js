/** @type {import('tailwindcss').Config} */
export default {
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
      keyframes: {
        "bci-pulse": {
          "0%, 100%": { opacity: "0.45" },
          "50%": { opacity: "1" },
        },
        "bci-glow": {
          "0%, 100%": { boxShadow: "0 0 20px -8px rgba(0, 255, 159, 0.35)" },
          "50%": { boxShadow: "0 0 32px -4px rgba(0, 255, 159, 0.55)" },
        },
        "bci-caret": {
          "0%, 45%": { opacity: "1" },
          "50%, 100%": { opacity: "0" },
        },
      },
      animation: {
        "bci-pulse": "bci-pulse 1.8s ease-in-out infinite",
        "bci-glow": "bci-glow 3s ease-in-out infinite",
        "bci-caret": "bci-caret 1s step-end infinite",
      },
    },
  },
  plugins: [],
};