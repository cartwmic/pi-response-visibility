#!/usr/bin/env node
// Black-box proof for Pi builds that ship dist/bundle: drive the bundled CLI in print mode
// against a scripted backend and record bridge events through a probe extension.
// Usage: node tests/bundle-cli-proof.mjs <absolute private pi-coding-agent root> <label> [http|codex]
import { createServer } from "node:http";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const probe = fileURLToPath(new URL("./fixtures/bridge-probe.ts", import.meta.url));
const [pca, label, mode] = process.argv.slice(2);
const codexEvents=[{type:"response.created",response:{id:"f",status:"in_progress",output:[]}},{type:"response.output_item.added",output_index:0,item:{type:"message",id:"m",role:"assistant",content:[]}},{type:"response.content_part.added",output_index:0,content_index:0,part:{type:"output_text",text:"",annotations:[]}},{type:"response.output_text.delta",output_index:0,content_index:0,delta:"CODEX_PROOF_COMPLETE"},{type:"response.completed",response:{id:"f",status:"completed",output:[],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
let requests = 0;
const server = createServer((req, res) => { req.resume(); req.on("end", () => {
  requests++;if(mode==="codex"){res.writeHead(200,{"content-type":"text/event-stream"});for(const e of codexEvents)res.write("data: "+JSON.stringify(e)+"\n\n");return res.end();}
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [delta, finish] of [[{ role: "assistant", content: "HTTP_PROOF_COMPLETE" }, null], [{}, "stop"]])
    res.write("data: " + JSON.stringify({ id: "f", object: "chat.completion.chunk", created: 1, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n");
  res.end("data: [DONE]\n\n");
}); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const home = mkdtempSync(join(tmpdir(), "rv-home-")), agent = join(home, "agent"); mkdirSync(agent, { recursive: true });
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { "http-proof": { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: mode==="codex"?"openai-codex-responses":"openai-completions", apiKey: mode==="codex"?"dummy."+Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:"dummy"}})).toString("base64url")+".dummy":"dummy", models: [{ id: "scripted" }] } } }));
const out = join(home, "events.jsonl"); writeFileSync(out, "");
const child = spawn(process.execPath, [join(pca, "dist/bundle/cli.js"), "-p", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session", "--no-tools", "-e", probe, "--provider", "http-proof", "--model", "scripted", "say hi"], { env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, RV_PROBE_OUT: out }, stdio: ["ignore", "pipe", "pipe"] });
let stdout = "", stderr = ""; child.stdout.on("data", d => stdout += d); child.stderr.on("data", d => stderr += d);
const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
const code = await new Promise(r => child.on("exit", r)); clearTimeout(timer); server.close();
const events = readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const summary = {}; for (const e of events.slice(1)) { const k = [e.kind, e.phase ?? e.stage ?? "", e.transport ?? ""].join(":"); summary[k] = (summary[k] ?? 0) + 1; }
console.log(JSON.stringify({ label, exit: code, requests, reply: stdout.trim(), bridge: events[0]?.bridge, events: summary, stderr: stderr.slice(-300) }));
