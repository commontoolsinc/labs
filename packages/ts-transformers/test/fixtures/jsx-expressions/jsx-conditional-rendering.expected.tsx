/// <cts-enable />
import { h, recipe, UI, ifElse, derive, JSONSchema } from "commontools";
interface State {
    isActive: boolean;
    count: number;
    userType: string;
    score: number;
    hasPermission: boolean;
    isPremium: boolean;
}
export default recipe({
    type: "object",
    properties: {
        isActive: {
            type: "boolean"
        },
        count: {
            type: "number"
        },
        userType: {
            type: "string"
        },
        score: {
            type: "number"
        },
        hasPermission: {
            type: "boolean"
        },
        isPremium: {
            type: "boolean"
        }
    },
    required: ["isActive", "count", "userType", "score", "hasPermission", "isPremium"]
} as const satisfies JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>Basic Ternary</h3>
        <span>{ifElse(state.isActive, "Active", "Inactive")}</span>
        <span>{ifElse(state.hasPermission, "Authorized", "Denied")}</span>
        
        <h3>Ternary with Comparisons</h3>
        <span>{ifElse(derive(state.count, _v1 => _v1 > 10), "High", "Low")}</span>
        <span>{ifElse(derive(state.score, _v1 => _v1 >= 90), "A", derive(state.score, _v1 => _v1 >= 80 ? "B" : "C"))}</span>
        <span>{ifElse(derive(state.count, _v1 => _v1 === 0), "Empty", derive(state.count, _v1 => _v1 === 1 ? "Single" : "Multiple"))}</span>
        
        <h3>Nested Ternary</h3>
        <span>{ifElse(state.isActive, derive(state.isPremium, _v1 => (_v1 ? "Premium Active" : "Regular Active")), "Inactive")}</span>
        <span>{ifElse(derive(state.userType, _v1 => _v1 === "admin"), "Admin", derive(state.userType, _v1 => _v1 === "user" ? "User" : "Guest"))}</span>
        
        <h3>Complex Conditions</h3>
        <span>{ifElse(derive({ state_isActive: state.isActive, state_hasPermission: state.hasPermission }, ({ state_isActive: _v1, state_hasPermission: _v2 }) => _v1 && _v2), "Full Access", "Limited Access")}</span>
        <span>{ifElse(derive(state.count, _v1 => _v1 > 0 && _v1 < 10), "In Range", "Out of Range")}</span>
        <span>{ifElse(derive({ state_isPremium: state.isPremium, state_score: state.score }, ({ state_isPremium: _v1, state_score: _v2 }) => _v1 || _v2 > 100), "Premium Features", "Basic Features")}</span>
        
        <h3>IfElse Component</h3>
        {ifElse(state.isActive, <div>User is active with {state.count} items</div>, <div>User is inactive</div>)}
        
        {ifElse(derive(state.count, _v1 => _v1 > 5), <ul>
            <li>Many items: {state.count}</li>
          </ul>, <p>Few items: {state.count}</p>)}
      </div>),
    };
});
