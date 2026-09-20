import fs from "node:fs/promises";
import path from "node:path";

try {
  process.loadEnvFile?.();
} catch { }

const NANO_GPT_URL = "https://nano-gpt.com/api/v1/chat/completions";

const str = { type: "string" };

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "readFullFile",
      description: "Read a text file inside the workspace root.",
      parameters: {
        type: "object",
        properties: { path: { ...str, description: "Relative file path, e.g. 'notes.txt'." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "editFile",
      description: "Create a file or replace old_text with new_text. Omit old_text to overwrite.",
      parameters: {
        type: "object",
        properties: {
          path: str,
          old_text: { ...str, description: "Exact snippet to replace." },
          new_text: { ...str, description: "Replacement or full file content." },
        },
        required: ["path", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listFiles",
      description: "List files in a workspace directory.",
      parameters: {
        type: "object",
        properties: { path: { ...str, description: "Directory, defaults to '.'." } },
      },
    },
  },
];

const MAX_BYTES = 500 * 1024;
const MAX_CHARS = 200 * 1000;

export class NiftyAgent {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.NANO_GPT_API_KEY || "";
    this.model = options.model || process.env.NANO_GPT_MODEL || "gpt-4o-mini";
    this.maxTurns = options.maxTurns ?? 10;
    this.maxHistoryMessages = options.maxHistoryMessages ?? 100;
    this.maxHistoryChars = options.maxHistoryChars ?? 200 * 1000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5 * 60 * 1000;
    this.verbose = options.verbose ?? true;
    this.onToolCall = options.onToolCall || null;
    this.onContent = options.onContent || null;
    this.onUsage = options.onUsage || null;
    this.workspaceDir = path.resolve(options.workspaceDir || process.cwd());
    this.systemPrompt = options.systemPrompt || this.getDefaultSystemPrompt();
    this.messages = [{ role: "system", content: this.systemPrompt }];
    this.totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0, cost: 0 };
    this._rootPromise = null;
  }

  getDefaultSystemPrompt() {
    return (
      `You are a helpful assistant named NiftyAgent (do not say you are anything else).\n` +
      `You have three file tools, all restricted to the folder the app was run from (${this.workspaceDir}):\n` +
      `- readFullFile: read an entire text file.\n` +
      `- editFile: edit a file (replace old_text with new_text, or write the whole file when old_text is omitted).\n` +
      `- listFiles: list files and directories.\n` +
      `All file paths must stay inside that folder — parent-directory traversal (..) and absolute paths outside it are rejected.\n` +
      `File editing rules:\n` +
      `- Try to avoid reading files unless you really need to for your task. (Don't re-read after edit or to check if someone else edited it)\n` +
      `- Use editFile to create or modify files.\n` +
      `- When replacing an entire file, provide the complete desired content in new_text.\n` +
      `- After a successful editFile call, do not rewrite the same file again unless the user's request requires additional changes or a correction.\n` +
      `- Do not reread the same file if you can avoid it.\n` +
      `- Once the user's request is satisfied, respond with a concise confirmation.\n` +
      `- Do not make speculative edits or rewrite content just to change its formatting.\n` +
      `Coding guidelines:\n` +
      `- Follow YAGNI and KISS principles.\n`
    );
  }

  getTools() {
    return TOOL_DEFINITIONS;
  }
  clearHistory() {
    this.messages = [{ role: "system", content: this.systemPrompt }];
  }
  getHistory() {
    return [...this.messages];
  }
  getTotalUsage() {
    return { ...this.totalUsage };
  }

  recordUsage(usage) {
    if (!usage || typeof usage !== "object") return null;
    const prompt_tokens = usage.prompt_tokens || usage.input_tokens || 0;
    const completion_tokens = usage.completion_tokens || usage.output_tokens || 0;
    const total_tokens = usage.total_tokens || prompt_tokens + completion_tokens;
    let cost = Number(usage.cost || usage.total_cost) || 0;
    if (cost <= 0 && Array.isArray(usage.costs))
      for (const c of usage.costs) {
        const n = Number(c);
        if (Number.isFinite(n)) cost += n;
      }
    Object.assign(this.totalUsage, {
      requests: this.totalUsage.requests + 1,
      prompt_tokens: this.totalUsage.prompt_tokens + prompt_tokens,
      completion_tokens: this.totalUsage.completion_tokens + completion_tokens,
      total_tokens: this.totalUsage.total_tokens + total_tokens,
      cost: this.totalUsage.cost + cost,
    });
    return { prompt_tokens, completion_tokens, total_tokens, cost };
  }

  formatCost(value) {
    const total = Number(value);
    if (!Number.isFinite(total) || total <= 0) return "";
    return "$" + (total < 0.01 ? total.toFixed(6) : total.toFixed(4));
  }

  logUsage() {
    if (!this.verbose) return;
    const t = this.totalUsage;
    const cost = this.formatCost(t.cost);
    console.log(
      `[Usage] ${t.requests} req | prompt: ${t.prompt_tokens} | completion: ${t.completion_tokens} | total: ${t.total_tokens}${cost ? ` | cost: ${cost}` : ""}`
    );
  }

  parseToolArgs(rawArgs) {
    if (rawArgs == null) return {};
    if (typeof rawArgs === "object")
      return Array.isArray(rawArgs) ? { __malformed: "Tool arguments must be a JSON object." } : rawArgs;
    try {
      const parsed = JSON.parse(rawArgs || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : { __malformed: "Tool arguments must be a JSON object." };
    } catch {
      return { __malformed: `Tool arguments are not valid JSON: ${rawArgs}` };
    }
  }

  getWorkspaceRoot() {
    return (this._rootPromise ??= fs.realpath(this.workspaceDir).catch(() => this.workspaceDir));
  }

  assertInside(root, p, input) {
    const rel = path.relative(root, p);
    if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || path.isAbsolute(rel)) {
      const err = new Error(
        `Path '${input}' is outside the allowed folder ('${this.workspaceDir}').`
      );
      err.code = "SANDBOX_BLOCKED";
      throw err;
    }
    return p;
  }

  // One realpath when the target exists, else one walk to the nearest existing parent.
  async resolveSafePath(filePath) {
    const root = await this.getWorkspaceRoot();
    const absolute = path.resolve(root, filePath || ".");
    this.assertInside(root, absolute, filePath);
    try {
      const real = await fs.realpath(absolute);
      this.assertInside(root, real, filePath);
      return real;
    } catch (err) {
      if (err?.code === "SANDBOX_BLOCKED") throw err;
    }
    const missing = [];
    let probe = absolute;
    while (probe !== root && probe !== path.dirname(probe)) {
      missing.push(path.basename(probe));
      probe = path.dirname(probe);
      try {
        const realParent = await fs.realpath(probe);
        this.assertInside(root, realParent, filePath);
        return path.join(realParent, ...missing.reverse());
      } catch (err) {
        if (err?.code === "SANDBOX_BLOCKED") throw err;
        // parent also missing — keep climbing
      }
    }
    return absolute;
  }

  async readFullFile(args) {
    const filePath = args.path || args.filePath || args.file;
    if (!filePath) return JSON.stringify({ error: "Missing required 'path' parameter" });
    let fullPath;
    try {
      fullPath = await this.resolveSafePath(filePath);
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
    try {
      const stats = await fs.stat(fullPath);
      if (stats.isDirectory())
        return JSON.stringify({ error: `'${filePath}' is a directory. Use listFiles.` });
      if (stats.size > MAX_BYTES)
        return JSON.stringify({ error: `File '${filePath}' is too large (${stats.size} bytes, limit ${MAX_BYTES}).` });
      let content = (await fs.readFile(fullPath, "utf-8")).replace(/\r\n/g, "\n");
      let truncated = false;
      if (content.length > MAX_CHARS) {
        content = content.slice(0, MAX_CHARS) + `\n\n[... truncated at ${MAX_CHARS} chars ...]`;
        truncated = true;
      }
      let totalLines = 1;
      for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) totalLines++;
      return JSON.stringify({ path: filePath, totalBytes: stats.size, totalLines, truncated, content });
    } catch (err) {
      return JSON.stringify({ error: `Failed to read '${filePath}': ${err.message}` });
    }
  }

  async editFile(args) {
    const filePath = args.path || args.filePath || args.file;
    const oldText = args.old_text ?? args.oldText ?? args.target;
    const newText = args.new_text ?? args.newText ?? args.content;
    if (!filePath) return JSON.stringify({ error: "Missing required 'path' parameter" });
    if (newText === undefined || newText === null)
      return JSON.stringify({ error: "Missing required 'new_text' parameter" });
    let fullPath;
    try {
      fullPath = await this.resolveSafePath(filePath);
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
    try {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      const newStr = String(newText).replace(/\r\n/g, "\n");
      if (newStr.length > MAX_CHARS)
        return JSON.stringify({ error: `new_text is too large (${newStr.length} chars, limit ${MAX_CHARS}).` });
      if (Buffer.byteLength(newStr, "utf-8") > MAX_BYTES)
        return JSON.stringify({ error: `new_text is too large (${Buffer.byteLength(newStr, "utf-8")} bytes, limit ${MAX_BYTES}).` });
      if (oldText !== undefined && oldText !== null && oldText !== "") {
        let fileContent;
        try {
          fileContent = await fs.readFile(fullPath, "utf-8");
        } catch (e) {
          return JSON.stringify({ error: `File '${filePath}' does not exist: ${e.message}` });
        }
        const normalized = fileContent.replace(/\r\n/g, "\n");
        const oldStr = String(oldText).replace(/\r\n/g, "\n");
        const idx = normalized.indexOf(oldStr);
        if (idx === -1)
          return JSON.stringify({ error: `old_text not found in '${filePath}'. Re-read and use an exact snippet.` });
        const extra = normalized.indexOf(oldStr, idx + oldStr.length) !== -1;
        // Map the normalized match back to original offsets so lone-\n and
        // mixed endings outside the replacement are preserved as-is.
        let origStart = 0;
        for (let n = 0; n < idx; n++) {
          if (fileContent.startsWith("\r\n", origStart)) origStart += 2;
          else origStart += 1;
        }
        let origEnd = origStart;
        for (let n = 0; n < oldStr.length; n++) {
          if (fileContent.startsWith("\r\n", origEnd)) origEnd += 2;
          else origEnd += 1;
        }
        const replacedSlice = fileContent.slice(origStart, origEnd);
        const replacement = replacedSlice.includes("\r\n") ? newStr.replace(/\n/g, "\r\n") : newStr;
        const updated = fileContent.slice(0, origStart) + replacement + fileContent.slice(origEnd);
        await fs.writeFile(fullPath, updated, "utf-8");
        return JSON.stringify({
          success: true,
          message: `Updated '${filePath}'.` + (extra ? " (other occurrences left unchanged)" : ""),
        });
      }
      await fs.writeFile(fullPath, newStr, "utf-8");
      return JSON.stringify({ success: true, message: `Wrote '${filePath}' (${stats(newStr)}).` });
    } catch (err) {
      return JSON.stringify({ error: `Failed to edit '${filePath}': ${err.message}` });
    }
  }

  async listFiles(args) {
    const dirPath = args?.path || ".";
    let fullPath;
    try {
      fullPath = await this.resolveSafePath(dirPath);
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
    try {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const out = entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
      out.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || (a.name < b.name ? -1 : 1));
      return JSON.stringify({ path: dirPath, count: out.length, entries: out });
    } catch (err) {
      return JSON.stringify({ error: `Failed to list '${dirPath}': ${err.message}` });
    }
  }

  executeTool(name, rawArgs) {
    const args = this.parseToolArgs(rawArgs);
    if (args.__malformed) return JSON.stringify({ error: args.__malformed });
    if (name === "readFullFile") return this.readFullFile(args);
    if (name === "editFile") return this.editFile(args);
    if (name === "listFiles") return this.listFiles(args);
    return JSON.stringify({ error: `Unknown tool '${name}'.` });
  }

  async callNanoGPT({ signal } = {}) {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const res = await fetch(NANO_GPT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, messages: this.messages, tools: this.getTools() }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`Nano-GPT API error (${res.status}): ${(await res.text()) || res.statusText}`);
    return res.json();
  }

  getHistorySize() {
    let chars = 0;
    for (const m of this.messages) {
      if (typeof m.content === "string") chars += m.content.length;
      else if (m.content != null) chars += JSON.stringify(m.content).length;
      if (Array.isArray(m.tool_calls))
        for (const tc of m.tool_calls)
          chars += (tc.function?.arguments?.length || 0) + (tc.function?.name?.length || 0);
    }
    return { messages: this.messages.length, chars };
  }

  assertHistoryFits(nextMessage) {
    const size = this.getHistorySize();
    const extraMessages = nextMessage === undefined ? 0 : 1;
    const extraChars =
      nextMessage === undefined
        ? 0
        : typeof nextMessage === "string"
          ? nextMessage.length
          : JSON.stringify(nextMessage).length;
    if (
      size.messages + extraMessages > this.maxHistoryMessages ||
      size.chars + extraChars > this.maxHistoryChars
    ) {
      const err = new Error(
        `Conversation history is too long (${size.messages} messages, ${size.chars} chars; ` +
        `limits: ${this.maxHistoryMessages} messages, ${this.maxHistoryChars} chars). ` +
        `Run /clear to reset conversation history and continue.`
      );
      err.code = "HISTORY_TOO_LONG";
      throw err;
    }
  }

  async sendMessage(userMessage, options = {}) {
    if (!this.apiKey)
      throw new Error("Nano-GPT API key is missing. Run: node niftyAgent.js YOUR_API_KEY MODEL_NAME (get a key at https://nano-gpt.com/r/qXBdP3HE).");
    this.assertHistoryFits(userMessage);
    const baseLength = this.messages.length;
    this.messages.push({ role: "user", content: userMessage });

    try {
      for (let turn = 1; turn <= this.maxTurns; turn++) {
        this.assertHistoryFits();
        if (this.verbose) console.log("=== LLM Model Request ===");
        const response = await this.callNanoGPT({ signal: options.signal });
        const message = response?.choices?.[0]?.message;
        if (!message) throw new Error("No choices returned from Nano-GPT API.");

        if (response?.usage) {
          const current = this.recordUsage(response.usage);
          try {
            this.onUsage?.(response.usage, { model: response.model || this.model, current, total: this.getTotalUsage() });
          } catch { }
        }
        this.logUsage();
        if (this.verbose) console.log("=== LLM Model Request Done === Turn:", turn);

        const assistantMsg = { role: "assistant", content: message.content ?? null };
        if (message.tool_calls?.length) assistantMsg.tool_calls = message.tool_calls;
        this.messages.push(assistantMsg);

        if (!message.tool_calls?.length) {
          try {
            this.onContent?.({ delta: message.content || "", full: message.content || "" });
          } catch { }
          return message.content || "";
        }

        for (const toolCall of message.tool_calls) {
          const toolName = toolCall.function?.name;
          const toolArgs = toolCall.function?.arguments;
          if (this.verbose) console.log(`[Tool Call] ${toolName}: ${toolArgs}`);
          let result;
          try {
            result = await this.executeTool(toolName, toolArgs);
          } catch (err) {
            result = JSON.stringify({ error: err.message || String(err) });
          }
          try {
            this.onToolCall?.({ name: toolName, arguments: toolArgs, result });
          } catch { }
          this.messages.push({ role: "tool", tool_call_id: toolCall.id, content: String(result) });
        }
      }
      throw new Error(`Exceeded maximum agent turns (${this.maxTurns}).`);
    } catch (err) {
      this.messages.length = baseLength;
      throw err;
    }
  }

  chat(userMessage, options = {}) {
    return this.sendMessage(userMessage, options);
  }
}

function stats(s) {
  return `${Buffer.byteLength(s, "utf8")} bytes`;
}

// CLI only when run directly — importing the file has no side effects.
// Usage: node niftyAgent.js YOUR_API_KEY MODEL_NAME
if (process.argv[1]?.endsWith("niftyAgent.js")) {
  const { createInterface } = await import("node:readline/promises");
  const { stdin: input, stdout: output } = await import("node:process");
  console.log(`
  _   _ _  __ _            _                    _   
 | \\ | (_)/ _| |_ _   _   / \\   __ _  ___ _ __ | |_ 
 |  \\| | | |_| __| | | | / _ \\ / _\` |/ _ \\ '_ \\| __|
 | |\\  | |  _| |_| |_| |/ ___ \\ (_| |  __/ | | | |_ 
 |_| \\_|_|_|  \\__|\\__, /_/   \\_\\__, |\\___|_| |_|\\__|
                  |___/        |___/                
        `);
  const cliApiKey = process.argv[2];
  const cliModel = process.argv[3];
  if (cliApiKey === "--help" || cliApiKey === "-h") {
    console.log("Usage: node niftyAgent.js YOUR_API_KEY MODEL_NAME");
    console.log("Get a key at https://nano-gpt.com/r/qXBdP3HE — models include Muse Spark, Deepseek, GPT 5.6.");
    process.exit(0);
  }
  const agent = new NiftyAgent({
    ...(cliApiKey ? { apiKey: cliApiKey } : {}),
    ...(cliModel ? { model: cliModel } : {}),
  });
  console.log(`Model: ${agent.model} (provider: Nano-GPT)`);
  if (!agent.apiKey) {
    console.warn("Notice: Nano-GPT API key is not set. Usage: node niftyAgent.js YOUR_API_KEY MODEL_NAME\nGet a key at https://nano-gpt.com/r/qXBdP3HE\n");
  }
  try {
    const rl = createInterface({ input, output });
    try {
      while (true) {
        const inputText = await rl.question("> ");
        const trimmed = inputText?.trim();
        if (!trimmed) continue;
        const lower = trimmed.toLowerCase();
        if (lower === "exit" || lower === "quit") break;
        if (lower === "/clear" || lower === "/reset") {
          agent.clearHistory();
          console.log("Conversation history cleared.\n");
          continue;
        }
        try {
          console.log(await agent.sendMessage(trimmed));
        } catch (err) {
          console.error(`[Agent Error] ${err.message || err}`);
        }
      }
    } finally {
      rl.close();
    }
  } catch (err) {
    console.error(`[Agent Error] ${err.message || err}`);
  }
  console.log("Goodbye!");
}