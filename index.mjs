// src/util.ts
import { createHash } from "crypto";
function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    const record = value;
    const sorted = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJsonValue(record[key]);
    }
    return sorted;
  }
  return value;
}
function canonicalize(argumentsValue) {
  return JSON.stringify(sortJsonValue(argumentsValue));
}
function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`);
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`);
}
function extractText(blocks) {
  let text = "";
  for (const block of blocks) {
    if (block.type === "text") text += block.text;
  }
  return text.trim().replace(/\s+/g, " ");
}
function hashText(text) {
  return createHash("sha1").update(text).digest("hex");
}
function previewArguments(canonical, cap) {
  if (canonical.length <= cap) return canonical;
  return `${canonical.slice(0, cap)}\u2026(+${canonical.length - cap} chars)`;
}
function assertConfigPair(plugin, label, remindAt, askAt) {
  if (!Number.isInteger(remindAt) || remindAt < 2) {
    throw new Error(`${plugin}: ${label}.remindAt \u5FC5\u987B\u662F \u22652 \u7684\u6574\u6570\uFF08\u5F53\u524D ${remindAt}\uFF09`);
  }
  if (!Number.isInteger(askAt) || askAt < 3) {
    throw new Error(`${plugin}: ${label}.askAt \u5FC5\u987B\u662F \u22653 \u7684\u6574\u6570\uFF08\u5F53\u524D ${askAt}\uFF09`);
  }
  if (askAt <= remindAt) {
    throw new Error(`${plugin}: ${label}.askAt\uFF08${askAt}\uFF09\u5FC5\u987B\u5927\u4E8E remindAt\uFF08${remindAt}\uFF09`);
  }
}

// src/detectors/exploration.ts
var fresh = () => ({
  run: 0,
  toolSinceLastStep: false,
  textSinceLastStep: false,
  lastTextLen: 0
});
var ExplorationDetector = class {
  constructor(options) {
    this.options = options;
    this.includePatterns = options.include.map(wildcardToRegExp);
    this.excludePatterns = options.exclude.map(wildcardToRegExp);
  }
  options;
  kind = "exploration";
  states = /* @__PURE__ */ new WeakMap();
  includePatterns;
  excludePatterns;
  /** 工具是否计入“工具步”（默认全部计入） */
  tracked(name2) {
    if (this.includePatterns.length > 0 && !this.includePatterns.some((pattern) => pattern.test(name2))) return false;
    return !this.excludePatterns.some((pattern) => pattern.test(name2));
  }
  observe(event) {
    if (this.options.enabled === false) return void 0;
    const { agent } = event;
    const state = this.states.get(agent) ?? fresh();
    if (event.toolCall) {
      if (this.tracked(event.toolCall.name)) state.toolSinceLastStep = true;
      this.states.set(agent, state);
      return void 0;
    }
    if (event.assistantText !== void 0) {
      state.textSinceLastStep = true;
      state.lastTextLen = event.assistantText.length;
      this.states.set(agent, state);
      return void 0;
    }
    if (!event.step) return void 0;
    if (event.step.hasUserMessage) {
      this.states.delete(agent);
      return void 0;
    }
    const hadTool = state.toolSinceLastStep;
    const textLen = state.textSinceLastStep ? state.lastTextLen : 0;
    state.toolSinceLastStep = false;
    state.textSinceLastStep = false;
    state.lastTextLen = 0;
    if (!hadTool || textLen >= this.options.resetAfterChars) {
      state.run = 0;
    } else {
      state.run += 1;
    }
    this.states.set(agent, state);
    if (state.run >= this.options.askAt) return { kind: this.kind, count: state.run, ask: true };
    if (state.run === this.options.remindAt) return { kind: this.kind, count: state.run, ask: false };
    return void 0;
  }
  reset(agent) {
    this.states.delete(agent);
  }
  snapshot(agent) {
    const state = this.states.get(agent);
    return state === void 0 ? {} : { run: state.run };
  }
  restore(agent, data) {
    const run = typeof data.run === "number" && data.run >= 0 ? data.run : 0;
    this.states.set(agent, { run, toolSinceLastStep: false, textSinceLastStep: false, lastTextLen: 0 });
  }
};

// src/detectors/stagnation.ts
var fresh2 = () => ({ count: 0, lastHash: null, prevHash: null, toolSinceLastStep: false });
var StagnationDetector = class {
  constructor(options) {
    this.options = options;
  }
  options;
  kind = "stagnant";
  states = /* @__PURE__ */ new WeakMap();
  observe(event) {
    const { agent } = event;
    const state = this.states.get(agent) ?? fresh2();
    if (event.toolCall) {
      state.toolSinceLastStep = true;
      this.states.set(agent, state);
      return void 0;
    }
    if (event.assistantText !== void 0) {
      state.lastHash = hashText(event.assistantText);
      this.states.set(agent, state);
      return void 0;
    }
    if (!event.step) return void 0;
    if (event.step.hasUserMessage) {
      this.states.delete(agent);
      return void 0;
    }
    const hadTool = state.toolSinceLastStep;
    state.toolSinceLastStep = false;
    if (hadTool) {
      state.count = 0;
    } else {
      const same = state.lastHash !== null && state.lastHash === state.prevHash;
      state.count = same ? state.count + 1 : 0;
    }
    state.prevHash = state.lastHash;
    this.states.set(agent, state);
    if (state.count >= this.options.askAt) return { kind: this.kind, count: state.count, ask: true };
    if (state.count === this.options.remindAt) return { kind: this.kind, count: state.count, ask: false };
    return void 0;
  }
  reset(agent) {
    this.states.delete(agent);
  }
  snapshot(agent) {
    const state = this.states.get(agent);
    return state === void 0 ? {} : { count: state.count, lastHash: state.lastHash ?? void 0, prevHash: state.prevHash ?? void 0 };
  }
  restore(agent, data) {
    const count = typeof data.count === "number" && data.count >= 0 ? data.count : 0;
    const lastHash = typeof data.lastHash === "string" ? data.lastHash : null;
    const prevHash = typeof data.prevHash === "string" ? data.prevHash : null;
    this.states.set(agent, { count, lastHash, prevHash, toolSinceLastStep: false });
  }
};

// src/detectors/struct-repeat.ts
var StructRepeatDetector = class {
  constructor(options) {
    this.options = options;
    this.includePatterns = options.include.map(wildcardToRegExp);
    this.excludePatterns = options.exclude.map(wildcardToRegExp);
  }
  options;
  kind = "structRepeat";
  chains = /* @__PURE__ */ new WeakMap();
  includePatterns;
  excludePatterns;
  /** 工具是否参与链计数 */
  tracked(name2) {
    if (this.includePatterns.length > 0 && !this.includePatterns.some((pattern) => pattern.test(name2))) return false;
    return !this.excludePatterns.some((pattern) => pattern.test(name2));
  }
  observe(event) {
    const { agent, toolCall } = event;
    if (!toolCall) return void 0;
    if (!this.tracked(toolCall.name)) return void 0;
    const key = JSON.stringify([toolCall.name, toolCall.canonical]);
    const chain = this.chains.get(agent);
    const count = chain !== void 0 && chain.key === key ? chain.count + 1 : 1;
    this.chains.set(agent, { key, count });
    const { remindAt, askAt, remindInterval } = this.options;
    if (count >= askAt) {
      return { kind: this.kind, count, ask: true, toolName: toolCall.name, toolPreview: toolCall.preview };
    }
    if (count >= remindAt && (count - remindAt) % remindInterval === 0) {
      return { kind: this.kind, count, ask: false, toolName: toolCall.name, toolPreview: toolCall.preview };
    }
    return void 0;
  }
  reset(agent) {
    this.chains.delete(agent);
  }
  snapshot(agent) {
    const chain = this.chains.get(agent);
    return chain === void 0 ? {} : { key: chain.key, count: chain.count };
  }
  restore(agent, data) {
    if (typeof data.key === "string" && typeof data.count === "number" && data.count >= 1) {
      this.chains.set(agent, { key: data.key, count: data.count });
    }
  }
};

// src/summary.ts
function buildSummary(hit, steps, recent) {
  const type = hit.kind === "structRepeat" ? "\u7ED3\u6784\u91CD\u590D\uFF08\u76F8\u540C\u5DE5\u5177 + \u76F8\u540C\u53C2\u6570\uFF09" : "\u8FDB\u5EA6\u505C\u6EDE\uFF08\u65E0\u65B0\u5DE5\u5177\u8C03\u7528\u4E14\u8F93\u51FA\u672A\u53D8\u5316\uFF09";
  const trigger = hit.kind === "structRepeat" && hit.toolName ? `
\u89E6\u53D1\u5DE5\u5177\uFF1A${hit.toolName}\uFF08\u8FDE\u7EED ${hit.count} \u6B21\uFF09` : `
\u505C\u6EDE\u6B65\u6570\uFF1A${hit.count}`;
  const recentText = recent.length > 0 ? recent.map((record) => `${record.name}(${record.preview.slice(0, 40)})`).join("\uFF1B") : "\uFF08\u65E0\uFF09";
  const text = `\u5FAA\u73AF\u7C7B\u578B\uFF1A${type}${trigger}
\u5DF2\u6267\u884C\u6B65\u9AA4\uFF1A\u7EA6 ${steps} \u6B65
\u6700\u8FD1\u5DE5\u5177\u8C03\u7528\uFF1A${recentText}`;
  return text.length <= 200 ? text : `${text.slice(0, 197)}\u2026`;
}

// src/breaker.ts
var Breaker = class {
  constructor(detectors, options, persister) {
    this.options = options;
    this.persister = persister;
    this.detectorList = [...detectors];
  }
  options;
  persister;
  states = /* @__PURE__ */ new WeakMap();
  /** 内部可变检测器列表（支持运行时注册自定义检测器） */
  detectorList;
  /** 运行时注册自定义检测器（须在首次观察前注册） */
  register(detector) {
    this.detectorList.push(detector);
  }
  get detectors() {
    return this.detectorList;
  }
  state(agent) {
    let state = this.states.get(agent);
    if (!state) {
      state = { hydrated: false, steps: 0, grace: 0, recent: [] };
      this.states.set(agent, state);
    }
    return state;
  }
  /** 观察一次工具调用（tools/post-execute），返回命中 */
  observeTool(agent, name2, args) {
    const state = this.state(agent);
    const canonical = canonicalize(args);
    const preview = previewArguments(canonical, this.options.argumentsPreviewChars);
    state.recent = [...state.recent, { name: name2, canonical, preview }].slice(-this.options.maxRecentCalls);
    for (const detector of this.detectors) {
      const hit = detector.observe({ agent, toolCall: { name: name2, canonical, preview } });
      if (hit) return hit;
    }
    return void 0;
  }
  /**
   * 步边界（agent/pre-step）：首次懒加载持久化状态；人类输入重置检测链；
   * 宽限期内免检测；否则结算检测器并返回命中。
   */
  async prepareStep(agent, hasUserMessage, turn, step) {
    const state = this.state(agent);
    if (!state.hydrated) {
      state.hydrated = true;
      await this.hydrate(agent, state);
    }
    if (hasUserMessage) {
      for (const detector of this.detectors) detector.reset(agent);
    }
    if (state.grace > 0) {
      state.grace -= 1;
      return void 0;
    }
    state.steps += 1;
    for (const detector of this.detectors) {
      const hit = detector.observe({ agent, step: { turn, step, hasUserMessage } });
      if (hit) return hit;
    }
    return void 0;
  }
  /** 观察 assistant 可见文本（session/event 的 assistant/message，已规范化） */
  observeAssistantText(agent, text) {
    this.state(agent);
    for (const detector of this.detectors) {
      detector.observe({ agent, assistantText: text });
    }
  }
  /** 问人后进入恢复期：重置检测链并给予宽限步数，避免立即误判 */
  markRecovering(agent) {
    const state = this.state(agent);
    state.grace = this.options.graceSteps;
    for (const detector of this.detectors) detector.reset(agent);
  }
  buildSummary(hit, agent) {
    const state = this.state(agent);
    return buildSummary(hit, state.steps, state.recent);
  }
  /** 持久化当前检测状态（best-effort，失败静默） */
  save(agent) {
    const sessionId = String(agent.session.id);
    const state = this.state(agent);
    const snapshot = {
      sessionId,
      at: Date.now(),
      detectors: Object.fromEntries(this.detectors.map((detector) => [detector.kind, detector.snapshot(agent)])),
      steps: state.steps,
      recentCalls: state.recent
    };
    void this.persister.save(snapshot).catch(() => {
    });
  }
  async hydrate(agent, state) {
    const sessionId = String(agent.session.id);
    let snapshot;
    try {
      snapshot = await this.persister.load(sessionId);
    } catch {
      return;
    }
    if (!snapshot) return;
    for (const detector of this.detectors) {
      const data = snapshot.detectors[detector.kind];
      if (data) detector.restore(agent, data);
    }
    state.steps = snapshot.steps;
    state.recent = [...snapshot.recentCalls];
  }
};

// src/persister.ts
import { appendFile, mkdir, readFile } from "fs/promises";
import { dirname } from "path";
var MemoryPersister = class {
  map = /* @__PURE__ */ new Map();
  async save(snapshot) {
    this.map.set(snapshot.sessionId, snapshot);
  }
  async load(sessionId) {
    return this.map.get(sessionId);
  }
};
var JsonlPersister = class {
  constructor(file) {
    this.file = file;
  }
  file;
  async save(snapshot) {
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, JSON.stringify(snapshot) + "\n", "utf8");
  }
  async load(sessionId) {
    let content;
    try {
      content = await readFile(this.file, "utf8");
    } catch {
      return void 0;
    }
    let found;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.sessionId === sessionId) found = parsed;
      } catch {
      }
    }
    return found;
  }
};

// src/interactor.ts
var QUESTION_ID = "thinking-breaker";
var OPTION_LABELS = ["\u8865\u5145\u4FE1\u606F", "\u7EE7\u7EED\u4EFB\u52A1", "\u7EC8\u6B62\u4EFB\u52A1", "\u8C03\u6574\u65B9\u5411", "\u81EA\u5B9A\u4E49"];
var OPTION_DESCRIPTIONS = {
  "\u8865\u5145\u4FE1\u606F": "\u7ED9 Agent \u63D0\u4F9B\u989D\u5916\u80CC\u666F\u6216\u6570\u636E\u540E\u7EE7\u7EED",
  "\u7EE7\u7EED\u4EFB\u52A1": "\u8BA4\u4E3A\u5F53\u524D\u5FAA\u73AF\u5408\u7406\uFF0C\u7EE7\u7EED\u6267\u884C",
  "\u7EC8\u6B62\u4EFB\u52A1": "\u505C\u6B62\u672C\u6B21\u4EFB\u52A1\u5E76\u8FD4\u56DE\u9636\u6BB5\u6027\u7ED3\u8BBA",
  "\u8C03\u6574\u65B9\u5411": "\u7ED9\u51FA\u65B0\u601D\u8DEF\u6216\u4FEE\u6539\u76EE\u6807",
  "\u81EA\u5B9A\u4E49": "\u8F93\u5165\u4EFB\u4F55\u4F60\u60F3\u6DFB\u52A0\u7684\u6307\u4EE4"
};
function errorCode(error) {
  if (typeof error === "object" && error !== null && typeof error.code === "string") {
    return error.code;
  }
  return void 0;
}
async function askUser(ctx, agent, summary, timeoutSeconds, outerSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutSeconds * 1e3);
  timer.unref?.();
  const onOuterAbort = () => controller.abort();
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const answer = await ctx.userQuestions.ask({
      agent,
      signal: controller.signal,
      questions: [{
        id: QUESTION_ID,
        header: "\u5FAA\u73AF\u68C0\u6D4B\u5E72\u9884",
        question: "\u68C0\u6D4B\u5230 Agent \u53EF\u80FD\u9677\u5165\u5FAA\u73AF\uFF0C\u8BF7\u9009\u62E9\u540E\u7EED\u64CD\u4F5C\uFF1A",
        detail: summary,
        options: OPTION_LABELS.map((label2) => ({ label: label2, description: OPTION_DESCRIPTIONS[label2] }))
      }]
    });
    const item = answer.answers.find((entry) => entry.id === QUESTION_ID);
    const label = item?.selected[0];
    if (!label) return { kind: "cancelled" };
    return { kind: "choice", label, custom: item.custom };
  } catch (error) {
    const code = errorCode(error);
    if (code === "ASK_ABORTED") {
      return timedOut ? { kind: "timeout" } : { kind: "cancelled" };
    }
    return { kind: "degraded", code: code ?? "UNKNOWN" };
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

// src/messages.ts
import { randomUUID } from "crypto";
var PLUGIN_SOURCE = { kind: "plugin", plugin: "thinking-breaker" };
function createUserMessage(input) {
  return {
    role: "user",
    content: [...input.content],
    source: input.source,
    id: randomUUID()
  };
}
function boundContextSummary(text, limit = 120) {
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}\u2026`;
}
function buildReminder(hit) {
  let text;
  if (hit.kind === "structRepeat") {
    const preview = hit.toolPreview ? `
\u91CD\u590D\u53C2\u6570\uFF1A${hit.toolPreview}` : "";
    text = `\u26A0\uFE0F \u5FAA\u73AF\u63D0\u9192\uFF1A\u5DF2\u8FDE\u7EED ${hit.count} \u6B21\u8C03\u7528\u5DE5\u5177\u300C${hit.toolName}\u300D\u4E14\u53C2\u6570\u5B8C\u5168\u4E00\u81F4\u3002\u8BF7\u5148\u5206\u6790\u5DF2\u6709\u7ED3\u679C\uFF1B\u82E5\u4EFB\u52A1\u5C1A\u672A\u5B8C\u6210\uFF0C\u5C1D\u8BD5\u4E0D\u540C\u7684\u53C2\u6570\u6216\u4E0D\u540C\u7684\u65B9\u6848\uFF0C\u800C\u4E0D\u662F\u539F\u6837\u91CD\u590D\u8C03\u7528\u3002${preview}`;
  } else if (hit.kind === "stagnant") {
    text = `\u26A0\uFE0F \u505C\u6EDE\u63D0\u9192\uFF1A\u5DF2\u8FDE\u7EED ${hit.count} \u6B65\u6CA1\u6709\u65B0\u7684\u5DE5\u5177\u8C03\u7528\u4E14\u8F93\u51FA\u6CA1\u6709\u53D8\u5316\u3002\u8BF7\u7ACB\u5373\u91C7\u53D6\u5177\u4F53\u884C\u52A8\u63A8\u8FDB\u4EFB\u52A1\uFF0C\u907F\u514D\u7A7A\u8F6C\u3002`;
  } else if (hit.kind === "exploration") {
    text = `\u26A0\uFE0F \u63A2\u7D22\u63D0\u9192\uFF1A\u5DF2\u8FDE\u7EED ${hit.count} \u6B65\u81EA\u4E3B\u52D8\u5BDF\uFF08\u9759\u9ED8\u5DE5\u5177\u8C03\u7528\uFF09\u4E14\u6CA1\u6709\u9636\u6BB5\u6027\u957F\u6587\u6C47\u62A5\u3002\u82E5\u5C1A\u65E0\u660E\u786E\u7ED3\u8BBA\uFF0C\u8003\u8651\u4E3B\u52A8\u5411\u7528\u6237\u6C47\u62A5\u9636\u6BB5\u6027\u8FDB\u5C55\u6216\u8BE2\u95EE\u65B9\u5411\uFF0C\u4E0D\u8981\u7EE7\u7EED\u76F2\u76EE\u6269\u5927\u6392\u67E5\u8303\u56F4\u3002`;
  } else {
    text = `\u26A0\uFE0F \u5FAA\u73AF\u63D0\u9192\uFF1A\u68C0\u6D4B\u5668\u300C${hit.kind}\u300D\u8FDE\u7EED\u547D\u4E2D ${hit.count} \u6B21\u3002\u8BF7\u68C0\u67E5\u5F53\u524D\u6267\u884C\u662F\u5426\u9677\u5165\u91CD\u590D\uFF0C\u5C1D\u8BD5\u4E0D\u540C\u7684\u65B9\u6CD5\u63A8\u8FDB\u4EFB\u52A1\u3002`;
  }
  return createUserMessage({
    content: [{ type: "text", text }],
    source: {
      ...PLUGIN_SOURCE,
      form: "notice",
      summary: boundContextSummary(`${hit.kind} \xD7 ${hit.count}`)
    }
  });
}
function buildInstruction(label, custom) {
  const intro = {
    "\u8865\u5145\u4FE1\u606F": "\u7528\u6237\u8865\u5145\u4E86\u4EE5\u4E0B\u4FE1\u606F\uFF0C\u8BF7\u7ED3\u5408\u8FD9\u4E9B\u4FE1\u606F\u7EE7\u7EED\u6267\u884C\u4EFB\u52A1\uFF1A",
    "\u8C03\u6574\u65B9\u5411": "\u7528\u6237\u8981\u6C42\u8C03\u6574\u65B9\u5411\uFF0C\u8BF7\u6309\u4EE5\u4E0B\u65B0\u601D\u8DEF\u7EE7\u7EED\u6267\u884C\u4EFB\u52A1\uFF1A",
    "\u81EA\u5B9A\u4E49": "\u7528\u6237\u7ED9\u51FA\u4EE5\u4E0B\u6307\u4EE4\uFF0C\u8BF7\u9075\u7167\u6267\u884C\uFF1A"
  };
  const head = intro[label] ?? "\u7528\u6237\u7ED9\u51FA\u4EE5\u4E0B\u6307\u4EE4\uFF0C\u8BF7\u9075\u7167\u6267\u884C\uFF1A";
  const text = custom ? `${head}
${custom}` : head;
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { ...PLUGIN_SOURCE, form: "instructions" }
  });
}

// src/recover.ts
function resolveOutcome(agent, outcome, noAnswerer, log) {
  if (outcome.kind === "timeout") {
    log("\u7528\u6237\u8D85\u65F6\u672A\u56DE\u590D\uFF0CAgent \u7EE7\u7EED\u8FD0\u884C");
    return { action: "continue" };
  }
  if (outcome.kind === "cancelled") {
    log("\u95EE\u4EBA\u7B49\u5F85\u88AB\u53D6\u6D88\uFF0CAgent \u7EE7\u7EED\u8FD0\u884C");
    return { action: "continue" };
  }
  if (outcome.kind === "degraded") {
    if (noAnswerer === "cancel") {
      agent.cancel({ kind: "hook", reason: `thinking-breaker: \u65E0\u53EF\u7528\u7528\u6237\u754C\u9762\uFF08${outcome.code}\uFF09\uFF0C\u6309\u914D\u7F6E\u7EC8\u6B62` });
      log("\u65E0\u53EF\u7528\u7528\u6237\u754C\u9762\uFF0C\u6309\u914D\u7F6E\u7EC8\u6B62 Agent", { code: outcome.code });
      return { action: "cancel" };
    }
    log("\u65E0\u53EF\u7528\u7528\u6237\u754C\u9762\uFF0C\u6309\u914D\u7F6E\u7EE7\u7EED\u8FD0\u884C", { code: outcome.code });
    return { action: "continue" };
  }
  switch (outcome.label) {
    case "\u7EE7\u7EED\u4EFB\u52A1":
      log("\u7528\u6237\u9009\u62E9\uFF1A\u7EE7\u7EED\u4EFB\u52A1");
      return { action: "continue" };
    case "\u7EC8\u6B62\u4EFB\u52A1":
      agent.cancel({ kind: "hook", reason: "thinking-breaker: \u7528\u6237\u9009\u62E9\u7EC8\u6B62\u4EFB\u52A1" });
      log("\u7528\u6237\u9009\u62E9\uFF1A\u7EC8\u6B62\u4EFB\u52A1");
      return { action: "cancel" };
    default:
      log("\u7528\u6237\u9009\u62E9\uFF1A" + outcome.label, { custom: outcome.custom ?? "" });
      return { action: "steer", message: buildInstruction(outcome.label, outcome.custom) };
  }
}

// src/config.ts
var DEFAULTS = {
  loopDetect: {
    structRepeat: {
      remindAt: 3,
      askAt: 6,
      remindInterval: 3,
      include: [],
      exclude: [],
      argumentsPreviewChars: 500
    },
    stagnant: { remindAt: 5, askAt: 8 },
    exploration: {
      enabled: false,
      remindAt: 20,
      askAt: 30,
      resetAfterChars: 500,
      include: [],
      exclude: []
    }
  },
  recover: { graceSteps: 2 },
  interaction: { timeout: 300, noAnswerer: "continue" },
  storage: { type: "memory", file: ".dsh-thinking-breaker/state.jsonl" },
  log: { level: "info" }
};
function fail(path, message) {
  throw new Error(`dsh-thinking-breaker: ${path} ${message}`);
}
function section(value, path) {
  if (value === void 0 || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) fail(path, "\u5FC5\u987B\u662F\u5BF9\u8C61");
  return value;
}
function int(value, fallback, path, min) {
  if (value === void 0 || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < min) fail(path, `\u5FC5\u987B\u662F \u2265${min} \u7684\u6574\u6570\uFF08\u5F53\u524D ${String(value)}\uFF09`);
  return n;
}
function bool(value, fallback, path) {
  if (value === void 0 || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  fail(path, `\u5FC5\u987B\u662F\u5E03\u5C14\u503C\uFF08\u5F53\u524D ${String(value)}\uFF09`);
}
function oneOf(value, allowed, fallback, path) {
  if (value === void 0 || value === null || value === "") return fallback;
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail(path, `\u5FC5\u987B\u662F ${allowed.map((item) => `"${item}"`).join(" | ")} \u4E4B\u4E00\uFF08\u5F53\u524D ${String(value)}\uFF09`);
  }
  return value;
}
function stringList(value, fallback, path) {
  if (value === void 0 || value === null) return [...fallback];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(path, "\u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4");
  }
  return [...value];
}
function applyEnvOverrides(config, env = process.env) {
  const num = (key, fallback, path, min) => {
    const value = env[key];
    return value === void 0 || value === "" ? fallback : int(value, fallback, path, min);
  };
  const str = (key, fallback) => env[key] ?? fallback;
  return {
    loopDetect: {
      structRepeat: {
        ...config.loopDetect.structRepeat,
        remindAt: num("DSH_TB_STRUCT_REPEAT_REMIND_AT", config.loopDetect.structRepeat.remindAt, "loopDetect.structRepeat.remindAt", 2),
        askAt: num("DSH_TB_STRUCT_REPEAT_ASK_AT", config.loopDetect.structRepeat.askAt, "loopDetect.structRepeat.askAt", 3),
        remindInterval: num("DSH_TB_STRUCT_REPEAT_REMIND_INTERVAL", config.loopDetect.structRepeat.remindInterval, "loopDetect.structRepeat.remindInterval", 1)
      },
      stagnant: {
        remindAt: num("DSH_TB_STAGNANT_REMIND_AT", config.loopDetect.stagnant.remindAt, "loopDetect.stagnant.remindAt", 2),
        askAt: num("DSH_TB_STAGNANT_ASK_AT", config.loopDetect.stagnant.askAt, "loopDetect.stagnant.askAt", 3)
      },
      exploration: {
        ...config.loopDetect.exploration,
        enabled: bool(env.DSH_TB_EXPLORATION_ENABLED, config.loopDetect.exploration.enabled, "loopDetect.exploration.enabled"),
        remindAt: num("DSH_TB_EXPLORATION_REMIND_AT", config.loopDetect.exploration.remindAt, "loopDetect.exploration.remindAt", 2),
        askAt: num("DSH_TB_EXPLORATION_ASK_AT", config.loopDetect.exploration.askAt, "loopDetect.exploration.askAt", 3),
        resetAfterChars: num("DSH_TB_EXPLORATION_RESET_AFTER_CHARS", config.loopDetect.exploration.resetAfterChars, "loopDetect.exploration.resetAfterChars", 1)
      }
    },
    recover: {
      graceSteps: num("DSH_TB_GRACE_STEPS", config.recover.graceSteps, "recover.graceSteps", 0)
    },
    interaction: {
      timeout: num("DSH_TB_TIMEOUT", config.interaction.timeout, "interaction.timeout", 1),
      noAnswerer: oneOf(str("DSH_TB_NO_ANSWERER", config.interaction.noAnswerer), ["continue", "cancel"], config.interaction.noAnswerer, "interaction.noAnswerer")
    },
    storage: {
      type: oneOf(str("DSH_TB_STORAGE_TYPE", config.storage.type), ["memory", "jsonl"], config.storage.type, "storage.type"),
      file: str("DSH_TB_STORAGE_FILE", config.storage.file)
    },
    log: {
      level: oneOf(str("DSH_TB_LOG_LEVEL", config.log.level), ["debug", "info", "warn"], config.log.level, "log.level")
    }
  };
}
function resolveConfig(input, env = process.env) {
  const src = section(input ?? {}, "config");
  const loopDetect = section(src.loopDetect, "loopDetect");
  const structRepeat = section(loopDetect.structRepeat, "loopDetect.structRepeat");
  const stagnant = section(loopDetect.stagnant, "loopDetect.stagnant");
  const exploration = section(loopDetect.exploration, "loopDetect.exploration");
  const recover = section(src.recover, "recover");
  const interaction = section(src.interaction, "interaction");
  const storage = section(src.storage, "storage");
  const log = section(src.log, "log");
  const config = {
    loopDetect: {
      structRepeat: {
        remindAt: int(structRepeat.remindAt, DEFAULTS.loopDetect.structRepeat.remindAt, "loopDetect.structRepeat.remindAt", 2),
        askAt: int(structRepeat.askAt, DEFAULTS.loopDetect.structRepeat.askAt, "loopDetect.structRepeat.askAt", 3),
        remindInterval: int(structRepeat.remindInterval, DEFAULTS.loopDetect.structRepeat.remindInterval, "loopDetect.structRepeat.remindInterval", 1),
        include: stringList(structRepeat.include, DEFAULTS.loopDetect.structRepeat.include, "loopDetect.structRepeat.include"),
        exclude: stringList(structRepeat.exclude, DEFAULTS.loopDetect.structRepeat.exclude, "loopDetect.structRepeat.exclude"),
        argumentsPreviewChars: int(structRepeat.argumentsPreviewChars, DEFAULTS.loopDetect.structRepeat.argumentsPreviewChars, "loopDetect.structRepeat.argumentsPreviewChars", 1)
      },
      stagnant: {
        remindAt: int(stagnant.remindAt, DEFAULTS.loopDetect.stagnant.remindAt, "loopDetect.stagnant.remindAt", 2),
        askAt: int(stagnant.askAt, DEFAULTS.loopDetect.stagnant.askAt, "loopDetect.stagnant.askAt", 3)
      },
      exploration: {
        enabled: bool(exploration.enabled, DEFAULTS.loopDetect.exploration.enabled, "loopDetect.exploration.enabled"),
        remindAt: int(exploration.remindAt, DEFAULTS.loopDetect.exploration.remindAt, "loopDetect.exploration.remindAt", 2),
        askAt: int(exploration.askAt, DEFAULTS.loopDetect.exploration.askAt, "loopDetect.exploration.askAt", 3),
        resetAfterChars: int(exploration.resetAfterChars, DEFAULTS.loopDetect.exploration.resetAfterChars, "loopDetect.exploration.resetAfterChars", 1),
        include: stringList(exploration.include, DEFAULTS.loopDetect.exploration.include, "loopDetect.exploration.include"),
        exclude: stringList(exploration.exclude, DEFAULTS.loopDetect.exploration.exclude, "loopDetect.exploration.exclude")
      }
    },
    recover: {
      graceSteps: int(recover.graceSteps, DEFAULTS.recover.graceSteps, "recover.graceSteps", 0)
    },
    interaction: {
      timeout: int(interaction.timeout, DEFAULTS.interaction.timeout, "interaction.timeout", 1),
      noAnswerer: oneOf(interaction.noAnswerer, ["continue", "cancel"], DEFAULTS.interaction.noAnswerer, "interaction.noAnswerer")
    },
    storage: {
      type: oneOf(storage.type, ["memory", "jsonl"], DEFAULTS.storage.type, "storage.type"),
      file: typeof storage.file === "string" && storage.file !== "" ? storage.file : DEFAULTS.storage.file
    },
    log: {
      level: oneOf(log.level, ["debug", "info", "warn"], DEFAULTS.log.level, "log.level")
    }
  };
  return applyEnvOverrides(config, env);
}

// src/index.ts
var name = "thinking-breaker";
var inject = ["agents", "userQuestions"];
var LEVEL_RANK = { debug: 3, info: 2, warn: 1 };
function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  assertConfigPair(name, "loopDetect.structRepeat", config.loopDetect.structRepeat.remindAt, config.loopDetect.structRepeat.askAt);
  assertConfigPair(name, "loopDetect.stagnant", config.loopDetect.stagnant.remindAt, config.loopDetect.stagnant.askAt);
  if (config.loopDetect.exploration.enabled) {
    assertConfigPair(name, "loopDetect.exploration", config.loopDetect.exploration.remindAt, config.loopDetect.exploration.askAt);
  }
  const logger = ctx.logger("thinking-breaker");
  const log = (message, fields, type = "info") => {
    if (LEVEL_RANK[type] <= LEVEL_RANK[config.log.level]) {
      logger[type]("%s %j", message, fields ?? {});
    }
  };
  const detectors = [
    new StructRepeatDetector({
      remindAt: config.loopDetect.structRepeat.remindAt,
      askAt: config.loopDetect.structRepeat.askAt,
      remindInterval: config.loopDetect.structRepeat.remindInterval,
      include: config.loopDetect.structRepeat.include,
      exclude: config.loopDetect.structRepeat.exclude
    }),
    new StagnationDetector({
      remindAt: config.loopDetect.stagnant.remindAt,
      askAt: config.loopDetect.stagnant.askAt
    }),
    ...config.loopDetect.exploration.enabled ? [new ExplorationDetector({
      remindAt: config.loopDetect.exploration.remindAt,
      askAt: config.loopDetect.exploration.askAt,
      resetAfterChars: config.loopDetect.exploration.resetAfterChars,
      include: config.loopDetect.exploration.include,
      exclude: config.loopDetect.exploration.exclude
    })] : []
  ];
  const persister = config.storage.type === "jsonl" ? new JsonlPersister(config.storage.file) : new MemoryPersister();
  const breaker = new Breaker(detectors, {
    graceSteps: config.recover.graceSteps,
    argumentsPreviewChars: config.loopDetect.structRepeat.argumentsPreviewChars,
    maxRecentCalls: 5
  }, persister);
  ctx.on("thinking-breaker/detector", (detector) => {
    breaker.register(detector);
    log("\u6CE8\u518C\u81EA\u5B9A\u4E49\u68C0\u6D4B\u5668", { kind: detector.kind }, "debug");
  });
  async function intervene(agent, hit, signal) {
    breaker.save(agent);
    const summary = breaker.buildSummary(hit, agent);
    const outcome = await askUser(ctx, agent, summary, config.interaction.timeout, signal);
    const result = resolveOutcome(agent, outcome, config.interaction.noAnswerer, log);
    if (result.action === "steer" || result.action === "continue") {
      breaker.markRecovering(agent);
    }
    return result;
  }
  ctx.on("tools/post-execute", async (exec, _result, next) => {
    const downstream = await next();
    if (!exec.agent || downstream.kind === "block") return downstream;
    const hit = breaker.observeTool(exec.agent, exec.name, exec.arguments);
    if (!hit) return downstream;
    if (!hit.ask) {
      log("\u6CE8\u5165\u5FAA\u73AF\u63D0\u9192", { kind: hit.kind, count: hit.count, tool: exec.name, session: String(exec.agent.session.id) });
      const reminder = buildReminder(hit);
      return { ...downstream, additionalContexts: [reminder, ...downstream.additionalContexts ?? []] };
    }
    log("\u5347\u7EA7\uFF1A\u6682\u505C\u5E76\u95EE\u4EBA", { kind: hit.kind, count: hit.count, tool: exec.name, session: String(exec.agent.session.id) });
    const result = await intervene(exec.agent, hit, exec.signal);
    if (result.action === "steer" && result.message) exec.agent.steer(result.message);
    return downstream;
  });
  ctx.on("agent/pre-step", async (payload, next) => {
    const downstream = await next();
    if (downstream.kind !== "enter") return downstream;
    const { agent, messages, turn, step, signal } = payload;
    const hasUserMessage = messages.some((message) => message.source.kind === "user");
    const hit = await breaker.prepareStep(agent, hasUserMessage, turn, step);
    if (!hit) return downstream;
    if (!hit.ask) {
      log("\u6CE8\u5165\u505C\u6EDE/\u5FAA\u73AF\u63D0\u9192\uFF08pre-step\uFF09", { kind: hit.kind, count: hit.count, session: String(agent.session.id) });
      const reminder = buildReminder(hit);
      return { ...downstream, messages: [...downstream.messages, reminder] };
    }
    log("\u5347\u7EA7\uFF1A\u6682\u505C\u5E76\u95EE\u4EBA\uFF08pre-step\uFF09", { kind: hit.kind, count: hit.count, session: String(agent.session.id) });
    const result = await intervene(agent, hit, signal);
    if (result.action === "steer" && result.message) {
      return { ...downstream, messages: [...downstream.messages, result.message] };
    }
    return downstream;
  });
  ctx.on("session/event", (session, event) => {
    const agent = ctx.agents.get(session.id);
    if (!agent) return;
    if (event.type === "assistant/message") {
      if (event.data.interrupted) return;
      breaker.observeAssistantText(agent, extractText(event.data.message.content));
    } else if (event.type === "turn/end") {
      breaker.save(agent);
    }
  });
}
export {
  apply,
  inject,
  name
};
