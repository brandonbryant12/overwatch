# local/

This directory is yours. Upstream never adds or changes files here, so a fork can keep its own extensions, prompts
and notes here and still pull upstream changes without conflicts.

What goes here:

- **Extension modules** listed in the service config's `extensions`. Each exports a default function that receives
  the registries it may add to. Today that is `registerSourceType`, for a new kind of telemetry source:

  ```ts
  // local/my-source.ts, and in config.json: "extensions": ["/path/to/overwatch/local/my-source.ts"]
  import type { SourceType } from "../src/collect/sources/types.ts";
  const mySource: SourceType = { type: "my-source", queryHelp: "…", validate: () => [], collect: async () => ({ signals: [], samples: [], notes: [] }), query: async () => "" };
  export default ({ registerSourceType }: { registerSourceType: (s: SourceType) => void }) => registerSourceType(mySource);
  ```

- **Your investigator prompt**, pointed at by the plugin's `investigatorPrompt` option.
- Anything else you want versioned with your fork: notes, scripts, test fixtures for your sources.

See docs/customizing.md, "If you have just forked this".
