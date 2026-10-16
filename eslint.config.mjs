import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "coverage/**",
      "drizzle/meta/**",
      "cloudflare-reminder-worker/node_modules/**",
      "cloudflare-media-worker/node_modules/**",
      "cloudflare-claude-worker/**",
    ],
  },
  ...nextVitals,
  ...nextTypescript,
];

export default eslintConfig;
