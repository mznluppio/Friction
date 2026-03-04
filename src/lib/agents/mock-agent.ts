import type {
  AgentPlan,
  AgentResponse,
  Complexity,
  Domain,
  LLMAgent,
  PlanPhase
} from "../types";

const domainHints: Record<Domain, string[]> = {
  auth: ["auth", "authentification", "login", "jwt", "session", "mot de passe", "password", "oauth", "2fa"],
  payment: ["paiement", "payment", "carte", "stripe", "checkout", "invoice", "facture", "idempotency"],
  notifications: ["notification", "email", "sms", "push", "webhook"],
  analytics: ["analytics", "dashboard", "metrique", "tracking", "temps reel", "real time", "event"],
  other: []
};

const defaultStacks: Record<Domain, string[]> = {
  auth: ["React", "Node.js", "PostgreSQL", "JWT"],
  payment: ["React", "Node.js", "Stripe", "PostgreSQL"],
  notifications: ["React", "Node.js", "Redis", "Worker queue"],
  analytics: ["React", "Node.js", "ClickHouse", "WebSocket"],
  other: ["React", "Node.js", "SQLite"]
};

export function inferDomain(requirement: string): Domain {
  const source = requirement.toLowerCase();
  for (const [domain, words] of Object.entries(domainHints) as [Domain, string[]][]) {
    if (words.some((word) => source.includes(word))) {
      return domain;
    }
  }
  return "other";
}

export function inferComplexity(requirement: string): Complexity {
  const source = requirement.toLowerCase();
  let score = 0;

  if (source.length > 280) score += 1;
  if (source.includes("multi") || source.includes("distributed")) score += 1;
  if (source.includes("temps réel") || source.includes("real time")) score += 1;
  if (source.includes("sécurité") || source.includes("security")) score += 1;
  if (source.includes("conform") || source.includes("gdpr")) score += 1;

  if (score >= 3) return "high";
  if (score >= 1) return "medium";
  return "low";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPhases(
  bias: LLMAgent["bias"],
  domain: Domain,
  clarifications: string
): PlanPhase[] {
  const hasConstraints = clarifications.trim().length > 10;

  if (bias === "architect") {
    return [
      {
        name: "Spécification exécutable",
        duration: "0.5j",
        tasks: [
          "Lister règles métier et cas limites",
          "Transformer ambiguïtés en critères d'acceptation",
          "Valider observabilité et sécurité attendues"
        ]
      },
      {
        name: "Architecture et contrats",
        duration: domain === "payment" ? "1j" : "0.75j",
        tasks: [
          "Définir interfaces backend/frontend",
          "Modéliser états d'échec et retries",
          "Écrire ADR pour les décisions critiques"
        ]
      },
      {
        name: "Delivery incrémentale",
        duration: hasConstraints ? "2j" : "1.5j",
        tasks: [
          "Implémenter vertical slice avec tests",
          "Ajouter protections (rate-limit, validation, logs)",
          "Préparer rollout progressif"
        ]
      }
    ];
  }

  return [
    {
      name: "MVP utilisable",
      duration: "0.5j",
      tasks: [
        "Coder le flux principal sans sur-couche",
        "Préparer seed data et composants UI",
        "Valider manuellement les happy paths"
      ]
    },
    {
      name: "Stabilisation",
      duration: "1j",
      tasks: [
        "Couvrir 3-4 edge cases critiques",
        "Ajouter erreurs utilisateurs claires",
        "Mesurer le temps de réponse"
      ]
    },
    {
      name: "Hardening ciblé",
      duration: "0.5j",
      tasks: [
        "Corriger bugs observés en test",
        "Documenter limites connues",
        "Préparer backlog v2"
      ]
    }
  ];
}

abstract class BaseMockAgent implements LLMAgent {
  constructor(public readonly name: string, public readonly bias: LLMAgent["bias"]) {}

  abstract analyzeRequirement(requirement: string): Promise<AgentResponse>;

  abstract buildPlan(requirement: string, clarifications: string): Promise<AgentPlan>;

  protected stackForDomain(domain: Domain, additions: string[] = []): string[] {
    return [...defaultStacks[domain], ...additions];
  }
}

export class MockArchitectAgent extends BaseMockAgent {
  constructor() {
    super("claude-sonnet-4", "architect");
  }

  async analyzeRequirement(requirement: string): Promise<AgentResponse> {
    await delay(520);
    const domain = inferDomain(requirement);

    return {
      interpretation:
        "Le besoin doit être traité comme une capacité produit durable, pas juste une feature ponctuelle. " +
        "Le requirement actuel décrit l'intention mais pas les frontières fonctionnelles ni les garanties attendues.",
      assumptions: [
        "Le système doit rester maintenable pour plusieurs itérations produit.",
        "Les événements d'échec doivent être observables et traçables.",
        `Le domaine principal est '${domain}' avec des contraintes non explicitées.`
      ],
      risks: [
        "Les exigences non précisées sur sécurité/conformité peuvent invalider l'implémentation.",
        "Sans stratégie de test adversarial, les cas limites apparaîtront en production."
      ],
      questions: [
        "Quels sont les critères d'acceptation non négociables (SLA, sécurité, conformité) ?",
        "Quel volume de trafic initial et quels scénarios de montée en charge faut-il absorber ?",
        "Que doit-on journaliser pour produire un ADR exploitable après chaque session ?"
      ],
      approach:
        "Je privilégie une architecture modulaire avec interfaces explicites entre collecte, comparaison et arbitrage humain. " +
        "Chaque décision majeure est convertie en artefact versionnable pour éviter les décisions silencieuses."
    };
  }

  async buildPlan(requirement: string, clarifications: string): Promise<AgentPlan> {
    await delay(640);
    const domain = inferDomain(requirement);

    return {
      stack: this.stackForDomain(domain, ["Tauri", "Rust commands", "SQLite"]),
      phases: buildPhases(this.bias, domain, clarifications),
      architecture:
        "Le frontend orchestre les phases, tandis que le backend Rust encapsule les providers LLM et les opérations Git. " +
        "Les sorties agents sont persistées en session structurée pour générer automatiquement un ADR exportable.",
      tradeoffs: [
        "Plus de structure upfront, mais un coût d'implémentation initial supérieur.",
        "Isolation stricte des agents = meilleure traçabilité, mais latence globale plus élevée."
      ],
      warnings: [
        "Sans standard de prompts versionné, les comparaisons inter-modèles deviennent bruitées.",
        "La phase 3 nécessite un sandbox Git robuste pour éviter les effets de bord sur la branche principale."
      ]
    };
  }
}

export class MockPragmatistAgent extends BaseMockAgent {
  constructor() {
    super("gpt-4o", "pragmatist");
  }

  async analyzeRequirement(requirement: string): Promise<AgentResponse> {
    await delay(460);
    const domain = inferDomain(requirement);

    return {
      interpretation:
        "Le but est d'obtenir rapidement un pipeline usable qui met en évidence les divergences importantes entre deux agents. " +
        "On peut livrer une première version sans traiter tous les cas extrêmes dès le départ.",
      assumptions: [
        "L'utilisateur accepte un scope MVP limité aux phases 1 et 2 pour commencer.",
        "Les providers LLM sont interchangeables via une interface commune simple.",
        `Le domaine majoritaire est '${domain}' avec priorité au time-to-value.`
      ],
      risks: [
        "Trop de sophistication UI peut ralentir la livraison du moteur de comparaison.",
        "Les prompts trop longs augmentent les coûts API et la variabilité des réponses."
      ],
      questions: [
        "Quel niveau de précision est suffisant pour considérer une divergence actionnable ?",
        "Faut-il stocker toutes les sessions localement par défaut ou proposer un mode éphémère ?"
      ],
      approach:
        "Je livre un flux linéaire: requirement -> analyse duale -> clarifications -> plans duals. " +
        "Puis j'ajoute la phase 3 quand les métriques d'utilité du MVP sont validées."
    };
  }

  async buildPlan(requirement: string, clarifications: string): Promise<AgentPlan> {
    await delay(560);
    const domain = inferDomain(requirement);

    return {
      stack: this.stackForDomain(domain, ["Tauri", "Tailwind", "shadcn-style UI"]),
      phases: buildPhases(this.bias, domain, clarifications),
      architecture:
        "Une application desktop unique, avec état de session côté client et commandes Rust pour les opérations sensibles. " +
        "On commence avec un provider mockable pour pouvoir tester tout le flow sans dépendre des APIs externes.",
      tradeoffs: [
        "MVP rapide mais moins de couverture sur les scénarios avancés.",
        "Réutilisation maximale de la démo v0.2 au lieu d'une refonte totale immédiate."
      ],
      warnings: [
        "Attention à la dérive de scope sur la phase 3 avant validation du core.",
        "Il faut verrouiller un format JSON stable pour préserver la compatibilité dataset."
      ]
    };
  }
}

export const mockArchitect = new MockArchitectAgent();
export const mockPragmatist = new MockPragmatistAgent();
