import { describe, expect, it } from "vitest";
import { inlineModuleScripts } from "../../scripts/singleFile";

describe("single-file page builder", () => {
  const html =
    '<html><head><script type="module" crossorigin src="/assets/a.js"></script></head>' +
    "<body><p>hi</p></body></html>";

  it("inlines the module script and escapes an early </script", () => {
    const out = inlineModuleScripts(html, { "/assets/a.js": 'console.log("</script>")' });
    expect(out).toBe(
      '<html><head><script type="module">console.log("<\\/script>")</script></head>' +
        "<body><p>hi</p></body></html>",
    );
  });

  it("keeps the case of what it escapes, so the code still means the same", () => {
    const out = inlineModuleScripts(html, { "/assets/a.js": 'x = "</SCRIPT></Script>";' });
    expect(out).toContain('x = "<\\/SCRIPT><\\/Script>";');
  });

  it("refuses a missing script, '<!--' in code, and anything else that would load", () => {
    expect(() => inlineModuleScripts(html, {})).toThrow(/no built script/);
    expect(() => inlineModuleScripts(html, { "/assets/a.js": "a <!-- b" })).toThrow(/<!--/);
    const withLink = html.replace("<body>", '<body><link rel="stylesheet" href="x.css">');
    expect(() => inlineModuleScripts(withLink, { "/assets/a.js": "" })).toThrow(/another file/);
    const withImg = html.replace("<p>", '<img src="x.png"><p>');
    expect(() => inlineModuleScripts(withImg, { "/assets/a.js": "" })).toThrow(/another file/);
  });
});
