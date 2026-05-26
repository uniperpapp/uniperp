import type { Config } from "tailwindcss";

export default {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "#0a0a0c",
        panel: "#13131a",
        border: "#23232e",
        text: "#e6e6ec",
        muted: "#7a7a85",
        accent: "#6ee7b7",      // mint green — brand / trade button / positive
        long: "#22c55e",         // distinct green for the "long" side label
        warn: "#fbbf24",         // amber for active band / warning
        danger: "#f87171",       // red for liquidatable / borrowed
        bandToken: "#3b82f640",  // blue tint for TOKEN-side bands
        bandEth: "#10b98140",    // green tint for ETH-side bands
        bandActive: "#fbbf2480", // amber for current
      },
      fontFamily: {
        mono: ["ui-monospace", "SF Mono", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
