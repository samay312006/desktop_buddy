// Curated speech packs per personality, lightly project-aware via the title of
// the foreground window (detects language + app). Structured so a Claude-API
// generator can later replace `pickLine` without touching the rest of the app.

export interface SpeechContext {
  app: string | null;
  lang: string | null;
}

const EXT_LANG: Record<string, string> = {
  rs: "Rust",
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  py: "Python",
  go: "Go",
  java: "Java",
  rb: "Ruby",
  c: "C",
  h: "C",
  cpp: "C++",
  cs: "C#",
  php: "PHP",
  swift: "Swift",
  kt: "Kotlin",
  html: "HTML",
  css: "CSS",
  sql: "SQL",
};

/** Parse the foreground window title into a rough app + language context. */
export function detectContext(title: string | undefined | null): SpeechContext {
  if (!title) return { app: null, lang: null };
  const t = title.toLowerCase();

  let app: string | null = null;
  if (t.includes("visual studio code") || /\bcode\b/.test(t)) app = "VS Code";
  else if (t.includes("intellij") || t.includes("pycharm") || t.includes("webstorm")) app = "JetBrains";
  else if (t.includes("chrome") || t.includes("firefox") || t.includes("edge") || t.includes("brave")) app = "browser";
  else if (t.includes("terminal") || t.includes("powershell") || t.includes("cmd")) app = "terminal";

  let lang: string | null = null;
  const m = t.match(/\.([a-z0-9]+)\b/);
  if (m && EXT_LANG[m[1]]) lang = EXT_LANG[m[1]];

  return { app, lang };
}

const CODER_GENERIC = [
  "Name things like a tired future-you has to read it. 🧠",
  "Small functions beat clever functions.",
  "Commit early, commit often. 💾",
  "Have you written a test for that yet? 🧪",
  "Delete that commented-out code. You won't need it.",
  "Magic numbers want names too.",
];
const CODER_LANG: Record<string, string[]> = {
  Rust: ["`?` beats `.unwrap()` in real code. 🦀", "Run clippy — it's smarter than both of us."],
  TypeScript: ["`as any` is a promise you'll regret. 🚧", "Prefer `unknown` over `any`."],
  JavaScript: ["`===`, never `==`.", "`const` first, `let` only when you must."],
  Python: ["List comprehensions > manual loops. 🐍", "f-strings beat .format()."],
  Go: ["Handle that err, don't `_` it away.", "A little copying beats a little dependency."],
};
const CODER_APP: Record<string, string[]> = {
  "VS Code": ["Ctrl+D selects the next match. ✨", "Ctrl+Shift+P does almost everything.", "Alt+↑/↓ moves a line."],
  browser: ["Close 30 of those 47 tabs. 🗂️", "DevTools: Ctrl+Shift+J."],
  terminal: ["`Ctrl+R` searches your shell history. 🔍"],
};

const ROASTER_GENERIC = [
  "'fix stuff' — inspired commit message. 🙄",
  "Your indentation is a cry for help.",
  "More nested ifs than a wedding seating chart.",
  "git blame says it's you. It's always you.",
  "Still no tests? Living dangerously. 🔥",
  "That variable name? `data2`? Bold.",
];
const ROASTER_LANG: Record<string, string[]> = {
  Rust: ["Fighting the borrow checker again? It's winning. 🦀"],
  TypeScript: ["`// @ts-ignore` — peak confidence.", "Any% speedrun of the type system, huh."],
  Python: ["Indentation error incoming. I can feel it."],
};
const ROASTER_APP: Record<string, string[]> = {
  browser: ["Stack Overflow open again? Groundbreaking.", "Copy-pasting answers we don't read, classic."],
  "VS Code": ["47 unsaved tabs. A monument to focus."],
};

const LOVE_GENERIC = [
  "Have you texted them back yet? 💕",
  "Confidence is the best framework. 💖",
  "Take a break. Drink water. Text your crush.",
  "You deserve someone who debugs with you. 🥰",
  "Stop overthinking that message — just send it. 💌",
  "Self-care compiles too, you know.",
];

const THIEF_GENERIC = [
  "mine now 😼",
  "I'll just... borrow this. 🫳",
  "ooh, shiny window 🪟",
  "you weren't using this, right?",
  "404: your window moved. 😹",
  "finders keepers~",
];

function pool(personality: string, ctx: SpeechContext): string[] {
  switch (personality) {
    case "coder": {
      const p = [...CODER_GENERIC];
      if (ctx.lang && CODER_LANG[ctx.lang]) p.push(...CODER_LANG[ctx.lang], ...CODER_LANG[ctx.lang]);
      if (ctx.app && CODER_APP[ctx.app]) p.push(...CODER_APP[ctx.app]);
      return p;
    }
    case "roaster": {
      const p = [...ROASTER_GENERIC];
      if (ctx.lang && ROASTER_LANG[ctx.lang]) p.push(...ROASTER_LANG[ctx.lang], ...ROASTER_LANG[ctx.lang]);
      if (ctx.app && ROASTER_APP[ctx.app]) p.push(...ROASTER_APP[ctx.app]);
      return p;
    }
    case "love":
      return LOVE_GENERIC;
    case "thief":
      return THIEF_GENERIC;
    default:
      return [];
  }
}

/** Pick a line for a personality, biased toward the current project context. */
export function pickLine(personality: string, ctx: SpeechContext): string | null {
  const p = pool(personality, ctx);
  if (p.length === 0) return null;
  return p[Math.floor(Math.random() * p.length)];
}
