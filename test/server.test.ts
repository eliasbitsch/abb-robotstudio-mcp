// The server as a client sees it: the operating notes arrive with the initialize result, and
// the notes and the README name only tools that exist (and the README names all of them).
// Nothing here touches a controller or the add-in; listing tools makes no calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BridgeClient } from "../src/bridge-client.js";
import { loadConfig } from "../src/config.js";
import { INSTRUCTIONS } from "../src/instructions.js";
import { RwsClient } from "../src/rws-client.js";
import { createServer } from "../src/server.js";

// build-test/test/server.test.js -> the package root
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

function toolNamesIn(text: string): Set<string> {
  return new Set(text.match(/\brw?s_[a-z_]*[a-z]/g) ?? []);
}

async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const cfg = loadConfig();
  const server = createServer(new BridgeClient(cfg), new RwsClient(cfg));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test("a client receives the operating notes on connect", async () => {
  const { client, close } = await connect();
  try {
    assert.equal(client.getInstructions(), INSTRUCTIONS);
    assert.ok(INSTRUCTIONS.length > 1000, "the notes are there, not a stub");
    assert.ok(INSTRUCTIONS.length < 8000, "the notes stay short enough to sit in a client's context");
    assert.equal(/[^\x00-\x7f]/.test(INSTRUCTIONS), false, "plain ASCII");
  } finally {
    await close();
  }
});

test("the notes and the README name only real tools, and the README names every tool", async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    const registered = new Set(tools.map((t) => t.name));
    assert.ok(registered.size > 60);

    const inNotes = toolNamesIn(INSTRUCTIONS);
    assert.ok(inNotes.size >= 15, "the notes refer to the tools by name");
    for (const name of inNotes) assert.ok(registered.has(name), `the notes name '${name}', which is not a tool`);

    const inReadme = toolNamesIn(readme);
    for (const name of inReadme) assert.ok(registered.has(name), `README names '${name}', which is not a tool`);
    for (const name of registered) assert.ok(inReadme.has(name), `README does not mention the tool '${name}'`);
  } finally {
    await close();
  }
});
