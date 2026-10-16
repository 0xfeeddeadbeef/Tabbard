import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  { files: ["**/*.{js,mjs,cjs}"], plugins: { js }, extends: ["js/recommended"] },
  // Classic scripts today; switch to "module" together with manifest.json and the <script> tags.
  { files: ["**/*.js"], languageOptions: { sourceType: "script", globals: globals.webextensions } },
  // background.js runs as a service worker in Chrome and as an event page, which has a DOM, in Firefox.
  { files: ["background.js"], languageOptions: { globals: { ...globals.serviceworker, ...globals.browser } } },
  { files: ["clipboard.js", "options.js"], languageOptions: { globals: globals.browser } },
  { files: ["**/*.mjs"], languageOptions: { globals: globals.node } },
  // Functions passed to Puppeteer's evaluate() run inside the extension's pages.
  { files: ["test/**/*.mjs"], languageOptions: { globals: { ...globals.browser, ...globals.webextensions } } },
]);
