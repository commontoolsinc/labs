/// <cts-enable />
import { h, recipe, UI, ifElse, JSONSchema } from "commontools";
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
        <span>{commontools_1.ifElse(state.isActive, "Active", "Inactive")}</span>
        <span>{commontools_1.ifElse(state.hasPermission, "Authorized", "Denied")}</span>
        
        <h3>Ternary with Comparisons</h3>
        <span>{commontools_1.ifElse(state.count > 10, "High", "Low")}</span>
        <span>{commontools_1.ifElse(state.score >= 90, "A", commontools_1.ifElse(state.score >= 80, "B", "C"))}</span>
        <span>{commontools_1.ifElse(state.count === 0, "Empty", commontools_1.ifElse(state.count === 1, "Single", "Multiple"))}</span>
        
        <h3>Nested Ternary</h3>
        <span>{commontools_1.ifElse(state.isActive, commontools_1.ifElse(state.isPremium, "Premium Active", "Regular Active"), "Inactive")}</span>
        <span>{commontools_1.ifElse(state.userType === "admin", "Admin", commontools_1.ifElse(state.userType === "user", "User", "Guest"))}</span>
        
        <h3>Complex Conditions</h3>
        <span>{commontools_1.ifElse(state.isActive && state.hasPermission, "Full Access", "Limited Access")}</span>
        <span>{commontools_1.ifElse(state.count > 0 && state.count < 10, "In Range", "Out of Range")}</span>
        <span>{commontools_1.ifElse(state.isPremium || state.score > 100, "Premium Features", "Basic Features")}</span>
        
        <h3>IfElse Component</h3>
        {ifElse(state.isActive, <div>User is active with {state.count} items</div>, <div>User is inactive</div>)}
        
        {ifElse(state.count > 5, <ul>
            <li>Many items: {state.count}</li>
          </ul>, <p>Few items: {state.count}</p>)}
      </div>),
    };
});