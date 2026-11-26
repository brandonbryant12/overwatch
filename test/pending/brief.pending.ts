import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../harness.ts";
import { testService, seed, recordFinding, delay } from "../fixtures/scenario.ts";
import { laptop } from "./cli.ts";

test("a glossary brief is journal-derived, period-bound, repeatable and owner-editable offline; copy and export preserve the edit", async () => {
  const outbound: string[] = [];
  const f = await testService({
    deps: {
      fetch: async (input) => {
        outbound.push(String(input));
        throw Error("fixture forbids outbound delivery");
      },
      notify: async () => {},
    },
  });
  try {
    const local = join(f.dataDir, "local");
    const cli = laptop({ dataDir: f.dataDir, localDir: local, service: { port: Number(new URL(f.service.url).port) } });
    const audit = join(cli.home, "delivery-attempts.txt"),
      guard = join(cli.home, "offline.cjs");
    // Observe fetch in the separate CLI process too. Its ordinary loopback service call is allowed.
    writeFileSync(
      guard,
      `
      const {appendFileSync}=require("node:fs");
      const original=globalThis.fetch;
      globalThis.fetch=async (input,options)=>{
        const url=new URL(input.url??input);
        if(url.origin!==process.env.FIXTURE_SERVICE){
          appendFileSync(process.env.FIXTURE_DELIVERY_LOG,url.origin+"\\n");
          throw Error("Brief tried an external delivery");
        }
        return original(input,options);
      };
    `,
    );
    cli.env.NODE_OPTIONS = "--require=" + JSON.stringify(guard);
    cli.env.FIXTURE_SERVICE = f.service.url;
    cli.env.FIXTURE_DELIVERY_LOG = audit;
    mkdirSync(join(local, "glossaries"), { recursive: true });
    const glossary = join(local, "glossaries", "shop-api.json");
    writeFileSync(join(local, "glossaries", "other.json"), JSON.stringify({ "shop-api": "an unrelated product" }));
    writeFileSync(glossary, JSON.stringify({ "shop-api": "checkout", "/v2/authorize": "paying by card" }));
    const id = await seed(f);
    await recordFinding(f, id, "Last month's isolated backlog", "run_before");
    await delay(20);
    const from = new Date().toISOString();
    await delay(20);
    await recordFinding(f, id, "shop-api failed while calling /v2/authorize", "run_period");
    await delay(20);
    const to = new Date().toISOString();
    await delay(20);
    await recordFinding(f, id, "After-period hardware repair", "run_after");
    const args = ["brief", "build", "--app", "shop-api", "--from", from, "--to", to, "--json"];
    const build = async () => {
      const r = await cli.run(args);
      expect(r.code).toBe(0);
      return JSON.parse(r.stdout) as { id: string; text: string };
    };
    const first = await build();
    expect(first.text).toContain("checkout");
    expect(first.text).toContain("paying by card");
    for (const excluded of ["shop-api", "/v2/authorize", "isolated backlog", "hardware repair", "an unrelated product"])
      expect(first.text).not.toContain(excluded);
    expect(await build()).toEqual(first);
    args[args.indexOf("--to") + 1] = new Date(Date.now() + 60_000).toISOString();
    const active = await build();
    const edited = "Card payments are available again.\nOwner verified.";
    expect((await cli.run(["brief", "edit", active.id, "--text", edited])).code).toBe(0);
    await recordFinding(f, id, "A new eligible event after the owner edited the brief", "run_late");
    expect((await build()).text).toBe(edited);
    const file = join(cli.home, "brief.txt");
    expect((await cli.run(["brief", "export", active.id, "--out", file])).code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(edited);
    const bin = join(cli.home, "bin");
    mkdirSync(bin);
    const clip = join(cli.home, "clipboard");
    cli.env.FIXTURE_CLIPBOARD = clip;
    writeFileSync(join(bin, "pbcopy"), '#!/bin/sh\n/bin/cat > "$FIXTURE_CLIPBOARD"\n', { mode: 0o755 });
    cli.env.PATH = bin + ":" + cli.env.PATH;
    expect((await cli.run(["brief", "copy", active.id])).code).toBe(0);
    expect(readFileSync(clip, "utf8")).toBe(edited);
    expect(outbound).toEqual([]);
    expect(existsSync(audit)).toBe(false);
  } finally {
    await f.service.stop();
  }
});
