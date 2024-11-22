import { Clause, Selector, Term } from "datalogia";

interface VariableNode {
  id: number;
  name: string;
  readBy: Set<string>;
  writtenBy: Set<string>;
}

interface RuleMetadata {
  variables: Set<string>;
  events: Set<string>;
}

class RuleAnalyzer {
  private ruleMetadata: Map<string, RuleMetadata> = new Map();

  private initRuleMetadata(ruleName: string) {
    if (!this.ruleMetadata.has(ruleName)) {
      this.ruleMetadata.set(ruleName, {
        variables: new Set(),
        events: new Set()
      });
    }
    return this.ruleMetadata.get(ruleName)!;
  }

  private isEventAttribute(attr: string): boolean {
    return attr.startsWith('~/on/');
  }

  private getEventName(attr: string): string {
    return attr.replace('~/on/', '');
  }

  private analyzeSelector(selector: Selector, ruleName: string) {
    const metadata = this.initRuleMetadata(ruleName);

    for (const [key, term] of Object.entries(selector)) {
      // Skip special variables
      if (key !== 'self' && key !== 'event') {
        metadata.variables.add(key);
      }
    }
  }

  private analyzeClause(clause: Clause, ruleName: string) {
    const metadata = this.initRuleMetadata(ruleName);

    if ('Case' in clause && Array.isArray(clause.Case)) {
      const [_, attribute, value] = clause.Case;

      if (typeof attribute === 'string') {
        if (this.isEventAttribute(attribute)) {
          metadata.events.add(this.getEventName(attribute));
        } else if (typeof value === 'object' && '?' in value) {
          // This is a variable binding in the clause
          const varName = Object.keys(value['?'])[0];
          if (varName !== 'self' && varName !== 'event') {
            metadata.variables.add(attribute);
          }
        }
      }
    } else if ('And' in clause && Array.isArray(clause.And)) {
      clause.And.forEach(c => this.analyzeClause(c, ruleName));
    } else if ('Or' in clause && Array.isArray(clause.Or)) {
      clause.Or.forEach(c => this.analyzeClause(c, ruleName));
    } else if ('Not' in clause) {
      this.analyzeClause(clause.Not, ruleName);
    }
  }

  analyzeRules(behavior: Record<string, { select: Selector, where: Clause[], update?: Function }>) {
    this.ruleMetadata.clear();

    for (const [ruleName, rule] of Object.entries(behavior)) {
      // Initialize metadata for this rule
      this.initRuleMetadata(ruleName);

      // Analyze selector for variables
      this.analyzeSelector(rule.select, ruleName);

      // Analyze where clauses for both variables and events
      for (const clause of rule.where || []) {
        this.analyzeClause(clause, ruleName);
      }
    }

    return this.generateMermaidDiagram();
  }

  private generateMermaidDiagram(): string {
    let diagram = 'erDiagram\n';

    // Generate entities
    this.ruleMetadata.forEach((metadata, ruleName) => {
      diagram += `    ${ruleName} {\n`;

      // Add events
      metadata.events.forEach(event => {
        diagram += `        event ${event}\n`;
      });

      // Add variables
      metadata.variables.forEach(variable => {
        diagram += `        var ${variable}\n`;
      });

      diagram += `    }\n`;
    });

    // Generate relationships for shared variables
    const processedVarPairs = new Set<string>();
    this.ruleMetadata.forEach((metadata1, rule1) => {
      this.ruleMetadata.forEach((metadata2, rule2) => {
        if (rule1 < rule2) {
          // Find shared variables
          const sharedVars = new Set(
            [...metadata1.variables].filter(x => metadata2.variables.has(x))
          );

          sharedVars.forEach(variable => {
            const pairKey = `${rule1}-${rule2}-${variable}`;
            if (!processedVarPairs.has(pairKey)) {
              diagram += `    ${rule1} ||--|| ${rule2} : ${variable}\n`;
              processedVarPairs.add(pairKey);
            }
          });
        }
      });
    });

    // Generate relationships for shared events
    const processedEventPairs = new Set<string>();
    this.ruleMetadata.forEach((metadata1, rule1) => {
      this.ruleMetadata.forEach((metadata2, rule2) => {
        if (rule1 < rule2) {
          // Find shared events
          const sharedEvents = new Set(
            [...metadata1.events].filter(x => metadata2.events.has(x))
          );

          sharedEvents.forEach(event => {
            const pairKey = `${rule1}-${rule2}-${event}`;
            if (!processedEventPairs.has(pairKey)) {
              diagram += `    ${rule1} }o--o{ ${rule2} : ${event}\n`;
              processedEventPairs.add(pairKey);
            }
          });
        }
      });
    });

    return diagram;
  }
}

export const analyzeRuleDependencies = (behavior: Record<string, any>): string => {
  const analyzer = new RuleAnalyzer();
  return analyzer.analyzeRules(behavior);
};
