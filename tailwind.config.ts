import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        friction: {
          bg: "var(--friction-bg)",
          surface: "var(--friction-surface)",
          surfaceAlt: "var(--friction-surface-alt)",
          "surface-alt": "var(--friction-surface-alt)",
          sidebar: "var(--friction-sidebar)",
          border: "var(--friction-border)",
          text: "var(--friction-text)",
          muted: "var(--friction-muted)",
          accent: "var(--friction-accent)",
          accentSoft: "var(--friction-accent-soft)",
          accentText: "var(--friction-accent-text)",
          "accent-soft": "var(--friction-accent-soft)",
          "accent-text": "var(--friction-accent-text)",
          successSoft: "var(--friction-success-soft)",
          successText: "var(--friction-success-text)",
          "success-soft": "var(--friction-success-soft)",
          "success-text": "var(--friction-success-text)",
          warningSoft: "var(--friction-warning-soft)",
          warningText: "var(--friction-warning-text)",
          "warning-soft": "var(--friction-warning-soft)",
          "warning-text": "var(--friction-warning-text)",
          dangerSoft: "var(--friction-danger-soft)",
          dangerText: "var(--friction-danger-text)",
          "danger-soft": "var(--friction-danger-soft)",
          "danger-text": "var(--friction-danger-text)",
          danger: "var(--friction-danger)"
        }
      },
      fontFamily: {
        display: ["'Space Grotesk'", "'IBM Plex Sans'", "sans-serif"],
        mono: ["'JetBrains Mono'", "monospace"]
      }
    }
  },
  plugins: []
} satisfies Config;
