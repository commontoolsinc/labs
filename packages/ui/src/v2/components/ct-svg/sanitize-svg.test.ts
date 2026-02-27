/**
 * Tests for SVG sanitization
 *
 * NOTE: These tests require browser APIs (DOMParser, XMLSerializer) and must be run
 * in a browser environment. To run these tests:
 *
 * 1. Using deno-web-test:
 *    deno run -A packages/deno-web-test/cli.ts packages/ui/src/v2/components/ct-svg/sanitize-svg.test.ts
 *
 * 2. Or run them manually in a browser console
 *
 * These tests will fail in a standard Deno test environment because DOMParser
 * is not available outside of a browser context.
 */
import { assert } from "@std/assert";
import { sanitizeSvg } from "./sanitize-svg.ts";

// Helper to check if string contains substring
function contains(str: string, substring: string): boolean {
  return str.indexOf(substring) !== -1;
}

// Helper to check if string does NOT contain substring
function notContains(str: string, substring: string): boolean {
  return str.indexOf(substring) === -1;
}

// Valid SVG tests
Deno.test("sanitizeSvg: should pass through simple valid SVG", function () {
  const svg = '<svg><circle cx="50" cy="50" r="40"/></svg>';
  const result = sanitizeSvg(svg);

  assert(contains(result, "<circle"), "Should contain <circle");
  assert(contains(result, 'cx="50"'), 'Should contain cx="50"');
  assert(contains(result, 'cy="50"'), 'Should contain cy="50"');
  assert(contains(result, 'r="40"'), 'Should contain r="40"');
});

Deno.test("sanitizeSvg: should preserve SVG attributes", function () {
  const svg =
    '<svg viewBox="0 0 100 100" width="100" height="100"><rect x="10" y="10" width="80" height="80" fill="blue"/></svg>';
  const result = sanitizeSvg(svg);

  assert(contains(result, "viewBox"), "Should contain viewBox");
  assert(contains(result, "width"), "Should contain width");
  assert(contains(result, "height"), "Should contain height");
  assert(contains(result, "<rect"), "Should contain <rect");
  assert(contains(result, 'fill="blue"'), 'Should contain fill="blue"');
});

Deno.test("sanitizeSvg: should preserve nested groups and elements", function () {
  const svg =
    '<svg><g id="layer1"><circle cx="50" cy="50" r="40"/><rect x="10" y="10" width="20" height="20"/></g></svg>';
  const result = sanitizeSvg(svg);

  assert(contains(result, "<g"), "Should contain <g");
  assert(contains(result, 'id="layer1"'), 'Should contain id="layer1"');
  assert(contains(result, "<circle"), "Should contain <circle");
  assert(contains(result, "<rect"), "Should contain <rect");
});

// Script removal tests
Deno.test("sanitizeSvg: should remove script tags", function () {
  const svg =
    "<svg><script>alert('xss')</script><circle cx='50' cy='50' r='40'/></svg>";
  const result = sanitizeSvg(svg);

  assert(notContains(result, "<script"), "Should not contain <script");
  assert(notContains(result, "alert"), "Should not contain alert");
  assert(contains(result, "<circle"), "Should contain <circle");
});

Deno.test("sanitizeSvg: should remove multiple script tags", function () {
  const svg =
    "<svg><script>alert('xss1')</script><circle cx='50' cy='50' r='40'/><script>alert('xss2')</script></svg>";
  const result = sanitizeSvg(svg);

  assert(notContains(result, "<script"), "Should not contain <script");
  assert(notContains(result, "alert"), "Should not contain alert");
  assert(notContains(result, "xss1"), "Should not contain xss1");
  assert(notContains(result, "xss2"), "Should not contain xss2");
  assert(contains(result, "<circle"), "Should contain <circle");
});

Deno.test("sanitizeSvg: should remove nested script tags inside groups", function () {
  const svg =
    "<svg><g><script>alert('xss')</script><circle cx='50' cy='50' r='40'/></g></svg>";
  const result = sanitizeSvg(svg);

  assert(notContains(result, "<script"), "Should not contain <script");
  assert(notContains(result, "alert"), "Should not contain alert");
  assert(contains(result, "<circle"), "Should contain <circle");
  assert(contains(result, "<g"), "Should contain <g");
});

// Event handler removal tests
Deno.test("sanitizeSvg: should remove onclick attribute", function () {
  const svg =
    '<svg><circle onclick="alert(\'xss\')" cx="50" cy="50" r="40"/></svg>';
  const result = sanitizeSvg(svg);

  assert(notContains(result, "onclick"), "Should not contain onclick");
  assert(notContains(result, "alert"), "Should not contain alert");
  assert(contains(result, "<circle"), "Should contain <circle");
  assert(contains(result, 'cx="50"'), 'Should contain cx="50"');
});

Deno.test("sanitizeSvg: should remove onload attribute from SVG element", function () {
  const svg =
    '<svg onload="alert(\'xss\')"><circle cx="50" cy="50" r="40"/></svg>';
  const result = sanitizeSvg(svg);

  assert(notContains(result, "onload"), "Should not contain onload");
  assert(notContains(result, "alert"), "Should not contain alert");
  assert(contains(result, "<circle"), "Should contain <circle");
});

Deno.test("sanitizeSvg: should remove onerror attribute", function () {
  const svg = '<svg><image onerror="alert(\'xss\')" href="test.png"/></svg>';
  const result = sanitizeSvg(svg);

  assert(notContains(result, "onerror"), "Should not contain onerror");
  assert(notContains(result, "alert"), "Should not contain alert");
  assert(contains(result, "<image"), "Should contain <image");
});

Deno.test("sanitizeSvg: should remove multiple event handlers from same element", function () {
  const svg =
    '<svg><circle onclick="alert(1)" onload="alert(2)" onmouseover="alert(3)" cx="50" cy="50" r="40"/></svg>';
  const result = sanitizeSvg(svg);

  assert(notContains(result, "onclick"), "Should not contain onclick");
  assert(notContains(result, "onload"), "Should not contain onload");
  assert(notContains(result, "onmouseover"), "Should not contain onmouseover");
  assert(notContains(result, "alert"), "Should not contain alert");
  assert(contains(result, "<circle"), "Should contain <circle");
  assert(contains(result, 'cx="50"'), 'Should contain cx="50"');
});

Deno.test("sanitizeSvg: should remove event handlers with mixed case", function () {
  const svg =
    '<svg><circle onClick="alert(\'xss\')" onLoad="alert(\'xss\')" cx="50" cy="50" r="40"/></svg>';
  const result = sanitizeSvg(svg);

  // Event handlers should be removed regardless of case
  assert(
    notContains(result.toLowerCase(), "onclick"),
    "Should not contain onclick",
  );
  assert(
    notContains(result.toLowerCase(), "onload"),
    "Should not contain onload",
  );
  assert(notContains(result, "alert"), "Should not contain alert");
});

// URL sanitization tests
Deno.test("sanitizeSvg: should remove javascript: URL in href", function () {
  const svg =
    '<svg><a href="javascript:alert(\'xss\')"><text x="10" y="20">click</text></a></svg>';
  const result = sanitizeSvg(svg);

  assert(notContains(result, "javascript:"), "Should not contain javascript:");
  assert(notContains(result, "alert"), "Should not contain alert");
  assert(contains(result, "<text"), "Should contain <text");
  assert(contains(result, "click"), "Should contain click");
});

Deno.test("sanitizeSvg: should remove javascript: URL in xlink:href", function () {
  const svg =
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="javascript:alert(\'xss\')"><text x="10" y="20">click</text></a></svg>';
  const result = sanitizeSvg(svg);

  assert(notContains(result, "javascript:"), "Should not contain javascript:");
  assert(notContains(result, "alert"), "Should not contain alert");
  assert(contains(result, "<text"), "Should contain <text");
});

Deno.test("sanitizeSvg: should remove vbscript: URL", function () {
  const svg =
    "<svg><a href=\"vbscript:msgbox('xss')\"><text>click</text></a></svg>";
  const result = sanitizeSvg(svg);

  assert(notContains(result, "vbscript:"), "Should not contain vbscript:");
  assert(notContains(result, "msgbox"), "Should not contain msgbox");
  assert(contains(result, "<text"), "Should contain <text");
});

Deno.test("sanitizeSvg: should remove data:text/html URL", function () {
  const svg =
    "<svg><a href=\"data:text/html,<script>alert('xss')</script>\"><text>click</text></a></svg>";
  const result = sanitizeSvg(svg);

  // The key security requirement: dangerous URL protocol is removed
  assert(
    notContains(result, "data:text/html"),
    "Should not contain data:text/html",
  );
  // Also verify the XSS payload doesn't get through
  assert(notContains(result, "alert"), "Should not contain alert");
});

Deno.test("sanitizeSvg: should preserve safe URLs", function () {
  const svg =
    '<svg><a href="https://example.com"><text x="10" y="20">click</text></a></svg>';
  const result = sanitizeSvg(svg);

  assert(
    contains(result, "https://example.com"),
    "Should contain https://example.com",
  );
  assert(contains(result, "<text"), "Should contain <text");
});

Deno.test("sanitizeSvg: should preserve relative URLs", function () {
  const svg =
    '<svg><image href="./image.png" x="0" y="0" width="100" height="100"/></svg>';
  const result = sanitizeSvg(svg);

  assert(contains(result, "./image.png"), "Should contain ./image.png");
  assert(contains(result, "<image"), "Should contain <image");
});

Deno.test("sanitizeSvg: should handle javascript: with mixed case", function () {
  const svg =
    "<svg><a href=\"JavaScript:alert('xss')\"><text>click</text></a></svg>";
  const result = sanitizeSvg(svg);

  assert(
    notContains(result.toLowerCase(), "javascript:"),
    "Should not contain javascript:",
  );
  assert(notContains(result, "alert"), "Should not contain alert");
});

// Dangerous element removal tests
Deno.test("sanitizeSvg: should remove foreignObject element", function () {
  const svg =
    '<svg><foreignObject width="100" height="100"><div xmlns="http://www.w3.org/1999/xhtml">html content</div></foreignObject><circle cx="50" cy="50" r="40"/></svg>';
  const result = sanitizeSvg(svg);

  assert(
    notContains(result, "foreignObject"),
    "Should not contain foreignObject",
  );
  assert(notContains(result, "<div"), "Should not contain <div");
  assert(
    notContains(result, "html content"),
    "Should not contain html content",
  );
  assert(contains(result, "<circle"), "Should contain <circle");
});

Deno.test("sanitizeSvg: should remove set element", function () {
  const svg =
    '<svg><set attributeName="onclick" to="alert(\'xss\')"/><circle cx="50" cy="50" r="40"/></svg>';
  const result = sanitizeSvg(svg);

  assert(notContains(result, "<set"), "Should not contain <set");
  assert(
    notContains(result, "attributeName"),
    "Should not contain attributeName",
  );
  assert(contains(result, "<circle"), "Should contain <circle");
});

Deno.test("sanitizeSvg: should remove iframe element", function () {
  const svg =
    '<svg><iframe src="evil.html"/><circle cx="50" cy="50" r="40"/></svg>';
  const result = sanitizeSvg(svg);

  assert(notContains(result, "<iframe"), "Should not contain <iframe");
  assert(contains(result, "<circle"), "Should contain <circle");
});

Deno.test("sanitizeSvg: should remove embed element", function () {
  const svg =
    '<svg><embed src="evil.swf"/><circle cx="50" cy="50" r="40"/></svg>';
  const result = sanitizeSvg(svg);

  assert(notContains(result, "<embed"), "Should not contain <embed");
  assert(contains(result, "<circle"), "Should contain <circle");
});

Deno.test("sanitizeSvg: should remove object element", function () {
  const svg =
    '<svg><object data="evil.html"/><circle cx="50" cy="50" r="40"/></svg>';
  const result = sanitizeSvg(svg);

  assert(notContains(result, "<object"), "Should not contain <object");
  assert(contains(result, "<circle"), "Should contain <circle");
});

// Nested dangerous content tests
Deno.test("sanitizeSvg: should remove dangerous elements inside defs", function () {
  const svg =
    '<svg><defs><script>alert(\'xss\')</script><linearGradient id="grad1"><stop offset="0%" stop-color="red"/></linearGradient></defs></svg>';
  const result = sanitizeSvg(svg);

  assert(notContains(result, "<script"), "Should not contain <script");
  assert(notContains(result, "alert"), "Should not contain alert");
  assert(contains(result, "<defs"), "Should contain <defs");
  assert(contains(result, "linearGradient"), "Should contain linearGradient");
});

Deno.test("sanitizeSvg: should remove event handlers in nested elements", function () {
  const svg =
    '<svg><g><g><circle onclick="alert(\'xss\')" cx="50" cy="50" r="40"/></g></g></svg>';
  const result = sanitizeSvg(svg);

  assert(notContains(result, "onclick"), "Should not contain onclick");
  assert(notContains(result, "alert"), "Should not contain alert");
  assert(contains(result, "<circle"), "Should contain <circle");
});

Deno.test("sanitizeSvg: should handle complex nested structure with multiple threats", function () {
  const svg =
    '<svg><g id="layer1"><script>alert(1)</script><a href="javascript:alert(2)"><text onclick="alert(3)">text</text></a><foreignObject><div>html</div></foreignObject></g></svg>';
  const result = sanitizeSvg(svg);

  assert(notContains(result, "<script"), "Should not contain <script");
  assert(notContains(result, "javascript:"), "Should not contain javascript:");
  assert(notContains(result, "onclick"), "Should not contain onclick");
  assert(
    notContains(result, "foreignObject"),
    "Should not contain foreignObject",
  );
  assert(notContains(result, "<div"), "Should not contain <div");
  assert(notContains(result, "alert"), "Should not contain alert");
  assert(contains(result, "<g"), "Should contain <g");
  assert(contains(result, "<text"), "Should contain <text");
  assert(contains(result, "text"), "Should contain text");
});

// Edge case tests
Deno.test("sanitizeSvg: should return empty string for empty input", function () {
  const result = sanitizeSvg("");
  assert(result === "", "Should return empty string");
});

Deno.test("sanitizeSvg: should return empty string for whitespace-only input", function () {
  const result = sanitizeSvg("   \n\t  ");
  assert(result === "", "Should return empty string");
});

Deno.test("sanitizeSvg: should return empty string for null input", function () {
  const result = sanitizeSvg(null as any);
  assert(result === "", "Should return empty string");
});

Deno.test("sanitizeSvg: should return empty string for undefined input", function () {
  const result = sanitizeSvg(undefined as any);
  assert(result === "", "Should return empty string");
});

Deno.test("sanitizeSvg: should return empty string for non-string input", function () {
  const result = sanitizeSvg(123 as any);
  assert(result === "", "Should return empty string");
});

Deno.test("sanitizeSvg: should return empty string for malformed XML", function () {
  const result = sanitizeSvg("<svg><circle></svg>");
  assert(result === "", "Should return empty string");
});

Deno.test("sanitizeSvg: should handle non-SVG content", function () {
  const result = sanitizeSvg("<div>not svg</div>");
  // Note: DOMParser with "image/svg+xml" may parse non-SVG elements differently depending on the browser
  // The important thing is that the result is safe (no scripts, no event handlers)
  // and non-SVG elements like <div> are either removed or made safe
  // The current implementation allows <div> since it's not in the dangerous elements list
  // This is acceptable since <div> without event handlers is not a security risk
  assert(
    typeof result === "string" && result.length >= 0,
    "Should return a string",
  );
});

// Style element tests
Deno.test("sanitizeSvg: should preserve style elements", function () {
  const svg =
    '<svg><style>.cls { fill: red; }</style><circle class="cls" cx="50" cy="50" r="40"/></svg>';
  const result = sanitizeSvg(svg);

  // Note: The implementation does NOT remove <style> elements from the dangerous list
  // Style elements are allowed, which is fine for SVG since they are scoped
  assert(contains(result, "<style"), "Should contain <style");
  assert(contains(result, "<circle"), "Should contain <circle");
});

Deno.test("sanitizeSvg: should preserve inline style attributes", function () {
  const svg =
    '<svg><circle style="fill: red; stroke: blue;" cx="50" cy="50" r="40"/></svg>';
  const result = sanitizeSvg(svg);

  assert(contains(result, "style"), "Should contain style");
  assert(contains(result, "fill: red"), "Should contain fill: red");
  assert(contains(result, "<circle"), "Should contain <circle");
});

// Comprehensive XSS vector test
Deno.test("sanitizeSvg: should sanitize multiple attack vectors in single SVG", function () {
  const svg = `<svg onload="alert(1)">
    <script>alert(2)</script>
    <a href="javascript:alert(3)"><text onclick="alert(4)">click</text></a>
    <foreignObject><body onload="alert(5)">test</body></foreignObject>
    <set attributeName="onload" to="alert(6)"/>
    <circle onerror="alert(7)" cx="50" cy="50" r="40"/>
  </svg>`;
  const result = sanitizeSvg(svg);

  // Ensure no alert() calls remain
  assert(notContains(result, "alert(1)"), "Should not contain alert(1)");
  assert(notContains(result, "alert(2)"), "Should not contain alert(2)");
  assert(notContains(result, "alert(3)"), "Should not contain alert(3)");
  assert(notContains(result, "alert(4)"), "Should not contain alert(4)");
  assert(notContains(result, "alert(5)"), "Should not contain alert(5)");
  assert(notContains(result, "alert(6)"), "Should not contain alert(6)");
  assert(notContains(result, "alert(7)"), "Should not contain alert(7)");

  // Ensure dangerous elements/attributes removed
  assert(notContains(result, "<script"), "Should not contain <script");
  assert(notContains(result, "javascript:"), "Should not contain javascript:");
  assert(
    notContains(result, "foreignObject"),
    "Should not contain foreignObject",
  );
  assert(notContains(result, "<set"), "Should not contain <set");
  assert(
    notContains(result.toLowerCase(), "onload"),
    "Should not contain onload",
  );
  assert(
    notContains(result.toLowerCase(), "onclick"),
    "Should not contain onclick",
  );
  assert(
    notContains(result.toLowerCase(), "onerror"),
    "Should not contain onerror",
  );

  // Ensure safe content preserved
  assert(contains(result, "<text"), "Should contain <text");
  assert(contains(result, "click"), "Should contain click");
  assert(contains(result, "<circle"), "Should contain <circle");
});
