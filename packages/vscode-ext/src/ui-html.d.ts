/**
 * `@ylate/ui` resolves to a single bundled HTML file via its `main` field.
 * esbuild's `--loader:.html=text` reads it as a string at bundle time, so the
 * runtime import gives us the HTML to feed into `webview.html`.
 */
declare module "@ylate/ui" {
  const content: string;
  export default content;
}
