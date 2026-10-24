import { readFileSync, writeFileSync } from "node:fs";

const source = readFileSync("lib/client.js", "utf8");

/** 从源码里按大括号配对切出 `const zh = { ... }` 的字典文本。 */
function extractDict(marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error("找不到 " + marker);
  const open = source.indexOf("{", start);
  let depth = 0;
  let index = open;
  for (; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '"') {
      // 跳过字符串字面量，避免里面的括号干扰配对。
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") { index += 2; continue; }
        if (source[index] === '"') break;
        index += 1;
      }
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(open, index + 1);
}

for (const [lang, marker] of [["zh", "const zh = {"], ["en", "const en = {"]]) {
  const dict = Function("return (" + extractDict(marker) + ");")();
  const keys = Object.keys(dict).sort();
  writeFileSync("locale/" + lang + ".json", JSON.stringify(dict, null, 2) + "\n", "utf8");
  console.log(lang + ": " + keys.length + " keys");
}
