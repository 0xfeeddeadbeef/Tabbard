import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  { files: ["**/*.{js,mjs,cjs}"], plugins: { js }, extends: ["js/recommended"] },
  // Classic scripts today; switch to "module" together with manifest.json and the <script> tags.
  { files: ["**/*.js"], languageOptions: { sourceType: "script", globals: globals.webextensions } },
  { files: ["background.js"], languageOptions: { globals: globals.serviceworker } },
  { files: ["offscreen.js", "options.js"], languageOptions: { globals: globals.browser } },
  { files: ["**/*.mjs"], languageOptions: { globals: globals.node } },
]);
