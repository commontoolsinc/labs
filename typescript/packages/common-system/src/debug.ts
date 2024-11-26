import { Clause, Entity, Query, Selector, Variable } from "datalogia";
import { LLMClient } from '@commontools/llm-client'

export const LLM_SERVER_URL =
  typeof window !== "undefined"
    ? window.location.protocol + "//" + window.location.host + "/api/llm"
    : "//api/llm";
export const makeClient = (url?: string) =>
  new LLMClient(url || LLM_SERVER_URL);

export async function explainQuery(query: any) {
  const systemPrompt = `
    use this query metadata and generated explanation to produce a single sentence description of what would TRIGGER the query at the application level, from the perspective of an application developer with limited understanding of datalog

    when referencing an identifier from the query surround it in backticks (standard markdown)
    include a 1-3 emoji sequence to describe the change (at the domain level)
  `
  return await makeClient().sendRequest({ messages: [
    { role: 'user', content: JSON.stringify(query) },
  ], system: systemPrompt, model: 'claude-3-5-sonnet' })
}

export async function explainMutation(mutation: any) {
  const systemPrompt = `
    here is a datalog query in JSON form along with the data that matched the query and any changes produced in response to it. we are working in a graph database where all identifiers are merkle-references.

    include a 1-3 emoji sequence to describe the change (at the domain level)
  `
  return await makeClient().sendRequest({ messages: [
    { role: 'user', content:`${JSON.stringify(mutation)}

    explain in a single sentence why this change was triggered and what happened in response, talk at the level of expected application behaviours.`},
  ], system: systemPrompt, model: 'claude-3-5-sonnet' })
}

interface Colors {
  vars: string[];
  attribute: string;
  self: string;
  string: string;
  number: string;
}

interface FormattedResult {
  text: string;
  styles: string[];
}
const COLORS: Colors = {
  vars: [
    '#3B82F6', // blue-500
    '#A855F7', // purple-500
    '#22C55E', // green-500
    '#F43F5E', // rose-500
    '#F59E0B'  // amber-500
  ],
  attribute: '#0D9488', // teal-600
  self: '#0F766E',     // teal-700
  string: '#16A34A',   // green-600
  number: '#2563EB',   // blue-600
};

const numberToLetters = (num: number): string => {
  if (num <= 0) return '';
  let letters = '';
  num = num - 1;
  while (num >= 0) {
    letters = String.fromCharCode(65 + (num % 26)) + letters;
    num = Math.floor(num / 26) - 1;
  }
  return letters;
};

const getVarColor = (id: number): string => COLORS.vars[id % COLORS.vars.length];

const styleVar = (varObj: Variable): [string, string] => {
  const id = varObj['?'].id;
  return [`%c$${numberToLetters(id)}`, `color: ${getVarColor(id)}; font-weight: 500`];
};

const styleAttribute = (attr: string): [string, string] => {
  const color = attr === 'self' ? COLORS.self : COLORS.attribute;
  return [`%c${attr}`, `color: ${color}`];
};

const formatValue = (value: any): [string, string] => {
  if (value === null || value === undefined) {
    return ['%cnull', 'color: gray'];
  }

  if (typeof value === 'boolean') {
    return [`%c${value}`, `color: ${COLORS.vars[4]}`];
  }

  if (typeof value === 'number') {
    return [`%c${value}`, `color: ${COLORS.number}`];
  }

  if (typeof value === 'string') {
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
      return styleAttribute(value);
    }
    return [`%c"${value}"`, `color: ${COLORS.string}`];
  }

  if (value['?']) {
    return styleVar(value as Variable);
  }

  return [`${value}`, ''];
};

const formatTriple = (triple: any[]): FormattedResult => {
  if (Array.isArray(triple) && triple.length === 3) {
    const parts = triple.map(formatValue);
    return {
      text: `(match ${parts.map(p => p[0]).join(' ')})`,
      styles: parts.map(p => p[1])
    };
  }
  return { text: '', styles: [] };
};

const formatWhereClause = (clause: Clause): FormattedResult => {
  if (clause.Match) {
    return formatTriple(clause.Match as any);
  }

  if (clause.Case) {
    const parts = clause.Case.map(formatValue);
    return {
      text: `(case ${parts.map(p => p[0]).join(' ')})`,
      styles: parts.map(p => p[1])
    };
  }

  if (clause.Or) {
    const formatted = clause.Or.map(formatWhereClause);
    return {
      text: `(or\n${formatted.map(f => '  ' + f.text).join('\n')})`,
      styles: formatted.flatMap(f => f.styles)
    };
  }

  if (clause.And) {
    const formatted = clause.And.map(formatWhereClause);
    return {
      text: `(and\n${formatted.map(f => '  ' + f.text).join('\n')})`,
      styles: formatted.flatMap(f => f.styles)
    };
  }

  if (clause.Not) {
    const inner = formatWhereClause(clause.Not);
    return {
      text: `(not ${inner.text})`,
      styles: inner.styles
    };
  }

  return { text: '', styles: [] };
};

const naturalLanguage = (query: Query) => {
  const varToLetter = (varObj: Variable) => `${(varObj.toString().replace('?', '$'))}`;

  const describeSelect = (select: Selector) => {
    const describeValue = (key: string, value: any): string => {
      if (value['?']) {
        return `${key} (as ${varToLetter(value)})`;
      } else if (typeof value === 'object') {
        return Object.entries(value)
          .map(([subKey, subValue]) => describeValue(`${key}.${subKey}`, subValue))
          .join(", ");
      }
      return `${key} (as ${JSON.stringify(value)})`;
    };

    const fields = Object.entries(select)
      .map(([key, value]) => describeValue(key, value))
      .join(", ");

    return `Find records containing ${fields}`;
  };

  const describeWhere = (clause: Clause): string => {
    if (clause.Match) {
      const [val1, op, val2] = clause.Match;
      const left = (val1 as any)['?'] ? varToLetter(val1 as any) : JSON.stringify(val1);
      const right = (val2 as any)['?'] ? varToLetter(val2 as any) : JSON.stringify(val2);
      return `${left} ${op} ${right}`;
    }

    if (clause.Case) {
      const [entity, attr, value] = clause.Case;
      return `${varToLetter(entity as Variable<Entity>)}'s ${attr} is ${(value as Variable)['?'] ? varToLetter(value as any) : JSON.stringify(value)}`;
    }

    if (clause.Or) {
      const conditions = clause.Or.map(describeWhere);
      return `either ${conditions.join(" or ")}`;
    }

    if (clause.And) {
      const conditions = clause.And.map(describeWhere);
      return conditions.join(" and ");
    }

    if (clause.Not) {
      return `it is not true that ${describeWhere(clause.Not)}`;
    }

    return JSON.stringify(clause);
  };

  return {
    selection: describeSelect(query.select),
    conditions: [...query.where].map(describeWhere)
  };
};

export const logQuery = (query: Query): void => {
  try {
    console.groupCollapsed('Query');

    try {
      // Log SELECT
      console.group('SELECT');
      const logSelectValue = (key: string, value: any): [string[], string[]] => {
        if (value['?']) {
          const attrStyle = styleAttribute(key);
          const varStyle = styleVar(value as Variable);
          return [[`${attrStyle[0]}: ${varStyle[0]}`], [attrStyle[1], varStyle[1]]];
        } else if (typeof value === 'object') {
          return Object.entries(value).reduce((acc, [subKey, subValue]) => {
            const [texts, styles] = logSelectValue(`${key}.${subKey}`, subValue);
            return [
              [...acc[0], ...texts],
              [...acc[1], ...styles]
            ];
          }, [[] as string[], [] as string[]]);
        }
        return [[], []];
      };

      Object.entries(query.select).forEach(([key, value]) => {
        const [texts, styles] = logSelectValue(key, value);
        texts.forEach((text, i) => {
          console.log(text, ...styles.slice(i * 2, i * 2 + 2));
        });
      });
    } catch (err) {
      console.error('Error logging SELECT:', err);
    } finally {
      console.groupEnd();
    }

    try {
      // Log WHERE
      console.group('WHERE');
      [...query.where].forEach((clause: Clause) => {
        const formatted = formatWhereClause(clause);
        console.log(formatted.text, ...formatted.styles);
      });
    } catch (err) {
      console.error('Error logging WHERE:', err);
    } finally {
      console.groupEnd();
    }

    try {
      // Log EXPLANATION
      console.groupCollapsed('EXPLANATION');
      const explanation = naturalLanguage(query);
      console.log(explanation.selection);
      console.log('where:');
      explanation.conditions.forEach(condition => {
        console.log('•', condition);
      });
    } catch (err) {
      console.error('Error logging EXPLANATION:', err);
    } finally {
      console.groupEnd();
    }

    console.groupEnd();
  } catch (err) {
    console.error('Error in logQuery:', err);
  }
};

// Example usage:
// const sampleQuery: Query = {
//   "select": {
//     "self": {
//       "?": {
//         "id": 4
//       }
//     },
//     "description": {
//       "?": {
//         "id": 9
//       }
//     },
//     "hunger": {
//       "?": {
//         "id": 5
//       }
//     }
//   },
//   "where": [
//     {
//       "Match": [
//         "lizard bunny",
//         "==",
//         {
//           "?": {
//             "id": 9
//           }
//         }
//       ]
//     },
//     {
//       "Or": [
//         {
//           "And": [
//             {
//               "Not": {
//                 "Case": [
//                   {
//                     "?": {
//                       "id": 4
//                     }
//                   },
//                   "hunger",
//                   {
//                     "?": {
//                       "id": 6
//                     }
//                   }
//                 ]
//               }
//             },
//             {
//               "Match": [
//                 0,
//                 "==",
//                 {
//                   "?": {
//                     "id": 5
//                   }
//                 }
//               ]
//             }
//           ]
//         }
//       ]
//     }
//   ]
// };
