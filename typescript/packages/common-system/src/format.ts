import { Clause, Selector, Var } from "datalogia";

// Formatter function
export function formatDatalogQuery(query: { select: Selector; where: Clause[] }) {
  let output = "SELECT\n";

  // Format SELECT section
  function formatSelectShape(shape: Selector, indent = 2): string {
    let result = "";
    for (const [key, value] of Object.entries(shape)) {
      const spaces = " ".repeat(indent);
      if (Array.isArray(value)) {
        result += `${spaces}${key}:\n`;
        for (const item of value) {
          result += `${spaces}  - {\n`;
          for (const [subKey, subValue] of Object.entries(item || {})) {
            result += `${spaces}    ${subKey}: ${subValue?.toString()}\n`;
          }
          result += `${spaces}  }\n`;
        }
      } else if (Var.is(value)) {
        result += `${spaces}${key}: ${value.toString()}\n`;
      } else if (typeof value === 'object' && value !== null) {
        result += `${spaces}${key}:\n`;
        result += formatSelectShape(value as Selector, indent + 2);
      }
    }
    return result;
  }

  // Format WHERE section
  function formatWhereClause(clause: Clause, indent = 2): string {
    const spaces = " ".repeat(indent);
    if ("Case" in clause) {
      const [subject, predicate, object] = clause.Case!;
      const subjectStr = "?" in subject ? `${subject.toString()}` :
                        "/" in subject ? `/${subject["/"]}`  : subject;
      const predicateStr = typeof predicate === 'string' ? predicate :
                          "?" in predicate ? `${predicate.toString()}` : predicate;
      const objectStr = Var.is(object) ? `${object.toString()}` : object;
      return `${spaces}Case(${subjectStr}, ${predicateStr}, ${objectStr})`;
    } else if ("Is" in clause) {
      const [left, right] = clause.Is! as any;
      const leftStr = "?" in left ? `${left.toString()}` : left;
      const rightStr = "?" in right ? `${right.toString()}` : right;
      return `${spaces}Is(${leftStr}, ${rightStr})`;
    } else if ("And" in clause) {
      return `${spaces}And(\n${clause.And!.map(c => formatWhereClause(c, indent + 2)).join(",\n")}\n${spaces})`;
    } else if ("Or" in clause) {
      return `${spaces}Or(\n${clause.Or!.map(c => formatWhereClause(c, indent + 2)).join(",\n")}\n${spaces})`;
    } else if ("Not" in clause) {
      return `${spaces}Not(\n${formatWhereClause(clause.Not!, indent + 2)}\n${spaces})`;
    } else if ("Match" in clause) {
      const [value, op, variable] = clause.Match!;
      return `${spaces}Match("${value}", "${op}", ${variable?.toString()})`;
    }
    return "";
  }

  output += formatSelectShape(query.select);
  output += "\nWHERE\n";
  output += query.where.map(clause => formatWhereClause(clause)).join(",\n");

  return output;
}
