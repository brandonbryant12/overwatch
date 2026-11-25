import { describe, expect, test } from "bun:test";
import plugin, { fixerPermissions, investigatorPermissions, SHOW } from "../src/index.ts";
import { memoryKV } from "../src/store.ts";

/** Evaluates rules the way OpenCode does: the last matching rule wins; no match asks. */
function decide(rules: ReadonlyArray<{ action: string; resource: string; effect: string }>, action: string, resource: string) {
  const match = (pattern: string, value: string) =>
    new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(value) ||
    (pattern.endsWith(" *") && value === pattern.slice(0, -2));
  return rules.findLast((r) => match(r.action, action) && match(r.resource, resource))?.effect ?? "ask";
}

function fakeContext(options: unknown) {
  const tools: any[] = [];
  const commands: any[] = [];
  const agents = new Map<string, any>();
  const posts: string[] = [];
  const kv = memoryKV();
  const ctx = {
    options,
    location: { directory: "/tmp", project: { id: "p", directory: "/tmp", canonical: "/tmp" } },
    storage: kv,
    agent: {
      transform: async (fn: any) =>
        fn({
          update: (id: string, edit: (a: any) => void) => {
            const agent = agents.get(id) ?? { id, permissions: [{ action: "*", resource: "*", effect: "allow" }] };
            edit(agent);
            agents.set(id, agent);
          },
        }),
    },
    tool: { transform: async (fn: any) => fn({ add: (t: any) => tools.push(t) }) },
    command: { transform: async (fn: any) => fn({ add: (c: any) => commands.push(c) }) },
    session: { synthetic: async ({ text }: { text: string }) => void posts.push(text), get: async () => ({ location: { directory: "/tmp" } }) },
  };
  return { ctx, tools, commands, agents, posts };
}

describe("plugin", () => {
  test("registers its tools, commands and agents, and reports configuration errors instead of failing to load", async () => {
    const fake = fakeContext({ watchers: [{ app: "missing", environment: "prod" }] });
    const cleanup = await plugin.setup(fake.ctx as any);
    expect(fake.tools.map((t) => t.name).sort()).toEqual(["overwatch_query", "overwatch_report", "overwatch_status"]);
    expect(fake.tools.every((t) => t.options.codemode === false)).toBe(true);
    expect(fake.commands.map((c) => c.name).sort()).toEqual(["investigate", "overwatch", "overwatch-run"]);
    expect([...fake.agents.keys()].sort()).toEqual(["overwatch-fixer", "overwatch-investigator"]);
    expect(fake.agents.get("overwatch-investigator").system).toContain("Lead with the verdict");

    await fake.commands.find((c) => c.name === "overwatch").execute({ sessionID: "s", prompt: { text: "" } });
    expect(fake.posts[0]).toStartWith(SHOW);
    expect(fake.posts[0]).toContain("Configuration errors");
    expect(fake.posts[0]).toContain('watchers[0].app "missing" is not in apps');
    const investigate = fake.commands.find((c) => c.name === "investigate");
    await expect(investigate.execute({ sessionID: "s", prompt: { text: "" } })).rejects.toThrow("Paste the bug report after /investigate.");
    await expect(fake.commands.find((c) => c.name === "overwatch-run").execute({ sessionID: "s", prompt: { text: "" } })).rejects.toThrow("Fix the Overwatch configuration first");
    await (cleanup as () => Promise<void>)?.();
  });

  test("investigators are read-only: no edits, no kubectl or arbitrary shell, no web; their own tools allowed", () => {
    const rules = investigatorPermissions([]);
    expect(decide(rules, "read", "src/payments.ts")).toBe("allow");
    expect(decide(rules, "read", "config/.env")).toBe("deny");
    expect(decide(rules, "overwatch_query", "*")).toBe("allow");
    expect(decide(rules, "overwatch_report", "*")).toBe("allow");
    expect(decide(rules, "shell", "git log -5")).toBe("allow");
    expect(decide(rules, "shell", "git push origin main")).toBe("deny");
    expect(decide(rules, "shell", "kubectl delete pod x")).toBe("deny");
    expect(decide(rules, "shell", "curl https://example.invalid")).toBe("deny");
    expect(decide(rules, "edit", "src/payments.ts")).toBe("deny");
    expect(decide(rules, "webfetch", "https://example.invalid")).toBe("deny");
    expect(decide(rules, "external_directory", "/etc/*")).toBe("deny");
    expect(decide(rules, "question", "*")).toBe("deny");
  });

  test("fixers edit and run verify commands, but cannot commit, push, call gh or kubectl", () => {
    const rules = fixerPermissions(["bun test"], []);
    expect(decide(rules, "edit", "src/payments.ts")).toBe("allow");
    expect(decide(rules, "shell", "bun test")).toBe("allow");
    expect(decide(rules, "shell", "bun test payments")).toBe("allow");
    for (const command of ["git commit -am x", "git push origin HEAD", "gh pr create", "gh pr merge 1", "kubectl get pods", "rm -rf /"]) {
      expect(decide(rules, "shell", command)).toBe("deny");
    }
  });
});
