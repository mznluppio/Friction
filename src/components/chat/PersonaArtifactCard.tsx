import { useTheme } from "@/components/ThemeProvider";
import { MarkdownText } from "@/components/ai-elements/markdown";
import type { PersonaArtifactEvent } from "@/lib/types";
import { Cpu } from "lucide-react";

interface PersonaArtifactCardProps {
    personas: PersonaArtifactEvent[];
}

export function PersonaArtifactCard({ personas }: PersonaArtifactCardProps) {
    const { theme } = useTheme();

    if (!personas || personas.length === 0) return null;

    return (
        <div className={`persona-artifact-container ${theme === "dark" ? "is-dark" : ""}`}>
            {personas.map((persona, idx) => (
                <div
                    key={`${persona.requestId}-${persona.agentId}-${idx}`}
                    className="persona-artifact-card"
                    style={{
                        marginBottom: idx < personas.length - 1 ? '12px' : 0,
                        border: theme === "dark" ? '1px solid #333' : '1px solid #e2e8f0',
                        borderRadius: '8px',
                        background: theme === "dark" ? '#1e1e1e' : '#f8fafc',
                        overflow: 'hidden'
                    }}
                >
                    <div
                        className="persona-artifact-header"
                        style={{
                            padding: '12px 16px',
                            borderBottom: theme === "dark" ? '1px solid #333' : '1px solid #e2e8f0',
                            background: theme === "dark" ? '#262626' : '#f1f5f9',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px'
                        }}
                    >
                        <Cpu className="h-4 w-4" style={{ color: theme === "dark" ? '#a3a3a3' : '#64748b' }} />
                        <span style={{ fontSize: '13px', fontWeight: 600, color: theme === "dark" ? '#e5e5e5' : '#334155' }}>
                            Skill Injected: {persona.agentLabel}
                        </span>
                    </div>
                    <div
                        className="persona-artifact-content"
                        style={{
                            padding: '16px',
                            fontSize: '13px',
                            color: theme === "dark" ? '#d4d4d4' : '#475569'
                        }}
                    >
                        <MarkdownText text={persona.personaContent} />
                    </div>
                </div>
            ))}
        </div>
    );
}
