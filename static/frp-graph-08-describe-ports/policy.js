import { map } from "https://cdn.jsdelivr.net/npm/rxjs@7.8.1/+esm";

export function policy(v) {
  console.log("policy scan", v);

  if (v === "illegal value") return;

  if (typeof v === "string") {
    return v.indexOf("<script") < 0 && v.indexOf("alert") < 0;
  }

  return true;
}

export function applyPolicy() {
  return map((v) => {
    if (!policy(v)) {
      return "<div>CANNOT DO</div>";
    }

    return v;
  });
}
