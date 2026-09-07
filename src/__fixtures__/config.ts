/** Synthetic repositories for pipeline tests, independent of first-run defaults. */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../types.js";

export const TEST_CONFIG: Config = {
  gating_bots: ["coderabbitai", "qodo-code-review"],
  ignored_authors: ["dependabot"],
  linear_workspace: "example",
  projects: [
    {
      name: "example",
      repos: [
        {
          owner: "example",
          name: "API",
          dev_branch: "develop",
          prod_branch: "main",
          deploy: "manual",
          local: join(homedir(), "Projects/example/API"),
        },
        {
          owner: "example",
          name: "web",
          dev_branch: "develop",
          prod_branch: "main",
          deploy: "manual",
          local: join(homedir(), "Projects/example/web"),
        },
        {
          owner: "example",
          name: "mobile",
          dev_branch: "main",
          prod_branch: "main",
          deploy: "manual",
          local: join(homedir(), "Projects/example/mobile"),
          eas: { cwd: join(homedir(), "Projects/example/mobile"), branch: "production" },
        },
      ],
    },
  ],
};
