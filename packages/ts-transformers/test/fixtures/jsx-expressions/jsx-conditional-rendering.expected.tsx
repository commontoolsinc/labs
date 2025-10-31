import * as __ctHelpers from "commontools";
import { ifElse, recipe, UI } from "commontools";
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <h3>Basic Ternary</h3>
        <span>{__ctHelpers.ifElse(state.isActive, "Active", "Inactive")}</span>
        <span>{__ctHelpers.ifElse(state.hasPermission, "Authorized", "Denied")}</span>

        <h3>Ternary with Comparisons</h3>
        <span>{__ctHelpers.ifElse(__ctHelpers.derive({ state: {
                count: state.count
            } }, ({ state }) => state.count > 10), "High", "Low")}</span>
        <span>{__ctHelpers.ifElse(__ctHelpers.derive({ state: {
                score: state.score
            } }, ({ state }) => state.score >= 90), "A", __ctHelpers.derive({ state: {
                score: state.score
            } }, ({ state }) => state.score >= 80 ? "B" : "C"))}</span>
        <span>
          {__ctHelpers.ifElse(__ctHelpers.derive({ state: {
                count: state.count
            } }, ({ state }) => state.count === 0), "Empty", __ctHelpers.derive({ state: {
                count: state.count
            } }, ({ state }) => state.count === 1
            ? "Single"
            : "Multiple"))}
        </span>

        <h3>Nested Ternary</h3>
        <span>
          {__ctHelpers.ifElse(state.isActive, __ctHelpers.derive({ state: {
                isPremium: state.isPremium
            } }, ({ state }) => (state.isPremium ? "Premium Active" : "Regular Active")), "Inactive")}
        </span>
        <span>
          {__ctHelpers.ifElse(__ctHelpers.derive({ state: {
                userType: state.userType
            } }, ({ state }) => state.userType === "admin"), "Admin", __ctHelpers.derive({ state: {
                userType: state.userType
            } }, ({ state }) => state.userType === "user"
            ? "User"
            : "Guest"))}
        </span>

        <h3>Complex Conditions</h3>
        <span>
          {__ctHelpers.ifElse(__ctHelpers.derive({ state: {
                isActive: state.isActive,
                hasPermission: state.hasPermission
            } }, ({ state }) => state.isActive && state.hasPermission), "Full Access", "Limited Access")}
        </span>
        <span>
          {__ctHelpers.ifElse(__ctHelpers.derive({ state: {
                count: state.count
            } }, ({ state }) => state.count > 0 && state.count < 10), "In Range", "Out of Range")}
        </span>
        <span>
          {__ctHelpers.ifElse(__ctHelpers.derive({ state: {
                isPremium: state.isPremium,
                score: state.score
            } }, ({ state }) => state.isPremium || state.score > 100), "Premium Features", "Basic Features")}
        </span>

        <h3>IfElse Component</h3>
        {ifElse(state.isActive, <div>User is active with {state.count} items</div>, <div>User is inactive</div>)}

        {ifElse(__ctHelpers.derive({ state: {
                count: state.count
            } }, ({ state }) => state.count > 5), <ul>
            <li>Many items: {state.count}</li>
          </ul>, <p>Few items: {state.count}</p>)}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
