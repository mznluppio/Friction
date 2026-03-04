import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "light" | "dark";

interface ThemeContextValue {
    theme: Theme;
    setTheme: (t: Theme) => void;
    toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
    theme: "light",
    setTheme: () => { },
    toggle: () => { },
});

function getInitialTheme(): Theme {
    try {
        const stored = localStorage.getItem("friction.theme");
        if (stored === "dark" || stored === "light") return stored;
        if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) return "dark";
    } catch {
        // localStorage unavailable
    }
    return "light";
}

function applyTheme(t: Theme) {
    document.documentElement.setAttribute("data-theme", t);
    // Also toggle .dark class so Tailwind dark: utilities work (e.g. dark:invert on provider logos)
    if (t === "dark") {
        document.documentElement.classList.add("dark");
    } else {
        document.documentElement.classList.remove("dark");
    }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [theme, setThemeState] = useState<Theme>(getInitialTheme);

    const setTheme = (t: Theme) => {
        setThemeState(t);
        try {
            localStorage.setItem("friction.theme", t);
        } catch { /* ignore */ }
        applyTheme(t);
    };

    const toggle = () => setTheme(theme === "dark" ? "light" : "dark");

    useEffect(() => {
        applyTheme(theme);
    }, [theme]);

    return (
        <ThemeContext.Provider value={{ theme, setTheme, toggle }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    return useContext(ThemeContext);
}

export function ThemeToggle({ className }: { className?: string }) {
    const { theme, toggle } = useTheme();
    return (
        <button
            type="button"
            onClick={toggle}
            className={["theme-toggle", className].filter(Boolean).join(" ")}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Light mode" : "Dark mode"}
        >
            {theme === "dark" ? (
                <Sun className="size-4" />
            ) : (
                <Moon className="size-4" />
            )}
        </button>
    );
}
