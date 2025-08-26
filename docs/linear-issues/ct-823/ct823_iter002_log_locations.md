# CT-823 Iteration 002 - Log File Locations

## Test Execution Logs (iter002 prefix)

### 1. Deployment Log
- **File:** `ct823_iter002_deploy.log`
- **Content:** CommonTools deployment output showing charm ID creation
- **Key Info:** Charm ID: baedreibbme7gn3pjpnox4pdoxycvyc7k3n7obk6cmpxmolaumw7rhaj6ea

### 2. Test Summary 
- **File:** `ct823_iter002_summary.md`
- **Content:** High-level summary of test execution and findings
- **Key Info:** Documents sync failure point and error cascade

### 3. Browser Console Logs
- **Tab 1:** Console output too large to save in full
  - Shows [CT823-HANDLER] logs proving handler execution
  - Shows successful push operations for all messages
  - ConflictError at 21:06:25.968
  
- **Tab 2:** Console output exceeded 113,835 tokens (too large to save)
  - 100+ ConflictError entries after reload
  - 100+ TypeError: Unknown type undefined errors
  - Complete UI breakdown after conflicts

### Key Findings Documented:
1. **Sync Failure Point:** Tab 2 failed to receive "tab1msg2" messages
2. **Reload Cascade:** Reloading Tab 2 triggered massive ConflictErrors
3. **Recipe Breakdown:** After conflicts, Tab 2 UI showed no messages
4. **Handler Still Works:** Debug logs confirm handlers execute correctly

### Related Files (existing):
- `docs/linear-issues/ct-823/ct-823.md` - Main bug documentation
- `packages/runner/integration/ct-823-chat-rapid-conflicts.tsx` - Test recipe
- `ct-823-test-results.md` - Previous iteration results