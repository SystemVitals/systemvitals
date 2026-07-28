import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // A user can belong to several organizations once team invites exist, so
  // indexing organizations[0] silently picks an arbitrary one. Read the
  // active organization from useOrg() instead. See frontend/CLAUDE.md.
  {
    files: ["app/**/*.tsx", "app/**/*.ts", "components/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[computed=true][property.value=0][object.property.name='organizations']",
          message:
            "Don't index organizations[0] — a user can belong to several organizations. Use useOrg().activeOrg instead.",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
